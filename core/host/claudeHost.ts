import { randomUUID } from 'node:crypto'
import { query, type EffortLevel, type PermissionMode, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { eq } from 'drizzle-orm'
import { PushQueue } from './queue'
import { normalize, diffCumulativeUsage } from './normalize'
import { buildOptions } from './options'
import { answerPending, makeDangerHook, makePromptBridge, resolvePromptRow, type PendingPrompt } from './permissions'
import { makeRunEmitter, setRunStatus } from './recorder'
import type { ProviderUsage } from '../runs/types'
import type { PromptAnswer, RunEvent, RunSpec, TurnCallbacks, TurnResult } from './types'

// The Claude session host: one long-lived SDK query() per live run, fed by a push queue (streaming-input mode).
// This is what gives the UI the CLI's native behaviours — permission prompts, AskUserQuestion, plan mode,
// interrupt, mode switching, compaction/context events — instead of a one-shot `claude -p` per turn.

const IDLE_MS = Number(process.env.HOST_IDLE_MS || 20 * 60_000)
// A parked prompt nobody answers must not pin a CLI process forever: after this long it is denied as expired and the
// session idles out like any other.
const PROMPT_TTL_MS = Number(process.env.HOST_PROMPT_TTL_MS || 12 * 60 * 60_000)
// Upper bound on simultaneously live queries (each is a claude process); the oldest idle one is closed to make room.
const MAX_LIVE = Number(process.env.HOST_MAX_LIVE || 8)
// How long a turn may sit after a result we would not accept, before we stop waiting for one that fits.
const ORPHAN_RESULT_MS = Number(process.env.HOST_ORPHAN_RESULT_MS || 90_000)

type LiveTurn = {
  turnId: string | null
  cb: TurnCallbacks
  uuid: string // the user-message uuid we minted for this send; a result echoes it back
  activity: boolean // this turn has produced output of its own (text, thinking, a tool call)
  text: string // accumulated assistant text (main thread only)
  resolve: (r: TurnResult) => void
  interrupted: boolean
}

type LiveRun = {
  spec: RunSpec
  q: Query
  input: PushQueue<SDKUserMessage>
  abort: AbortController
  sessionId: string | null
  busy: boolean
  turn: LiveTurn | null
  prompts: Map<string, PendingPrompt>
  promptTimers: Map<string, ReturnType<typeof setTimeout>>
  lastCumulative: ProviderUsage | null
  idleTimer: ReturnType<typeof setTimeout> | null
  orphanTimer: ReturnType<typeof setTimeout> | null
  closed: boolean
  lastUsedAt: number
  init: Extract<RunEvent, { t: 'init' }> | null
  emit: (e: RunEvent) => void
  stderr: string
  consumer: Promise<void>
}

// Only the levels the flag-settings layer accepts; anything else (a Codex level such as `ultra`, a typo) is not sent.
const EFFORT_LEVELS = new Set<EffortLevel>(['low', 'medium', 'high', 'xhigh', 'max'])
function toEffortLevel(effort?: string | null): EffortLevel | undefined {
  return EFFORT_LEVELS.has(effort as EffortLevel) ? (effort as EffortLevel) : undefined
}

class ClaudeHost {
  private runs = new Map<string, LiveRun>()

  // Make sure a live query exists for this run. Reuses the live one when it can continue the same native
  // session; otherwise (idle-closed, crashed, different resume id) starts a fresh query with `resume`.
  async ensure(spec: RunSpec): Promise<LiveRun> {
    const cur = this.runs.get(spec.runId)
    if (cur && !cur.closed) {
      const sameSession = !spec.resume || spec.resume === cur.sessionId || !cur.sessionId
      // cwd, effort, the system prompt and --chrome are fixed for the life of a query: a change means a fresh query that
      // resumes the same native session (the transcript follows the session id, not the directory).
      const sameShape = cur.spec.cwd === spec.cwd && (cur.spec.effort ?? '') === (spec.effort ?? '') && (cur.spec.systemAppend ?? '') === (spec.systemAppend ?? '') && !!cur.spec.chrome === !!spec.chrome
      if (sameSession && sameShape && !cur.busy) {
        cur.spec = { ...cur.spec, ...spec, resume: cur.spec.resume, allowDanger: spec.allowDanger ?? cur.spec.allowDanger }
        if (spec.permissionMode && spec.permissionMode !== cur.init?.permissionMode) await this.setMode(spec.runId, spec.permissionMode).catch(() => {})
        if (spec.model && spec.model !== (cur.spec.model ?? '') && cur.init && spec.model !== cur.init.model) await cur.q.setModel(spec.model).catch(() => {})
        this.armIdle(cur)
        return cur
      }
      if (cur.busy) throw new Error('a turn is already running')
      await this.close(spec.runId, sameSession ? 'restart with new cwd/effort' : 'restart with different session')
      if (sameSession && cur.sessionId) spec = { ...spec, resume: cur.sessionId }
    }
    await this.evictIfNeeded()
    return this.create(spec)
  }

  // Keep at most MAX_LIVE queries alive: close the least recently used idle one (never a busy one or one waiting on a prompt).
  private async evictIfNeeded(): Promise<void> {
    const live = [...this.runs.values()].filter((r) => !r.closed)
    if (live.length < MAX_LIVE) return
    const idle = live.filter((r) => !r.busy && !r.prompts.size).sort((a, b) => a.lastUsedAt - b.lastUsedAt)
    for (const r of idle.slice(0, live.length - MAX_LIVE + 1)) await this.close(r.spec.runId, 'evicted')
  }

  private create(spec: RunSpec): LiveRun {
    const input = new PushQueue<SDKUserMessage>()
    const abort = new AbortController()
    const prompts = new Map<string, PendingPrompt>()
    const store = { db: spec.db, schema: spec.schema }
    const live: Partial<LiveRun> & { spec: RunSpec } = { spec, input, abort, prompts, promptTimers: new Map(), sessionId: spec.resume ?? null, busy: false, turn: null, lastCumulative: null, idleTimer: null, orphanTimer: null, closed: false, init: null, stderr: '', lastUsedAt: Date.now() }
    const emitRaw = makeRunEmitter({ runId: spec.runId, db: spec.db, schema: spec.schema, turnId: () => live.turn?.turnId ?? null })
    const emit = (e: RunEvent) => { emitRaw(e); try { live.turn?.cb.onEvent?.(e) } catch { /* ignore */ } }
    live.emit = emit
    const canUseTool = makePromptBridge({
      runId: spec.runId, store, prompts, currentTurnId: () => live.turn?.turnId ?? null, emit,
      onWaiting: (w) => { emit({ t: 'status', status: w ? 'waiting_prompt' : 'busy' }); setRunStatus(spec.db, spec.schema, spec.runId, w ? 'awaiting_input' : 'running') },
      onParked: (promptId) => {
        // TTL: an unanswered prompt expires (denied) so the session can idle out instead of pinning a process for days.
        const timer = setTimeout(() => {
          const p = prompts.get(promptId)
          if (!p) return
          resolvePromptRow(store, promptId, 'expired')
          emit({ t: 'permission_resolved', promptId, status: 'expired' })
          p.resolve({ behavior: 'deny', message: 'No answer within the prompt time limit (PR Cockpit)', interrupt: false })
        }, PROMPT_TTL_MS)
        timer.unref?.()
        live.promptTimers?.set(promptId, timer)
      },
      onSettled: (promptId) => { const t = live.promptTimers?.get(promptId); if (t) clearTimeout(t); live.promptTimers?.delete(promptId) },
    })
    const dangerHook = makeDangerHook(() => !!live.spec.allowDanger)
    const q = query({ prompt: input, options: buildOptions(spec, { canUseTool, dangerHook, abort, stderr: (d) => { live.stderr = (live.stderr + d).slice(-4000) } }) })
    live.q = q
    const run = live as LiveRun
    run.consumer = this.consume(run)
    this.runs.set(spec.runId, run)
    return run
  }

  private async consume(live: LiveRun): Promise<void> {
    try {
      for await (const msg of live.q) {
        for (const e of normalize(msg)) this.dispatch(live, e)
      }
    } catch (e) {
      const message = (e as Error)?.message || String(e)
      if (!live.closed) live.emit({ t: 'error', message: `${message}${live.stderr ? `\n${live.stderr.slice(-800)}` : ''}` })
      this.finishTurn(live, { text: live.turn?.text ?? '', sessionId: live.sessionId, usage: null, costUsd: null, subtype: 'error_during_execution', isError: true, interrupted: !!live.turn?.interrupted, error: message })
    } finally {
      this.teardown(live)
    }
  }

  private dispatch(live: LiveRun, e: RunEvent): void {
    // Output means a real turn is under way: it settles what an unattributable result could have been about.
    if (live.turn && isTurnOutput(e)) { live.turn.activity = true; this.clearOrphan(live) }
    switch (e.t) {
      case 'init':
        live.sessionId = e.sessionId || live.sessionId
        live.init = e
        if (e.sessionId) {
          try { live.turn?.cb.onSessionId?.(e.sessionId) } catch { /* ignore */ }
          if (live.spec.db && live.spec.schema) setRunStatus(live.spec.db, live.spec.schema, live.spec.runId, live.busy ? 'running' : 'idle', { claudeSessionId: e.sessionId, permissionMode: e.permissionMode })
        }
        break
      case 'text_delta':
        if (e.parent == null) { try { live.turn?.cb.onText?.(e.text) } catch { /* ignore */ } }
        break
      case 'assistant_text':
        if (e.parent == null && live.turn) live.turn.text += e.text
        break
      case 'tool_use':
        try { live.turn?.cb.onTool?.(e.name, summarizeInput(e.input)) } catch { /* ignore */ }
        break
      case 'mode':
        // The CLI changes modes on its own too (approving ExitPlanMode leaves plan mode) → keep our record in sync.
        live.spec.permissionMode = e.permissionMode
        if (live.init) live.init = { ...live.init, permissionMode: e.permissionMode }
        setRunStatus(live.spec.db, live.spec.schema, live.spec.runId, live.busy ? 'running' : 'idle', { permissionMode: e.permissionMode })
        break
      case 'turn_done': {
        const owner = live.turn ? resultOwner(e, live.turn) : 'ours'
        if (owner === 'ours') { this.completeTurn(live, e); return } // already emitted with the per-turn delta
        // Someone else's turn ended — the CLI runs turns we never asked for (a background-task notification queued
        // while the session was closed). Log it, keep ours open, and leave its spend on the baseline so it rolls into
        // the next real result instead of vanishing.
        live.emit({ t: 'note', text: `ignored a result that does not answer this message (${e.subtype}, ${e.numTurns} turns)` })
        this.armOrphan(live, owner === 'unsure' ? e : null)
        return
      }
      case 'reset':
        live.lastCumulative = null // "a mid-session /clear resets the running total" (sdk.d.ts SDKResultMessage.total_cost_usd)
        if (e.sessionId) {
          live.sessionId = e.sessionId
          try { live.turn?.cb.onSessionId?.(e.sessionId) } catch { /* ignore */ }
          setRunStatus(live.spec.db, live.spec.schema, live.spec.runId, live.busy ? 'running' : 'idle', { claudeSessionId: e.sessionId })
        }
        break
      case 'commands':
        if (live.init) live.init = { ...live.init, slashCommands: e.commands.map((c) => c.name) }
        break
      case 'local_command':
        // /compact, /context, /cost … print through the CLI's local command output — show it as the assistant's reply.
        if (live.turn) live.turn.text += (live.turn.text ? '\n' : '') + e.content
        try { live.turn?.cb.onText?.(e.content) } catch { /* ignore */ }
        break
      default:
        break
    }
    live.emit(e)
  }

  // End the live turn on the result that answers it: per-turn usage delta, resolve the caller, idle again.
  private completeTurn(live: LiveRun, e: Extract<RunEvent, { t: 'turn_done' }>): void {
    const delta = diffCumulativeUsage(live.lastCumulative, e.usage)
    // A crash/startup-error result may carry zeroed usage: keep the baseline, or the next turn would be billed the whole session.
    if (e.usage && e.usage.models.some((m) => m.inputTokens || m.outputTokens)) live.lastCumulative = e.usage
    // On an API error the result text IS the error; the partial assistant output stays in the turn, not in the error.
    const r: TurnResult = { text: e.isError ? (live.turn?.text || '') : (e.resultText || live.turn?.text || ''), sessionId: live.sessionId, usage: delta, costUsd: delta?.costUsd ?? null, subtype: e.subtype, isError: e.isError, interrupted: !!live.turn?.interrupted, ...(e.isError && e.resultText ? { error: e.resultText } : {}) }
    live.emit({ ...e, usage: delta, costUsd: delta?.costUsd ?? null })
    this.finishTurn(live, r)
    void this.emitContextUsage(live)
  }

  // No result has answered this send yet. Nothing else ever ends a turn — no idle timer runs while one is busy — so a
  // session that only produced other turns' results would keep the run 'running' for good. Wait ORPHAN_RESULT_MS from
  // the last result we turned down, then take it if it might have been ours after all (an older CLI echoes no uuid to
  // match on), or give up with an error rather than never returning. Re-armed by each further result we turn down.
  private armOrphan(live: LiveRun, fallback: Extract<RunEvent, { t: 'turn_done' }> | null): void {
    this.clearOrphan(live)
    const turn = live.turn
    if (!turn) return
    live.orphanTimer = setTimeout(() => {
      live.orphanTimer = null
      if (live.turn !== turn) return // that turn ended long ago; this result is no longer its business
      if (fallback) this.completeTurn(live, fallback)
      else this.finishTurn(live, { text: turn.text, sessionId: live.sessionId, usage: null, costUsd: null, subtype: 'no_matching_result', isError: true, interrupted: turn.interrupted, error: 'the session answered other messages but never this one' })
    }, ORPHAN_RESULT_MS)
    live.orphanTimer.unref?.()
  }

  private clearOrphan(live: LiveRun): void {
    if (live.orphanTimer) clearTimeout(live.orphanTimer)
    live.orphanTimer = null
  }

  // Context-window usage after a turn (the UI's context meter). Best effort: older CLIs may not support the request.
  private async emitContextUsage(live: LiveRun): Promise<void> {
    if (live.closed) return
    try {
      const u: any = await live.q.getContextUsage()
      const total = Number(u?.total_tokens ?? u?.totalTokens ?? 0)
      const max = Number(u?.raw_max_tokens ?? u?.rawMaxTokens ?? u?.max_tokens ?? 0)
      if (max > 0) live.emit({ t: 'context', totalTokens: total, maxTokens: max, percentage: Number(u?.percentage ?? Math.round((total / max) * 100)) })
    } catch { /* unsupported or the query closed */ }
  }

  private finishTurn(live: LiveRun, r: TurnResult & { error?: string }): void {
    const t = live.turn
    this.clearOrphan(live)
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

  private armIdle(live: LiveRun): void {
    if (live.idleTimer) clearTimeout(live.idleTimer)
    live.idleTimer = setTimeout(() => { if (!live.busy && !live.prompts.size) void this.close(live.spec.runId, 'idle') }, IDLE_MS)
    live.idleTimer.unref?.()
  }

  private teardown(live: LiveRun): void {
    if (live.idleTimer) clearTimeout(live.idleTimer)
    this.clearOrphan(live)
    live.closed = true
    for (const p of [...live.prompts.values()]) {
      resolvePromptRow({ db: live.spec.db, schema: live.spec.schema }, p.id, 'cancelled')
      live.emit({ t: 'permission_resolved', promptId: p.id, status: 'cancelled' })
      p.resolve({ behavior: 'deny', message: 'session closed', interrupt: false })
    }
    live.prompts.clear()
    for (const t of live.promptTimers.values()) clearTimeout(t)
    live.promptTimers.clear()
    if (live.turn) this.finishTurn(live, { text: live.turn.text, sessionId: live.sessionId, usage: null, costUsd: null, subtype: 'closed', isError: true, interrupted: live.turn.interrupted })
    // Only announce 'closed' when this query is still the registered one — a replacement may already be live under the same id.
    if (this.runs.get(live.spec.runId) === live) { this.runs.delete(live.spec.runId); live.emit({ t: 'status', status: 'closed' }) }
  }

  // Send one user message and wait for the turn to complete (result message). Rejects when a turn is already running.
  send(runId: string, text: string, cb: TurnCallbacks & { turnId?: string | null } = {}): Promise<TurnResult> {
    const live = this.runs.get(runId)
    if (!live || live.closed) return Promise.reject(new Error('run is not live'))
    if (live.busy) return Promise.reject(new Error('a turn is already running'))
    live.busy = true
    live.lastUsedAt = Date.now()
    if (live.idleTimer) clearTimeout(live.idleTimer)
    setRunStatus(live.spec.db, live.spec.schema, runId, 'running')
    live.emit({ t: 'status', status: 'busy' })
    return new Promise<TurnResult>((resolve) => {
      // uuid lets results/stream events be bound back to this send (user_message_uuid); the CLI stamps session_id itself.
      const uuid = randomUUID()
      live.turn = { turnId: cb.turnId ?? null, cb, uuid, activity: false, text: '', resolve, interrupted: false }
      try { cb.onUserUuid?.(uuid) } catch { /* ignore */ }
      const msg: SDKUserMessage = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, uuid: uuid as SDKUserMessage['uuid'] } as SDKUserMessage
      live.input.push(msg)
    })
  }

  async interrupt(runId: string): Promise<boolean> {
    const live = this.runs.get(runId)
    if (!live || live.closed) return false
    if (live.turn) live.turn.interrupted = true
    try { await live.q.interrupt() } catch { /* the turn may already be over */ }
    return true
  }

  async setMode(runId: string, mode: PermissionMode): Promise<boolean> {
    const live = this.runs.get(runId)
    if (!live || live.closed) return false
    await live.q.setPermissionMode(mode)
    this.dispatch(live, { t: 'mode', permissionMode: mode })
    return true
  }

  setAllowDanger(runId: string, allow: boolean): void {
    const live = this.runs.get(runId)
    if (live) live.spec.allowDanger = allow
  }

  // Restore the tracked files to their state at a user message (needs the live query; the caller ensure()s first).
  async rewindFiles(runId: string, userMessageUuid: string, dryRun = false): Promise<{ canRewind: boolean; error?: string; filesChanged?: string[]; insertions?: number; deletions?: number }> {
    const live = this.runs.get(runId)
    if (!live || live.closed) return { canRewind: false, error: 'session is not live' }
    if (live.busy) return { canRewind: false, error: 'a turn is running' }
    const r: any = await live.q.rewindFiles(userMessageUuid, { dryRun })
    return { canRewind: !!r?.canRewind, error: r?.error, filesChanged: r?.filesChanged, insertions: r?.insertions, deletions: r?.deletions }
  }

  // Model and effort both switch on the live query. Effort is baked in when the query is created, so it goes through
  // the flag-settings layer (streaming input mode, which is the mode this host runs in) and is only then recorded on
  // the spec: ensure() restarts the query whenever the recorded effort differs, which is the fallback when the live
  // update does not land. Recording it first would make that comparison always agree and freeze the old effort for
  // the rest of the session.
  async setModel(runId: string, model?: string | null, effort?: string | null): Promise<boolean> {
    const live = this.runs.get(runId)
    if (!live || live.closed) return false
    if (model !== undefined) { live.spec.model = model ?? undefined; await live.q.setModel(model ?? undefined); if (live.init && model) live.init = { ...live.init, model } }
    if (effort !== undefined) {
      const level = toEffortLevel(effort)
      // An unknown level is left untouched on purpose: the spec keeps the old value, so the next ensure() restarts the
      // query and the CLI itself decides what to make of what the caller stored on the run.
      if (level || !effort) {
        const applied = await live.q.applyFlagSettings({ effortLevel: level ?? null }).then(() => true).catch(() => false)
        if (applied) live.spec.effort = effort ?? undefined
      }
    }
    return true
  }

  answerPrompt(runId: string, promptId: string, a: PromptAnswer): boolean {
    const live = this.runs.get(runId)
    if (!live || live.closed) return false
    return answerPending(live.prompts, { db: live.spec.db, schema: live.spec.schema }, live.emit, promptId, a)
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

  isBusy(runId: string): boolean { return this.status(runId) === 'busy' || this.status(runId) === 'waiting_prompt' }

  info(runId: string): { sessionId: string | null; init: Extract<RunEvent, { t: 'init' }> | null; permissionMode: PermissionMode | null } {
    const live = this.runs.get(runId)
    return { sessionId: live?.sessionId ?? null, init: live?.init ?? null, permissionMode: live?.spec.permissionMode ?? live?.init?.permissionMode ?? null }
  }

  async close(runId: string, reason = 'closed'): Promise<boolean> {
    const live = this.runs.get(runId)
    if (!live || live.closed) return false
    live.closed = true
    if (live.idleTimer) clearTimeout(live.idleTimer)
    this.clearOrphan(live)
    try { live.input.close() } catch { /* ignore */ }
    try { live.q.close() } catch { /* ignore */ }
    if (live.spec.db && live.spec.schema) {
      // A closed run is idle from the UI's point of view (the transcript survives on disk; the next message resumes it).
      try { live.spec.db.update(live.spec.schema.runs).set({ status: live.turn ? 'stopped' : 'idle', updatedAt: new Date().toISOString() }).where(eq(live.spec.schema.runs.id, runId)).run() } catch { /* ignore */ }
    }
    void reason
    return true
  }

  async closeAll(): Promise<boolean> {
    let any = false
    for (const id of [...this.runs.keys()]) any = (await this.close(id, 'shutdown')) || any
    return any
  }

  liveRunIds(): string[] { return [...this.runs.keys()].filter((id) => !this.runs.get(id)!.closed) }
}

// Whose turn did this result end? The CLI emits one result per turn IT ran, and not every turn is one we asked for:
// a background-task notification queued while the session was closed wakes it up and completes in milliseconds with an
// empty result, before our own message is even dequeued. Ending our turn on that one closes the reply with no text and
// orphans everything the real turn goes on to produce.
//
// `user_message_uuid` echoes the uuid we minted for the send, which settles it outright. The CLI leaves it out on its
// own meta turns, on session-scoped failures that answer no single send, and older CLIs never send it at all — and
// those look alike from here. So an unnamed result that did nothing (no model turn, no text) while our turn has
// produced nothing either is only 'unsure', for the caller to hold and fall back on.
export function resultOwner(e: Extract<RunEvent, { t: 'turn_done' }>, turn: { uuid: string; activity: boolean; interrupted?: boolean }): 'ours' | 'foreign' | 'unsure' {
  if (e.userMessageUuid) return e.userMessageUuid === turn.uuid ? 'ours' : 'foreign' // a named result settles it either way
  if (turn.interrupted) return 'ours' // we asked the CLI to stop: the next unnamed result ends this turn, empty or not
  return e.numTurns === 0 && !e.resultText && !turn.activity ? 'unsure' : 'ours'
}

// Did this event come from the turn's own main thread? Subagent output (parent set) and the CLI's bookkeeping
// (task notifications, status, context) do not prove that our message is being worked on.
function isTurnOutput(e: RunEvent): boolean {
  // A reset answers our /clear, a compaction and a permission prompt only happen inside a turn that is running.
  if (e.t === 'local_command' || e.t === 'reset' || e.t === 'compaction' || e.t === 'permission_request') return true
  if (e.t === 'assistant_text' || e.t === 'thinking' || e.t === 'tool_use' || e.t === 'tool_result' || e.t === 'text_delta') return e.parent == null
  return false
}

function summarizeInput(input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  const v = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.description ?? i.prompt ?? ''
  return String(v).slice(0, 100)
}

// HMR-safe singleton (same pattern as core/events.ts): a dev reload must not orphan live CLI processes.
const g = globalThis as unknown as { __claudeHost?: ClaudeHost }
export const claudeHost = g.__claudeHost ?? (g.__claudeHost = new ClaudeHost())
export type { ClaudeHost }
