import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { prepareWorktree, prepareFeatureWorktree } from '../git/worktree'
import { hostFor, hostOf } from '../host'
import { runChannel } from '../host/recorder'
import { makeEmit } from '../streaming/emit'
import { appendTurns } from '../db/turns'
import { fetchIssueContext } from '../github/issueAssets'
import { fetchReviewsCount, findPrByBranch } from '../github/gh'
import { prepareAgentHistoryAccess } from '../agent/historyAccess'
import { fixSystemPrompt } from '../agent/fixer'
import { featureSystemPrompt } from '../agent/featureChat'
import { globalSystemPrompt } from '../agent/globalChat'
import { genFeatureTitle } from '../agent/featureTitle'
import { hasUploadable } from '../fix/changes'
import { computeFixNextStatus } from '../fix/status'
import { cockpitBus } from '../events'
import { finishRun, recordRunUsage, setRunSession } from './store'
import { projectDirNameFor } from '../host/options'
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { ReviewProvider } from '../agent/runners'

// The ONE session turn pipeline. A session run is a persistent conversation bound to a workspace:
//   pr_worktree     — a worktree of a PR branch (the old "fix"): edits stay uncommitted until the upload path commits+pushes
//   branch_worktree — a worktree on a fresh branch cut from the default branch (the old "feature"): the agent may open a PR
//   cwd             — any directory (the old "global" assistant)
// Every turn: append run_turns → ensure the workspace → enrich the message (issue/PR context, cross-provider history) →
// hostFor(provider).ensure/send → persist the reply, usage and the workspace state. Events travel on run:<id>.

const pexec = promisify(execFile)
const git = (wt: string, args: string[]) => pexec('git', ['-C', wt, ...args], { maxBuffer: 64 * 1024 * 1024 })

export type WorkspaceType = 'pr_worktree' | 'branch_worktree' | 'cwd'

export type SessionTurnCtx = {
  db: any
  schema: any
  runId: string
  message: string
  // Provider / model / effort to use when the run has no native session yet (project or runtime defaults); once a
  // native session exists the run's own row wins ("never mix").
  defaults: { provider: ReviewProvider; model: string; effort?: string; codexServiceTier?: string | null; translateModel?: string }
  project?: { id: string; repo: string; localPath: string | null; defaultBranch: string } | null
  reposDir: string
  worktreeLocation?: string | null
  assetsDir: string
  lang: string
  permissionMode?: PermissionMode
  allowDanger?: boolean
  ultracode?: boolean
  chrome?: boolean
}

// ── busy / stop bookkeeping + the per-run message queue ──
const locks = new Set<string>()
const stopRequested = new Set<string>()
// Messages sent while a turn runs wait here (persisted as run_turns rows with status 'queued') and start one after the
// other when the running turn ends. Stop clears the queue; a restart drops it (recover marks the rows stopped).
const queues = new Map<string, Array<{ ctx: SessionTurnCtx; userTurnId: string }>>()

export function queuedTurns(runId: string): string[] { return (queues.get(runId) ?? []).map((q) => q.userTurnId) }

// Run now when the run is free, otherwise park the message. Returns the queued user turn id when parked.
export function submitSessionTurn(ctx: SessionTurnCtx): { queued: boolean; turnId: string | null } {
  if (!isRunBusy(ctx.runId)) { void runSessionTurn(ctx).catch((e) => console.error('[runs] turn failed', e)); return { queued: false, turnId: null } }
  const { db, schema, runId } = ctx
  const now = new Date().toISOString()
  const maxSeq = (db.select().from(schema.runTurns).where(eq(schema.runTurns.runId, runId)).all() as { seq: number }[]).reduce((m, t) => Math.max(m, t.seq), 0)
  const id = nanoid()
  db.insert(schema.runTurns).values({ id, runId, seq: maxSeq + 1, role: 'user', content: ctx.message, status: 'queued', createdAt: now }).run()
  const q = queues.get(runId) ?? []
  q.push({ ctx, userTurnId: id })
  queues.set(runId, q)
  cockpitBus.emit({ reviewId: runChannel(runId), ts: now, kind: 'chat', message: 'queued' })
  return { queued: true, turnId: id }
}

export function cancelQueuedTurn(runId: string, turnId: string, db: any, schema: any): boolean {
  const q = queues.get(runId) ?? []
  const i = q.findIndex((x) => x.userTurnId === turnId)
  if (i < 0) return false
  q.splice(i, 1)
  db.delete(schema.runTurns).where(eq(schema.runTurns.id, turnId)).run()
  cockpitBus.emit({ reviewId: runChannel(runId), ts: new Date().toISOString(), kind: 'chat', message: 'dequeued' })
  return true
}

function clearQueue(runId: string, db?: any, schema?: any): void {
  const q = queues.get(runId) ?? []
  queues.delete(runId)
  if (db && schema) for (const x of q) { try { db.update(schema.runTurns).set({ status: 'stopped', endedAt: new Date().toISOString() }).where(eq(schema.runTurns.id, x.userTurnId)).run() } catch { /* ignore */ } }
}

function startNextQueued(runId: string): void {
  const next = queues.get(runId)?.shift()
  if (!next) { queues.delete(runId); return }
  void runSessionTurn(next.ctx, { userTurnId: next.userTurnId }).catch((e) => console.error('[runs] queued turn failed', e))
}

export function isRunBusy(runId: string): boolean {
  return locks.has(runId) || hostOf(runId).isBusy(runId)
}

// Stop the turn in progress: interrupt the live host session (it stays alive) or, when the job has not reached the host
// yet, remember the stop so the turn is skipped. Returns false when nothing is running.
export function stopRun(runId: string, store?: { db: any; schema: any }): boolean {
  clearQueue(runId, store?.db, store?.schema) // Stop means stop everything, queued messages included
  const host = hostOf(runId)
  if (host.isBusy(runId)) { stopRequested.add(runId); void host.interrupt(runId); return true }
  if (locks.has(runId)) { stopRequested.add(runId); return true }
  return false
}

export function stopAllRuns(): boolean {
  let any = false
  for (const id of [...locks]) any = stopRun(id) || any
  return any
}

// What the automation engine and the PR list call the "fix status" of a pr_worktree run.
export function fixStatusOf(run: { status: string; uploadState?: string | null; busyAction?: string | null }): 'open' | 'ready' | 'pushing' | 'pushed' | 'error' {
  if (run.busyAction === 'pushing') return 'pushing'
  if (run.status === 'error') return 'error'
  if (run.uploadState === 'ready') return 'ready'
  if (run.uploadState === 'pushed') return 'pushed'
  return 'open'
}

export function slugify(s: string): string {
  return (s || 'feature').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'feature'
}

async function conflictHint(wt: string): Promise<string | undefined> {
  const { stdout } = await git(wt, ['diff', '--name-only', '--diff-filter=U']).catch(() => ({ stdout: '' }))
  const files = stdout.trim().split('\n').map((s) => s.trim()).filter(Boolean)
  if (!files.length) return undefined
  return `There are UNRESOLVED merge conflicts in these files (they contain <<<<<<< / ======= / >>>>>>> markers): ${files.join(', ')}. Resolve every conflict by editing the files and removing all conflict markers.`
}

async function currentHead(wt: string): Promise<string | null> {
  const { stdout } = await git(wt, ['rev-parse', 'HEAD']).catch(() => ({ stdout: '' }))
  return stdout.trim() || null
}

// Make sure the run's workspace exists on disk. Worktrees are created on the first turn and reused; when the directory
// disappeared (restart cleanup, manual delete) it is recreated on the same branch.
export async function ensureRunWorkspace(ctx: Pick<SessionTurnCtx, 'db' | 'schema' | 'runId' | 'project' | 'reposDir' | 'worktreeLocation'>, run: any, emit: (kind: string, message: string) => void): Promise<string> {
  const { db, schema, runId } = ctx
  const now = () => new Date().toISOString()
  if (run.workspaceType === 'cwd') {
    if (!run.workspacePath || !existsSync(run.workspacePath)) throw new Error(`working directory does not exist: ${run.workspacePath || '(none)'}`)
    return run.workspacePath
  }
  if (run.workspacePath && existsSync(run.workspacePath)) return run.workspacePath
  const project = ctx.project
  if (!project?.localPath) throw new Error('项目未配置本地 clone 路径（worktree 需要它）')
  if (run.workspaceType === 'pr_worktree') {
    if (!run.branch) throw new Error('PR 分支为空，无法准备 worktree')
    const wt = await prepareWorktree({
      localPath: project.localPath, reposDir: ctx.reposDir, location: ctx.worktreeLocation, reviewId: runId, branch: run.branch, defaultBranch: project.defaultBranch, prNumber: run.prNumber,
      mergeDefault: false, // the session pushes to the PR branch, so the commits it produces must stay clean
      onStep: (m) => emit('stage', m),
    })
    db.update(schema.runs).set({ workspacePath: wt.path, baseHeadSha: wt.headSha, updatedAt: now() }).where(eq(schema.runs.id, runId)).run()
    return wt.path
  }
  // branch_worktree: a new branch cut from the base branch; the slug keeps nanoid's `_` out of the ref name.
  emit('stage', '准备 worktree（新功能分支）')
  const branch = run.branch || `feat/${slugify(run.title || run.description)}-${slugify(runId.slice(0, 6))}`
  const wt = await prepareFeatureWorktree({
    localPath: project.localPath, reposDir: ctx.reposDir, taskId: runId, location: ctx.worktreeLocation,
    newBranch: branch, defaultBranch: run.baseBranch || project.defaultBranch, onStep: (m) => emit('stage', m),
  })
  db.update(schema.runs).set({ workspacePath: wt.path, baseHeadSha: wt.headSha, branch, baseBranch: run.baseBranch || project.defaultBranch, updatedAt: now() }).where(eq(schema.runs.id, runId)).run()
  return wt.path
}

const ASK_RE = /```ask-user\b/i
export function hasAskBlock(text: string): boolean { return ASK_RE.test(text || '') }

function systemPromptFor(run: any, ctx: SessionTurnCtx, extra: { conflict?: string }): string {
  if (run.workspaceType === 'pr_worktree') return fixSystemPrompt(ctx.lang, extra.conflict)
  if (run.workspaceType === 'branch_worktree') return featureSystemPrompt(ctx.lang, run.baseBranch || ctx.project?.defaultBranch)
  return globalSystemPrompt(ctx.lang)
}

export async function runSessionTurn(ctx: SessionTurnCtx, opts: { userTurnId?: string } = {}): Promise<void> {
  const { db, schema, runId } = ctx
  const now = () => new Date().toISOString()
  if (locks.has(runId)) return
  locks.add(runId)
  const emit = makeEmit({ channel: runChannel(runId), now }) // live-only pipeline events (text / chat / stage / error)
  const row = () => db.select().from(schema.runs).where(eq(schema.runs.id, runId)).get() as any
  const run0 = row()
  if (!run0) { locks.delete(runId); return }

  // A queued message already has its user row: mark it done and append only the assistant placeholder.
  let asstId: string
  let userTurnId: string
  if (opts.userTurnId) {
    userTurnId = opts.userTurnId
    const maxSeq = (db.select().from(schema.runTurns).where(eq(schema.runTurns.runId, runId)).all() as { seq: number }[]).reduce((m, t) => Math.max(m, t.seq), 0)
    db.update(schema.runTurns).set({ status: 'done' }).where(eq(schema.runTurns.id, userTurnId)).run()
    asstId = nanoid()
    db.insert(schema.runTurns).values({ id: asstId, runId, seq: maxSeq + 1, role: 'assistant', content: '', status: 'streaming', createdAt: now() }).run()
  } else {
    const t = appendTurns({ db, turnTable: schema.runTurns, fkField: 'runId', fkValue: runId, now, message: ctx.message })
    asstId = t.assistantId
    userTurnId = t.userId
  }
  db.update(schema.runs).set({ status: 'running', error: null, updatedAt: now() }).where(eq(schema.runs.id, runId)).run()
  emit('chat', 'user')

  let acc = ''
  let lastWrite = 0
  const flush = (status: string) => db.update(schema.runTurns).set({ content: acc, status, ...(status !== 'streaming' ? { endedAt: now() } : {}) }).where(eq(schema.runTurns.id, asstId)).run()
  let stopped = false
  try {
    // Provider pinning: once a native session exists the run keeps its provider; before that the defaults decide.
    const hasNative = !!run0.claudeSessionId || !!run0.codexThreadId
    const provider: ReviewProvider = hasNative ? (run0.provider === 'codex' ? 'codex' : 'claude') : ctx.defaults.provider
    const pinned = hasNative && run0.provider === provider
    const model = (pinned ? run0.model : null) || ctx.defaults.model || ''
    const effort = (pinned ? run0.effort : null) || ctx.defaults.effort
    const codexServiceTier = provider === ctx.defaults.provider ? (ctx.defaults.codexServiceTier ?? null) : null
    if (!hasNative) db.update(schema.runs).set({ provider, model: model || null, effort: effort || null, codexServiceTier, updatedAt: now() }).where(eq(schema.runs.id, runId)).run()

    // pr_worktree: me stepping in answers this review round → bump the "reviews at push" baseline so the red dot clears.
    if (run0.workspaceType === 'pr_worktree' && run0.pushedAt && ctx.project) {
      const reviewsNow = await fetchReviewsCount(ctx.project.repo, run0.prNumber).catch(() => null)
      if (reviewsNow != null) db.update(schema.runs).set({ reviewsAtPush: reviewsNow, updatedAt: now() }).where(eq(schema.runs.id, runId)).run()
    }

    const cwd = await ensureRunWorkspace(ctx, row(), emit)
    const run = row()

    // Message enrichment: a GitHub issue/PR referenced in the message → body + downloaded images (private attachments too).
    let agentMessage = ctx.message
    let issueEnriched = ''
    const isFirstTurn = !hasNative
    try {
      const source = run.workspaceType === 'branch_worktree' && isFirstTurn ? `${run.description || ''}\n${ctx.message}` : ctx.message
      const ic = await fetchIssueContext(source, join(ctx.assetsDir, runId))
      if (ic) {
        issueEnriched = ic.enrichedText
        agentMessage = `${ctx.message}\n\n[Content of the issue/PR referenced in the message (already fetched by the backend)]\n${ic.enrichedText}`
        if (ic.imagePaths.length) agentMessage += `\n\n[Images (already downloaded locally — open each one with Read first)]\n${ic.imagePaths.map((p, i) => `${i + 1}. ${p}`).join('\n')}`
        emit('stage', `已抓取 issue/PR 内容（${ic.summary}）`)
      }
    } catch (e) {
      emit('stage', `issue/PR 抓取失败，用原始消息继续：${(e as Error).message}`)
    }
    // branch_worktree first turn: a short title from the requirement (background; the list falls back to the description).
    if (run.workspaceType === 'branch_worktree' && isFirstTurn && !run.title && ctx.defaults.translateModel !== undefined) {
      void genFeatureTitle({ provider, model: ctx.defaults.translateModel || model, codexServiceTier: ctx.defaults.codexServiceTier, requirement: `${run.description || ctx.message}\n${issueEnriched}`, lang: ctx.lang, cwd: ctx.project?.localPath || cwd })
        .then((title) => { if (title) db.update(schema.runs).set({ title, updatedAt: now() }).where(eq(schema.runs.id, runId)).run() })
        .catch(() => { /* the list shows the description instead */ })
    }

    // Cross-provider handoff: the other provider's transcript is offered read-only when this provider starts fresh.
    const resumeId: string | null = (provider === 'codex' ? run.codexThreadId : run.claudeSessionId) ?? null
    const otherSession = provider === 'codex' ? run.claudeSessionId : run.codexThreadId
    const needsHandoff = !!otherSession && !resumeId
    const historyAccess = needsHandoff
      ? await prepareAgentHistoryAccess({ db, schema, id: runId, cwd, limit: 80 }).catch((e) => { emit('stage', `历史入口准备失败，继续本轮：${(e as Error).message}`); return undefined })
      : undefined
    const text = `${ctx.ultracode && provider !== 'codex' ? 'ultracode: ' : ''}${agentMessage}${needsHandoff && historyAccess ? `\n\n${historyAccess}` : ''}`

    const headBefore = run.workspaceType === 'pr_worktree' && provider === 'codex' ? await currentHead(cwd) : null
    const guardScope = run.workspaceType === 'pr_worktree' ? 'fix' : run.workspaceType === 'branch_worktree' ? 'feature' : 'global'
    const defaultMode: PermissionMode = run.workspaceType === 'cwd' ? 'default' : 'bypassPermissions'
    const host = hostFor(provider)
    // A provider switch must not leave the other host holding this run (hostOf would route prompts/stops to it).
    const other = hostFor(provider === 'codex' ? 'claude' : 'codex')
    if (other.status(runId) !== 'closed') await other.close(runId, 'provider switched').catch(() => {})
    await host.ensure({
      runId, kind: 'session', cwd, model, effort, resume: resumeId, ...(run.forkedFrom && resumeId ? { fork: true } : {}), // a fork carries the source's native id until its own session exists
      permissionMode: ctx.permissionMode ?? (run.permissionMode as PermissionMode | null) ?? defaultMode, allowDanger: ctx.allowDanger,
      systemAppend: systemPromptFor(run, ctx, { conflict: run.workspaceType === 'pr_worktree' ? await conflictHint(cwd) : undefined }),
      chrome: ctx.chrome, codexServiceTier, ultracode: ctx.ultracode, guardScope,
      projectDirName: run.workspaceType !== 'cwd' ? projectDirNameFor(ctx.project?.localPath) : undefined, // one memory dir per project, not per worktree
      db, schema,
    })
    if (stopRequested.has(runId)) throw new Error('stopped before the turn started')
    const r = await host.send(runId, text, {
      turnId: asstId,
      onSessionId: (sid) => setRunSession(db, schema, runId, provider, sid),
      onUserUuid: (uuid) => { try { db.update(schema.runTurns).set({ messageUuid: uuid }).where(eq(schema.runTurns.id, userTurnId)).run() } catch { /* ignore */ } },
      onText: (t) => {
        acc += t
        const n = Date.now()
        if (n - lastWrite > 400) { lastWrite = n; flush('streaming') }
        emit('text', t)
      },
    })
    acc = r.text || acc
    recordRunUsage(db, schema, runId, r.usage, asstId)
    if (r.interrupted || stopRequested.has(runId)) stopped = true
    else if (r.isError) throw new Error(r.subtype === 'error_during_execution' ? (r.error || r.text || 'agent turn failed') : `agent turn ended: ${r.subtype}`)
    if (headBefore) {
      const headAfter = await currentHead(cwd)
      if (headAfter && headAfter !== headBefore) throw new Error('Codex changed git HEAD. Codex must leave commits to the upload path; inspect the worktree before retrying.')
    }
    flush(stopped ? 'stopped' : 'done')

    // Workspace state after the turn.
    const patch: Record<string, unknown> = { error: null, updatedAt: now(), ...(run.forkedFrom ? { forkedFrom: null } : {}) }
    let status: 'idle' | 'stopped' | 'awaiting_input' = stopped ? 'stopped' : 'idle'
    if (run.workspaceType === 'pr_worktree') {
      const up = await hasUploadable(cwd, run.branch).catch(() => ({ dirty: false, ahead: false }))
      const next = computeFixNextStatus({ dirty: up.dirty, ahead: up.ahead, currentStatus: fixStatusOf(row()) })
      patch.uploadState = next === 'ready' ? 'ready' : next === 'pushed' ? 'pushed' : 'none'
    } else if (run.workspaceType === 'branch_worktree') {
      if (ctx.project && run.branch) {
        const pr = await findPrByBranch(ctx.project.repo, run.branch).catch(() => null)
        if (pr) { patch.prUrl = pr.url; patch.prNumber = pr.number }
      }
      if (!stopped && hasAskBlock(acc)) status = 'awaiting_input'
    } else if (!run.title) {
      patch.title = ctx.message.trim().slice(0, 60)
    }
    db.update(schema.runs).set(patch).where(eq(schema.runs.id, runId)).run()
    finishRun(db, schema, runId, { status })
    emit('chat', stopped ? 'stopped' : 'done')
  } catch (e) {
    if (stopRequested.has(runId)) {
      flush('stopped')
      db.update(schema.runs).set({ error: null, updatedAt: now() }).where(eq(schema.runs.id, runId)).run()
      finishRun(db, schema, runId, { status: 'stopped' })
      emit('chat', 'stopped')
    } else {
      flush('error')
      const message = (e as Error).message
      finishRun(db, schema, runId, { status: 'error', error: message })
      emit('error', message)
    }
  } finally {
    locks.delete(runId)
    stopRequested.delete(runId)
    cockpitBus.emit({ reviewId: runChannel(runId), ts: now(), kind: 'status', message: row()?.status })
    startNextQueued(runId)
  }
}
