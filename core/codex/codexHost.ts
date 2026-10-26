import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import type { PermissionMode, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { getCodexServer, registerThread, stopCodexServer, type CodexServer } from './appServer'
import { RpcError } from './rpc'
import { CodexEventMapper } from './mapEvents'
import { helperPolicy, reviewPolicy, sessionPolicy, type CodexPolicy } from './policy'
import { codexSessionContract, codexUltracodePrompt } from './prompts'
import { toCodexEffort } from '../agent/codexAgent'
import { codexUltracodeEffort, getCodexModels } from '../agent/codexModels'
import { shouldBlockCodexCommand } from '../agent/commandGuard'
import { usageFromCodexTurn } from '../agent/usage'
import { answerPending, insertPromptRow, resolvePromptRow, type PendingPrompt } from '../host/permissions'
import { makeRunEmitter, setRunStatus } from '../host/recorder'
import { setRunSession } from '../runs/store'
import type { PromptAnswer, RunEvent, RunSpec, SessionHost, TurnCallbacks, TurnResult } from '../host/types'
import type { ThreadStartParams } from './protocol/v2/ThreadStartParams'
import type { TurnStartParams } from './protocol/v2/TurnStartParams'

// The Codex session host: one app-server thread per live run, multiplexed on the single `codex app-server` process
// (core/codex/appServer.ts). Same surface as the Claude host — ensure / send / interrupt / prompts / mode — so the
// pipelines, the /api/runs endpoints and the UI cards do not care which provider is behind a run.
//
// Approvals (`item/*/requestApproval`) and `item/tool/requestUserInput` travel through the shared permission bridge
// (core/host/permissions.ts): a pending permission_requests row + a permission_request event, answered over HTTP.
// Unattended kinds (review / helper) answer them themselves with the policy's decider, before the command runs.

const IDLE_MS = Number(process.env.HOST_IDLE_MS || 20 * 60_000)
const PROMPT_TTL_MS = Number(process.env.HOST_PROMPT_TTL_MS || 12 * 60 * 60_000)
const THREAD_START_TIMEOUT_MS = 90_000

type LiveTurn = {
  turnId: string | null
  codexTurnId: string | null
  cb: TurnCallbacks
  text: string
  resolve: (r: TurnResult) => void
  interrupted: boolean
  startedAt: number
  error: string | null
}

type PromptMeta = { rpcId: number | string; method: string; questionIds?: Record<string, string> }

type LiveThread = {
  spec: RunSpec
  threadId: string
  server: CodexServer
  unregister: () => void
  policy: CodexPolicy
  mapper: CodexEventMapper
  model: string
  skills: Array<{ name: string; path: string }> // Codex skills for this cwd (the palette lists them; `/name args` becomes a skill input item)
  busy: boolean
  turn: LiveTurn | null
  prompts: Map<string, PendingPrompt>
  promptMeta: Map<string, PromptMeta>
  promptTimers: Map<string, ReturnType<typeof setTimeout>>
  idleTimer: ReturnType<typeof setTimeout> | null
  closed: boolean
  lastUsedAt: number
  init: Extract<RunEvent, { t: 'init' }> | null
  emit: (e: RunEvent) => void
}

function policyFor(spec: RunSpec): CodexPolicy {
  if (spec.kind === 'review') return reviewPolicy({ allowNetwork: !!spec.allowNetwork })
  if (spec.kind === 'helper') return helperPolicy()
  return sessionPolicy({ cwd: spec.cwd, permissionMode: spec.permissionMode, allowDanger: spec.allowDanger })
}

function developerInstructions(spec: RunSpec): string {
  const parts = [spec.systemAppend ?? '']
  if (spec.guardScope) parts.push(codexSessionContract(spec.guardScope))
  if (spec.ultracode && spec.guardScope) parts.push(codexUltracodePrompt(spec.guardScope))
  return parts.filter((s) => s.trim()).join('\n\n')
}

async function effortFor(spec: RunSpec): Promise<string | undefined> {
  if (spec.ultracode) return codexUltracodeEffort(await getCodexModels().catch(() => []), spec.model)
  return toCodexEffort(spec.effort)
}

function summarizeInput(input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  const v = i.command ?? i.file_path ?? i.path ?? i.query ?? i.description ?? ''
  return String(v).slice(0, 100)
}

class CodexHost implements SessionHost {
  private runs = new Map<string, LiveThread>()

  async ensure(spec: RunSpec): Promise<LiveThread> {
    const cur = this.runs.get(spec.runId)
    if (cur && !cur.closed) {
      const sameSession = !spec.resume || spec.resume === cur.threadId
      // cwd and the developer instructions are fixed at thread start; a change resumes the same thread with new settings.
      const sameShape = cur.spec.cwd === spec.cwd && developerInstructions(cur.spec) === developerInstructions(spec)
      if (sameSession && sameShape && !cur.busy) {
        cur.spec = { ...cur.spec, ...spec, resume: cur.spec.resume, allowDanger: spec.allowDanger ?? cur.spec.allowDanger }
        if (spec.model) cur.model = spec.model
        if (spec.permissionMode && spec.permissionMode !== cur.init?.permissionMode) await this.setMode(spec.runId, spec.permissionMode)
        this.armIdle(cur)
        return cur
      }
      if (cur.busy) throw new Error('a turn is already running')
      await this.close(spec.runId, sameSession ? 'restart with new cwd/instructions' : 'restart with different thread')
      if (sameSession) spec = { ...spec, resume: cur.threadId }
    }
    return this.create(spec)
  }

  private async create(spec: RunSpec): Promise<LiveThread> {
    const server = await getCodexServer()
    const policy = policyFor(spec)
    const unattended = spec.kind === 'review' || spec.kind === 'helper' // read-only kinds never connect MCP
    const effort = await effortFor(spec)
    const instructions = developerInstructions(spec)
    const base: Partial<ThreadStartParams> = {
      cwd: spec.cwd,
      ...(spec.model ? { model: spec.model } : {}),
      ...(spec.codexServiceTier ? { serviceTier: spec.codexServiceTier } : {}),
      approvalPolicy: policy.approval,
      sandbox: policy.sandboxMode,
      ...(effort || unattended ? { config: { ...(effort ? { model_reasoning_effort: effort } : {}), ...(unattended ? { mcp_servers: {} } : {}) } } : {}),
      ...(instructions ? { developerInstructions: instructions } : {}),
    }
    const notes: string[] = []
    let resp: any = null
    if (spec.resume) {
      try {
        resp = spec.fork
          ? await server.rpc.request('thread/fork', { threadId: spec.resume, ...base }, THREAD_START_TIMEOUT_MS)
          : await server.rpc.request('thread/resume', { threadId: spec.resume, ...base }, THREAD_START_TIMEOUT_MS)
      } catch (e) {
        // A stale / foreign thread id (rollout gone, other codex home): start fresh instead of failing the turn.
        notes.push(`saved Codex thread ${spec.resume} could not be resumed (${(e as Error).message.slice(0, 200)}); started a fresh thread`)
      }
    }
    if (!resp) resp = await server.rpc.request('thread/start', { ...base, ephemeral: policy.ephemeral || spec.kind === 'probe' }, THREAD_START_TIMEOUT_MS)
    const threadId = String(resp?.thread?.id ?? '')
    if (!threadId) throw new Error('codex thread/start returned no thread id')

    const live: LiveThread = {
      spec, threadId, server, unregister: () => {}, policy, mapper: new CodexEventMapper(), model: String(resp?.model ?? spec.model ?? ''), skills: [],
      busy: false, turn: null, prompts: new Map(), promptMeta: new Map(), promptTimers: new Map(), idleTimer: null, closed: false, lastUsedAt: Date.now(), init: null,
      emit: () => {},
    }
    const emitRaw = makeRunEmitter({ runId: spec.runId, db: spec.db, schema: spec.schema, turnId: () => live.turn?.turnId ?? null })
    live.emit = (e) => { emitRaw(e); try { live.turn?.cb.onEvent?.(e) } catch { /* ignore */ } }
    live.unregister = registerThread(threadId, {
      notification: (method, params) => this.onNotification(live, method, params),
      serverRequest: (id, method, params) => this.onServerRequest(live, id, method, params),
      crashed: (reason) => this.onCrash(live, reason),
    })
    this.runs.set(spec.runId, live)

    // Skills palette: what Codex would load for this cwd (best effort; the thread works without it).
    live.skills = spec.kind === 'session'
      ? await server.rpc.request('skills/list', { cwds: [spec.cwd] }, 10_000).then((r: any) => (r?.data ?? []).flatMap((e: any) => (e.skills ?? []).filter((s: any) => s.enabled !== false).map((s: any) => ({ name: String(s.name), path: String(s.path ?? '') })))).catch(() => [])
      : []
    const skills = live.skills.map((s) => s.name)
    live.init = {
      t: 'init', sessionId: threadId, model: live.model, permissionMode: spec.permissionMode ?? 'default',
      slashCommands: ['/compact'], skills, mcpServers: [], tools: [], claudeCodeVersion: `codex ${server.version ?? '?'}`,
    }
    if (spec.db && spec.schema) {
      setRunSession(spec.db, spec.schema, spec.runId, 'codex', threadId)
      setRunStatus(spec.db, spec.schema, spec.runId, 'idle', { permissionMode: live.init.permissionMode })
    }
    live.emit(live.init)
    for (const n of notes) live.emit({ t: 'note', text: n })
    this.armIdle(live)
    return live
  }

  // ── notifications ──
  private onNotification(live: LiveThread, method: string, params: any): void {
    if (live.closed) return
    if (method === 'serverRequest/resolved') {
      // Answered elsewhere (another client on the same app-server) → drop our card without responding again.
      for (const [pid, meta] of live.promptMeta) {
        if (String(meta.rpcId) !== String(params.requestId)) continue
        const p = live.prompts.get(pid)
        if (p) { live.prompts.delete(pid); resolvePromptRow(this.store(live), pid, 'cancelled'); live.emit({ t: 'permission_resolved', promptId: pid, status: 'cancelled' }) }
        this.settlePrompt(live, pid)
      }
      return
    }
    const { events, turnEnd, command, turnStarted } = live.mapper.map(method, params)
    if (turnStarted && live.turn && !live.turn.codexTurnId) live.turn.codexTurnId = turnStarted
    for (const e of events) this.dispatch(live, e)
    if (command) this.afterCommand(live, command)
    if (turnEnd) this.onTurnEnd(live, turnEnd)
  }

  private dispatch(live: LiveThread, e: RunEvent): void {
    // Read-only kinds: an MCP tool call is a policy breach the approval flow never sees → fail the turn before it goes further.
    if (e.t === 'tool_use' && e.name.startsWith('mcp__') && live.policy.autoDecide && live.turn) {
      const message = `MCP server "${e.name.split('__')[1] ?? ''}" is not allowed in a read-only run (tool ${e.name})`
      live.turn.error = message
      live.emit({ t: 'permission_denied', toolName: e.name, message })
      void this.rpcInterrupt(live)
    }
    switch (e.t) {
      case 'text_delta':
        try { live.turn?.cb.onText?.(e.text) } catch { /* ignore */ }
        break
      case 'assistant_text':
        if (live.turn) live.turn.text += (live.turn.text ? '\n\n' : '') + e.text
        break
      case 'tool_use':
        try { live.turn?.cb.onTool?.(e.name, summarizeInput(e.input)) } catch { /* ignore */ }
        break
      case 'status':
        if (e.status === 'waiting_prompt' && !live.prompts.size) return // the flag is ours to announce once a card exists
        break
      default:
        break
    }
    live.emit(e)
  }

  // Post-execution guard for session kinds: Codex only asks before sandbox-denied actions, so an in-sandbox
  // `git commit` / `gh` write has to be caught after the fact (same contract as the old runner, but now the turn is
  // interrupted instead of the stream abandoned).
  private afterCommand(live: LiveThread, cmd: { id: string; command: string; exitCode: number | null; status: string }): void {
    const scope = live.spec.guardScope
    if (!scope || !live.turn || cmd.status === 'declined') return
    if (!shouldBlockCodexCommand(cmd.command, { scope, allowDanger: !!live.spec.allowDanger })) return
    const message = `Codex attempted a forbidden git/GitHub mutation: ${cmd.command.slice(0, 200)}`
    live.turn.error = message
    live.emit({ t: 'permission_denied', toolName: 'Bash', message })
    void this.rpcInterrupt(live)
  }

  private async rpcInterrupt(live: LiveThread): Promise<void> {
    if (!live.turn?.codexTurnId) return
    try { await live.server.rpc.request('turn/interrupt', { threadId: live.threadId, turnId: live.turn.codexTurnId }, 5_000) } catch { /* the turn may already be over */ }
  }

  private onTurnEnd(live: LiveThread, end: { status: string; error: string | null; turnId: string; finalText: string; allText: string }): void {
    const t = live.turn
    if (!t) return
    if (t.codexTurnId && end.turnId && t.codexTurnId !== end.turnId) return // not ours (e.g. a compaction turn)
    // Per-turn usage = the sum of the `last` breakdowns this turn produced (robust across resumes, where the thread total already carries history).
    const delta = live.mapper.turnUsage
    const usage = delta
      ? usageFromCodexTurn({ input_tokens: delta.inputTokens, cached_input_tokens: delta.cachedInputTokens, cache_write_input_tokens: delta.cacheWriteInputTokens, output_tokens: delta.outputTokens, reasoning_output_tokens: delta.reasoningOutputTokens }, live.model, { threadId: live.threadId, durationMs: Date.now() - t.startedAt })
      : null
    const error = t.error ?? end.error
    const isError = end.status === 'failed' || !!t.error
    // A guard-triggered interrupt is an error, not a user stop.
    const interrupted = !isError && (end.status === 'interrupted' || t.interrupted)
    const oneShot = live.spec.kind === 'review' || live.spec.kind === 'helper'
    const text = oneShot ? end.finalText : (end.allText || t.text)
    const subtype = isError ? 'error_during_execution' : interrupted ? 'interrupted' : 'success'
    live.emit({ t: 'turn_done', subtype, isError, resultText: text || error || '', costUsd: usage?.costUsd ?? null, durationMs: Date.now() - t.startedAt, numTurns: 1, usage })
    this.finishTurn(live, { text, sessionId: live.threadId, usage, costUsd: usage?.costUsd ?? null, subtype, isError, interrupted, ...(error ? { error } : {}) })
  }

  private finishTurn(live: LiveThread, r: TurnResult): void {
    const t = live.turn
    live.busy = false
    live.turn = null
    live.lastUsedAt = Date.now()
    if (t) t.resolve(r)
    if (!live.closed) {
      live.emit({ t: 'status', status: 'idle' })
      setRunStatus(live.spec.db, live.spec.schema, live.spec.runId, r.isError && !r.interrupted ? 'error' : r.interrupted ? 'stopped' : 'idle', r.error ? { error: r.error } : { error: null })
      this.armIdle(live)
    }
  }

  private onCrash(live: LiveThread, reason: string): void {
    if (live.closed) return
    live.emit({ t: 'error', message: reason })
    live.closed = true
    this.cancelPrompts(live, 'app-server exited')
    if (live.turn) this.finishTurn(live, { text: live.turn.text, sessionId: live.threadId, usage: null, costUsd: null, subtype: 'error_during_execution', isError: true, interrupted: false, error: reason })
    this.teardown(live)
  }

  // ── server → client requests (approvals, user input) ──
  private store(live: LiveThread) { return { db: live.spec.db, schema: live.spec.schema } }

  private onServerRequest(live: LiveThread, id: number | string, method: string, params: any): void {
    const rpc = live.server.rpc
    if (live.closed) { rpc.respondError(id, -32000, 'session closed'); return }
    const auto = live.policy.autoDecide
    const legacy = method === 'execCommandApproval' || method === 'applyPatchApproval'
    const accept = (forSession: boolean) => (legacy ? (forSession ? 'approved_for_session' : 'approved') : forSession ? 'acceptForSession' : 'accept')
    const decline = legacy ? 'denied' : 'decline'

    if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
      const command = Array.isArray(params.command) ? params.command.map(String).join(' ') : typeof params.command === 'string' ? params.command : ''
      if (!command && auto) { rpc.respond(id, { decision: decline }); live.emit({ t: 'permission_denied', toolName: 'Bash', message: 'declined: approval request without a readable command' }); return }
      if (auto) {
        const d = auto(command)
        rpc.respond(id, { decision: d === 'accept' ? accept(false) : decline })
        if (d === 'decline') live.emit({ t: 'permission_denied', toolName: 'Bash', message: `declined before execution by the read-only policy: ${command.slice(0, 200)}` })
        return
      }
      const amendment = Array.isArray(params.proposedExecpolicyAmendment) ? params.proposedExecpolicyAmendment as string[] : null
      this.park(live, id, method, 'tool', 'Bash', { command, cwd: params.cwd ?? undefined, ...(params.reason ? { description: String(params.reason) } : {}) }, amendment ? { amendment } : {}, (r) => {
        if (r.behavior !== 'allow') return { decision: decline }
        const forSession = r.decisionClassification === 'user_permanent'
        if (forSession && amendment && !legacy) return { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment } } }
        return { decision: accept(forSession) }
      }, params.reason ? String(params.reason) : undefined)
      return
    }

    if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
      const fromReq = (Array.isArray(params.fileChanges) ? params.fileChanges : Array.isArray(params.changes) ? params.changes : []).map((c: any) => String(c?.path ?? '')).filter(Boolean)
      const paths = (live.mapper.pathsOf(String(params.itemId ?? '')).length ? live.mapper.pathsOf(String(params.itemId ?? '')) : fromReq).join(', ')
      if (auto) { rpc.respond(id, { decision: decline }); live.emit({ t: 'permission_denied', toolName: 'ApplyPatch', message: `file change declined by the read-only policy: ${paths}` }); return }
      const mode = live.spec.permissionMode ?? 'default'
      if (mode === 'acceptEdits' || mode === 'bypassPermissions') { rpc.respond(id, { decision: accept(false) }); return }
      this.park(live, id, method, 'tool', 'ApplyPatch', { file_path: paths, ...(params.reason ? { description: String(params.reason) } : {}) }, {}, (r) => ({ decision: r.behavior === 'allow' ? accept(r.decisionClassification === 'user_permanent') : decline }), params.reason ? String(params.reason) : undefined)
      return
    }

    if (method === 'item/permissions/requestApproval') {
      if (auto) { rpc.respond(id, { permissions: {}, scope: 'turn' }); live.emit({ t: 'permission_denied', toolName: 'Permissions', message: 'extra permissions declined by the read-only policy' }); return }
      const requested = params.permissions ?? {}
      const granted = { ...(requested.network ? { network: requested.network } : {}), ...(requested.fileSystem ? { fileSystem: requested.fileSystem } : {}) }
      this.park(live, id, method, 'tool', 'Permissions', { description: String(params.reason ?? 'The agent asks for extra permissions'), permissions: requested, cwd: params.cwd ?? undefined }, {}, (r) => (r.behavior === 'allow' ? { permissions: granted, scope: r.decisionClassification === 'user_permanent' ? 'session' : 'turn' } : { permissions: {}, scope: 'turn' }), params.reason ? String(params.reason) : undefined)
      return
    }

    if (method === 'item/tool/requestUserInput') {
      const qs: any[] = Array.isArray(params.questions) ? params.questions : []
      if (auto || !qs.length) { rpc.respond(id, { answers: {} }); return }
      const questionIds: Record<string, string> = {}
      const questions = qs.map((q) => {
        questionIds[String(q.question)] = String(q.id)
        return { question: String(q.question), header: String(q.header ?? ''), options: Array.isArray(q.options) ? q.options.map((o: any) => ({ label: String(o.label), description: String(o.description ?? '') })) : [], multiSelect: false }
      })
      this.park(live, id, method, 'question', 'AskUserQuestion', { questions }, { questionIds }, (r) => {
        const answers: Record<string, { answers: string[] }> = {}
        const given = r.behavior === 'allow' ? ((r.updatedInput as any)?.answers ?? {}) as Record<string, string> : {}
        for (const [text, qid] of Object.entries(questionIds)) answers[qid] = { answers: given[text] ? [given[text]!] : [] }
        return { answers }
      })
      return
    }

    if (method === 'mcpServer/elicitation/request') {
      rpc.respond(id, { action: 'decline', content: null, _meta: null })
      live.emit({ t: 'note', text: `MCP server ${String(params.serverName ?? '?')} asked for input (elicitation) — not supported here, declined` })
      return
    }

    rpc.respondError(id, -32601, `unsupported request ${method}`)
  }

  // Persist + announce a prompt and park the JSON-RPC id until the UI answers (or the TTL / a close cancels it).
  private park(live: LiveThread, rpcId: number | string, method: string, kind: PendingPrompt['kind'], toolName: string, input: Record<string, unknown>, meta: { amendment?: string[]; questionIds?: Record<string, string> }, toResponse: (r: PermissionResult) => unknown, description?: string): void {
    const id = nanoid()
    const p: PendingPrompt = { id, runId: live.spec.runId, kind, toolName, input, suggestions: meta.amendment ? ([{ execpolicy_amendment: meta.amendment }] as any) : undefined, resolve: () => {}, createdAt: Date.now() }
    p.resolve = (r) => {
      if (!live.prompts.has(id)) return
      live.prompts.delete(id)
      this.settlePrompt(live, id)
      live.server.rpc.respond(rpcId, toResponse(r))
      if (!live.prompts.size) { live.emit({ t: 'status', status: 'busy' }); setRunStatus(live.spec.db, live.spec.schema, live.spec.runId, 'running') }
    }
    live.prompts.set(id, p)
    live.promptMeta.set(id, { rpcId, method, questionIds: meta.questionIds })
    insertPromptRow(this.store(live), p, { turnId: live.turn?.turnId ?? null, description })
    live.emit({ t: 'permission_request', promptId: id, kind, toolName, input, description, suggestions: p.suggestions })
    live.emit({ t: 'status', status: 'waiting_prompt' })
    setRunStatus(live.spec.db, live.spec.schema, live.spec.runId, 'awaiting_input')
    const timer = setTimeout(() => {
      if (!live.prompts.has(id)) return
      resolvePromptRow(this.store(live), id, 'expired')
      live.emit({ t: 'permission_resolved', promptId: id, status: 'expired' })
      p.resolve({ behavior: 'deny', message: 'No answer within the prompt time limit (PR Cockpit)', interrupt: false })
    }, PROMPT_TTL_MS)
    timer.unref?.()
    live.promptTimers.set(id, timer)
  }

  private settlePrompt(live: LiveThread, id: string): void {
    const t = live.promptTimers.get(id)
    if (t) clearTimeout(t)
    live.promptTimers.delete(id)
    live.promptMeta.delete(id)
  }

  private cancelPrompts(live: LiveThread, why: string): void {
    for (const p of [...live.prompts.values()]) {
      resolvePromptRow(this.store(live), p.id, 'cancelled')
      live.emit({ t: 'permission_resolved', promptId: p.id, status: 'cancelled' })
      p.resolve({ behavior: 'deny', message: why, interrupt: false })
    }
    live.prompts.clear()
  }

  // ── turns ──
  send(runId: string, text: string, cb: TurnCallbacks & { turnId?: string | null } = {}): Promise<TurnResult> {
    const live = this.runs.get(runId)
    if (!live || live.closed) return Promise.reject(new Error('run is not live'))
    if (live.busy) return Promise.reject(new Error('a turn is already running'))
    live.busy = true
    live.lastUsedAt = Date.now()
    if (live.idleTimer) clearTimeout(live.idleTimer)
    setRunStatus(live.spec.db, live.spec.schema, runId, 'running')
    live.emit({ t: 'status', status: 'busy' })
    try { cb.onSessionId?.(live.threadId) } catch { /* ignore */ }
    return new Promise<TurnResult>((resolve) => {
      live.turn = { turnId: cb.turnId ?? null, codexTurnId: null, cb, text: '', resolve, interrupted: false, startedAt: Date.now(), error: null }
      live.mapper.resetTurn()
      void this.startTurn(live, text)
    })
  }

  private async startTurn(live: LiveThread, text: string): Promise<void> {
    const rpc = live.server.rpc
    try {
      if (text.trim() === '/compact') {
        await rpc.request('thread/compact/start', { threadId: live.threadId })
        const msg = 'Compaction requested for this Codex thread.'
        live.emit({ t: 'local_command', content: msg })
        this.finishTurn(live, { text: msg, sessionId: live.threadId, usage: null, costUsd: null, subtype: 'success', isError: false, interrupted: false })
        return
      }
      // Sandbox / approvals follow the CURRENT mode and danger switch (both can change between turns).
      live.policy = policyFor(live.spec)
      const effort = await effortFor(live.spec)
      // `/skill args` → the app-server's skill input item (Codex has no slash commands of its own).
      const m = /^\/(\S+)\s*([\s\S]*)$/.exec(text)
      const skill = m ? live.skills.find((s) => s.name === m[1]) : undefined
      const input: TurnStartParams['input'] = skill
        ? [{ type: 'skill', name: skill.name, path: skill.path }, ...(m![2]!.trim() ? [{ type: 'text' as const, text: m![2]!.trim(), text_elements: [] }] : [])]
        : [{ type: 'text', text, text_elements: [] }]
      const params: TurnStartParams = {
        threadId: live.threadId,
        input,
        sandboxPolicy: live.policy.sandbox,
        approvalPolicy: live.policy.approval,
        ...(live.model ? { model: live.model } : {}),
        ...(effort ? { effort } : {}),
        ...(live.spec.codexServiceTier ? { serviceTier: live.spec.codexServiceTier } : {}),
        ...(live.spec.outputSchema ? { outputSchema: live.spec.outputSchema } : {}),
      }
      const resp = await rpc.request('turn/start', params, 60_000)
      if (live.turn && !live.turn.codexTurnId) live.turn.codexTurnId = String(resp?.turn?.id ?? '') || null
      if (live.turn?.interrupted) await this.interrupt(live.spec.runId) // stop requested while turn/start was in flight
    } catch (e) {
      const message = e instanceof RpcError ? e.message : (e as Error)?.message || String(e)
      live.emit({ t: 'error', message })
      this.finishTurn(live, { text: live.turn?.text ?? '', sessionId: live.threadId, usage: null, costUsd: null, subtype: 'error_during_execution', isError: true, interrupted: false, error: message })
    }
  }

  async interrupt(runId: string): Promise<boolean> {
    const live = this.runs.get(runId)
    if (!live || live.closed) return false
    if (!live.turn) return true
    live.turn.interrupted = true
    // A parked approval would keep the turn waiting forever: decline it so the interrupt can land.
    this.cancelPrompts(live, 'interrupted')
    await this.rpcInterrupt(live)
    return true
  }

  async setMode(runId: string, mode: PermissionMode): Promise<boolean> {
    const live = this.runs.get(runId)
    if (!live || live.closed) return false
    live.spec.permissionMode = mode
    if (live.init) live.init = { ...live.init, permissionMode: mode }
    setRunStatus(live.spec.db, live.spec.schema, runId, live.busy ? 'running' : 'idle', { permissionMode: mode })
    live.emit({ t: 'mode', permissionMode: mode })
    return true
  }

  setAllowDanger(runId: string, allow: boolean): void {
    const live = this.runs.get(runId)
    if (live) live.spec.allowDanger = allow
  }

  async rewindFiles(): Promise<{ canRewind: boolean; error?: string }> {
    return { canRewind: false, error: 'file rewind is a Claude Code feature; Codex has no per-message file checkpoints' }
  }

  // Model / effort are per-turn overrides on Codex: remembered on the thread, applied by the next turn/start.
  async setModel(runId: string, model?: string | null, effort?: string | null): Promise<boolean> {
    const live = this.runs.get(runId)
    if (!live || live.closed) return false
    if (model !== undefined) { live.model = model ?? ''; live.spec.model = model ?? undefined; if (live.init && model) live.init = { ...live.init, model } }
    if (effort !== undefined) live.spec.effort = effort ?? undefined
    return true
  }

  answerPrompt(runId: string, promptId: string, a: PromptAnswer): boolean {
    const live = this.runs.get(runId)
    if (!live || live.closed) return false
    return answerPending(live.prompts, this.store(live), live.emit, promptId, a)
  }

  pendingPrompts(runId: string): PendingPrompt[] {
    return [...(this.runs.get(runId)?.prompts.values() ?? [])]
  }

  status(runId: string): 'busy' | 'waiting_prompt' | 'idle' | 'closed' {
    const live = this.runs.get(runId)
    if (!live || live.closed) return 'closed'
    if (live.prompts.size) return 'waiting_prompt'
    return live.busy ? 'busy' : 'idle'
  }

  isBusy(runId: string): boolean { const s = this.status(runId); return s === 'busy' || s === 'waiting_prompt' }

  info(runId: string): { sessionId: string | null; init: Extract<RunEvent, { t: 'init' }> | null; permissionMode: PermissionMode | null } {
    const live = this.runs.get(runId)
    return { sessionId: live?.threadId ?? null, init: live?.init ?? null, permissionMode: live?.spec.permissionMode ?? live?.init?.permissionMode ?? null }
  }

  private armIdle(live: LiveThread): void {
    if (live.idleTimer) clearTimeout(live.idleTimer)
    live.idleTimer = setTimeout(() => { if (!live.busy && !live.prompts.size) void this.close(live.spec.runId, 'idle') }, IDLE_MS)
    live.idleTimer.unref?.()
  }

  private teardown(live: LiveThread): void {
    if (live.idleTimer) clearTimeout(live.idleTimer)
    for (const t of live.promptTimers.values()) clearTimeout(t)
    live.promptTimers.clear()
    live.promptMeta.clear()
    live.unregister()
    if (this.runs.get(live.spec.runId) === live) { this.runs.delete(live.spec.runId); live.emit({ t: 'status', status: 'closed' }) }
  }

  async close(runId: string, reason = 'closed'): Promise<boolean> {
    const live = this.runs.get(runId)
    if (!live || live.closed) return false
    live.closed = true
    if (live.idleTimer) clearTimeout(live.idleTimer)
    this.cancelPrompts(live, 'session closed')
    if (live.turn) {
      await this.rpcInterrupt(live)
      this.finishTurn(live, { text: live.turn.text, sessionId: live.threadId, usage: null, costUsd: null, subtype: 'closed', isError: true, interrupted: live.turn.interrupted })
    }
    if (live.spec.db && live.spec.schema) {
      try { live.spec.db.update(live.spec.schema.runs).set({ status: 'idle', updatedAt: new Date().toISOString() }).where(eq(live.spec.schema.runs.id, runId)).run() } catch { /* ignore */ }
    }
    this.teardown(live)
    void reason
    return true
  }

  async closeAll(): Promise<boolean> {
    let any = false
    for (const id of [...this.runs.keys()]) any = (await this.close(id, 'shutdown')) || any
    if (stopCodexServer()) any = true
    return any
  }

  liveRunIds(): string[] { return [...this.runs.keys()].filter((id) => !this.runs.get(id)!.closed) }
}

const g = globalThis as unknown as { __codexHost?: CodexHost }
export const codexHost = g.__codexHost ?? (g.__codexHost = new CodexHost())
export type { CodexHost }
