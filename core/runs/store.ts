import { nanoid } from 'nanoid'
import { eq, sql } from 'drizzle-orm'
import type { ProviderUsage, RunKind, RunStatus, RunSubkind } from './types'

// The single writer for the runs / run_usage tables. db/schema are injected like everywhere else in core.
// Failures here must never break the pipeline that is recording — every entry point swallows and logs.

export type NewRun = {
  id?: string
  kind: RunKind
  subkind: RunSubkind
  provider: 'claude' | 'codex'
  projectId?: string | null
  reviewId?: string | null
  workspaceType?: 'pr_worktree' | 'branch_worktree' | 'cwd' | null
  workspacePath?: string | null
  prNumber?: number | null
  branch?: string | null
  model?: string | null
  effort?: string | null
  codexServiceTier?: string | null
  skillId?: string | null
  skillVersionId?: string | null
  title?: string | null
  lang?: string | null
}

const now = () => new Date().toISOString()

function warn(what: string, e: unknown) {
  console.warn(`[runs] ${what} failed: ${(e as Error)?.message || e}`)
}

// Insert a fresh run row in 'running' state. Returns the id (never throws).
export function createRun(db: any, schema: any, r: NewRun): string {
  const id = r.id || nanoid()
  try {
    const ts = now()
    db.insert(schema.runs).values({
      id, kind: r.kind, subkind: r.subkind, provider: r.provider,
      projectId: r.projectId ?? null, reviewId: r.reviewId ?? null,
      workspaceType: r.workspaceType ?? null, workspacePath: r.workspacePath ?? null,
      prNumber: r.prNumber ?? null, branch: r.branch ?? null,
      model: r.model || null, effort: r.effort || null, codexServiceTier: r.codexServiceTier ?? null,
      skillId: r.skillId ?? null, skillVersionId: r.skillVersionId ?? null,
      status: 'running', title: r.title ?? null, lang: r.lang ?? null,
      createdAt: ts, startedAt: ts, updatedAt: ts,
    }).run()
  } catch (e) { warn('createRun', e) }
  return id
}

// Sessions (fix / feature / global) keep ONE run row per conversation whose id equals the entity id, so the
// later "runs replace fixes/feature_tasks/global_sessions" migration keeps ids stable. Idempotent: creates the
// row on the first turn, refreshes the mutable attribution fields (provider/model/effort/workspace) afterwards.
export function ensureSessionRun(db: any, schema: any, r: NewRun & { id: string }): string {
  try {
    const existing = db.select({ id: schema.runs.id }).from(schema.runs).where(eq(schema.runs.id, r.id)).get()
    if (!existing) return createRun(db, schema, { ...r, kind: 'session', subkind: r.subkind || 'session' })
    db.update(schema.runs).set({
      provider: r.provider, model: r.model || null, effort: r.effort || null, codexServiceTier: r.codexServiceTier ?? null,
      workspaceType: r.workspaceType ?? null, workspacePath: r.workspacePath ?? null,
      prNumber: r.prNumber ?? null, branch: r.branch ?? null, title: r.title ?? undefined,
      status: 'running', error: null, updatedAt: now(),
    }).where(eq(schema.runs.id, r.id)).run()
  } catch (e) { warn('ensureSessionRun', e) }
  return r.id
}

// Append per-model usage rows and add them to the run's totals. `usage` is a delta for this execution.
export function recordRunUsage(db: any, schema: any, runId: string, usage: ProviderUsage | null | undefined, turnId?: string | null): void {
  if (!usage) return
  try {
    const cur = db.select().from(schema.runs).where(eq(schema.runs.id, runId)).get()
    if (!cur) return // no run row (never created / already deleted) → nothing to attribute to
    const at = now()
    let inTok = 0, outTok = 0, cacheRead = 0, cacheCreate = 0
    let estimatedTotal = 0
    let anyEstimated = false
    let anyPriced = false
    for (const m of usage.models) {
      db.insert(schema.runUsage).values({
        id: nanoid(), runId, turnId: turnId ?? null, model: m.model,
        inputTokens: m.inputTokens, outputTokens: m.outputTokens, cacheReadTokens: m.cacheReadTokens, cacheCreateTokens: m.cacheCreateTokens,
        costUsd: m.costUsd, costSource: m.costSource, at,
      }).run()
      inTok += m.inputTokens; outTok += m.outputTokens; cacheRead += m.cacheReadTokens; cacheCreate += m.cacheCreateTokens
      if (m.costUsd != null) { estimatedTotal += m.costUsd; anyPriced = true }
      if (m.costSource === 'estimated') anyEstimated = true
    }
    // Total cost for this execution: the provider's reported total wins; otherwise the sum of per-model estimates; otherwise unknown.
    const cost = usage.costUsd != null ? usage.costUsd : anyPriced ? estimatedTotal : null
    const source = usage.costUsd != null ? (usage.costSource || 'reported') : anyPriced ? (anyEstimated ? 'estimated' : 'reported') : null
    const patch: Record<string, unknown> = {
      unpricedTurns: sql`${schema.runs.unpricedTurns} + ${cost == null && usage.models.length ? 1 : 0}`,
      inputTokens: sql`${schema.runs.inputTokens} + ${inTok}`,
      outputTokens: sql`${schema.runs.outputTokens} + ${outTok}`,
      cacheReadTokens: sql`${schema.runs.cacheReadTokens} + ${cacheRead}`,
      cacheCreateTokens: sql`${schema.runs.cacheCreateTokens} + ${cacheCreate}`,
      numTurns: sql`${schema.runs.numTurns} + ${usage.numTurns ?? 0}`,
      durationMs: sql`${schema.runs.durationMs} + ${usage.durationMs ?? 0}`,
      updatedAt: at,
    }
    if (cost != null) {
      patch.costUsd = (cur.costUsd ?? 0) + cost
      // A run that mixes reported and estimated numbers is, as a whole, an estimate.
      patch.costSource = cur.costSource === 'estimated' || source === 'estimated' ? 'estimated' : 'reported'
    }
    if (usage.cliVersion) patch.cliVersion = usage.cliVersion
    if (usage.sessionId) {
      if (cur.provider === 'codex') patch.codexThreadId = usage.sessionId
      else patch.claudeSessionId = usage.sessionId
    }
    db.update(schema.runs).set(patch).where(eq(schema.runs.id, runId)).run()
  } catch (e) { warn('recordRunUsage', e) }
}

export function setRunSession(db: any, schema: any, runId: string, provider: 'claude' | 'codex', sessionId: string | null): void {
  if (!sessionId) return
  try {
    db.update(schema.runs).set(provider === 'codex' ? { codexThreadId: sessionId, updatedAt: now() } : { claudeSessionId: sessionId, updatedAt: now() }).where(eq(schema.runs.id, runId)).run()
  } catch (e) { warn('setRunSession', e) }
}

export function finishRun(db: any, schema: any, runId: string, o: { status: RunStatus; error?: string | null }): void {
  try {
    const ts = now()
    db.update(schema.runs).set({ status: o.status, error: o.error ?? null, endedAt: ts, updatedAt: ts }).where(eq(schema.runs.id, runId)).run()
  } catch (e) { warn('finishRun', e) }
}
