import { and, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import type { AutoConfig, PrAutoRow, PrStatusKey } from './decide'

// Reads/writes for project_automation / pr_automation + PR status classification. The engine, the API and the list endpoints all reuse this.
// db/schema are injected by the caller (core does not depend on the runtime db directly).

// The status key of a PR (same definition as pullKey in the frontend's [id].vue): merged/closed/draft/open
export function pullStatusKey(p: { state?: string; isDraft?: boolean }): PrStatusKey {
  if (p.state === 'merged') return 'merged'
  if (p.state === 'closed') return 'closed'
  if (p.isDraft || p.state === 'draft') return 'draft'
  return 'open'
}

function parseList(s: string | null | undefined): string[] {
  if (!s) return []
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

// Project-level automation config: parse the row if there is one, otherwise return the "all off" default (default status filter = in progress).
export function getProjectAutomation(db: any, schema: any, projectId: string): AutoConfig {
  const row = db.select().from(schema.projectAutomation).where(eq(schema.projectAutomation.projectId, projectId)).get()
  if (!row) {
    return {
      masterEnabled: false, reviewEnabled: false, reviewMode: 'once', reviewAuthors: [], reviewStatuses: ['open'],
      fixEnabled: false, fixAuthors: [], fixStatuses: ['open'],
    }
  }
  return {
    masterEnabled: !!row.masterEnabled,
    reviewEnabled: !!row.reviewEnabled,
    reviewMode: row.reviewMode === 'every_push' ? 'every_push' : 'once',
    reviewAuthors: parseList(row.reviewAuthors),
    reviewStatuses: parseList(row.reviewStatuses) as PrStatusKey[],
    fixEnabled: !!row.fixEnabled,
    fixAuthors: parseList(row.fixAuthors),
    fixStatuses: parseList(row.fixStatuses) as PrStatusKey[],
  }
}

function parseRow(r: any): PrAutoRow {
  return {
    reviewOn: r.reviewOn == null ? null : !!r.reviewOn,
    fixOn: r.fixOn == null ? null : !!r.fixOn,
    round: r.round ?? 0,
    lastFixReviewSha: r.lastFixReviewSha ?? null,
    pendingFix: !!r.pendingFix,
    optOut: !!r.optOut,
    postHeld: !!r.postHeld,
    note: r.note ?? null,
    headSeenSha: r.headSeenSha ?? null,
    headSeenAt: r.headSeenAt ?? null,
  }
}

export function getPrAutomationRow(db: any, schema: any, projectId: string, prNumber: number): PrAutoRow | null {
  const r = db
    .select()
    .from(schema.prAutomation)
    .where(and(eq(schema.prAutomation.projectId, projectId), eq(schema.prAutomation.prNumber, prNumber)))
    .get()
  return r ? parseRow(r) : null
}

// Fetch the automation rows of all PRs of a project in one go → Map<prNumber, row> (the list endpoint pulls everything at once, no N+1).
export function getPrAutomationMap(db: any, schema: any, projectId: string): Map<number, PrAutoRow> {
  const rows = db.select().from(schema.prAutomation).where(eq(schema.prAutomation.projectId, projectId)).all() as any[]
  const m = new Map<number, PrAutoRow>()
  for (const r of rows) m.set(r.prNumber, parseRow(r))
  return m
}

export type PrAutoUpsert = Partial<{
  reviewOn: boolean | null
  fixOn: boolean | null
  round: number
  lastFixReviewSha: string | null
  pendingFix: boolean
  optOut: boolean
  postHeld: boolean
  note: string | null
  headSeenSha: string | null
  headSeenAt: string | null
}>

// Record one automation workflow timeline event (feeds the "automation" tab of the PR drawer).
export function recordAutomationEvent(
  db: any, schema: any, projectId: string, prNumber: number, kind: string, message: string | null, now: string,
) {
  db.insert(schema.automationEvents).values({ id: nanoid(), projectId, prNumber, ts: now, kind, message }).run()
}

// Knock-on effect of deleting a task: the PR leaves automation (optOut), both switches go off and the in-progress state is cleared. Stops the project-level config from resurrecting it on the next round until the user turns it back on by hand.
export function optOutPr(db: any, schema: any, projectId: string, prNumber: number, now: string) {
  upsertPrAutomation(db, schema, projectId, prNumber, {
    reviewOn: false, fixOn: false, optOut: true, pendingFix: false, note: 'deleted',
  }, now)
}

// Knock-on effect of stopping: turn off both switches for that PR (no optOut, the task stays) so the engine stops rushing to continue; the user can turn it back on any time (which resets the round count).
export function pausePr(db: any, schema: any, projectId: string, prNumber: number, now: string) {
  upsertPrAutomation(db, schema, projectId, prNumber, {
    reviewOn: false, fixOn: false, pendingFix: false, note: 'stopped',
  }, now)
}

// Upsert one pr_automation row: update it with the patch if it exists, otherwise create the row (falling back to defaults).
export function upsertPrAutomation(db: any, schema: any, projectId: string, prNumber: number, patch: PrAutoUpsert, now: string) {
  const existing = db
    .select()
    .from(schema.prAutomation)
    .where(and(eq(schema.prAutomation.projectId, projectId), eq(schema.prAutomation.prNumber, prNumber)))
    .get()
  if (existing) {
    db.update(schema.prAutomation).set({ ...patch, updatedAt: now }).where(eq(schema.prAutomation.id, existing.id)).run()
    return existing.id as string
  }
  const id = nanoid()
  db.insert(schema.prAutomation).values({
    id,
    projectId,
    prNumber,
    reviewOn: patch.reviewOn ?? null,
    fixOn: patch.fixOn ?? null,
    round: patch.round ?? 0,
    lastFixReviewSha: patch.lastFixReviewSha ?? null,
    pendingFix: patch.pendingFix ?? false,
    optOut: patch.optOut ?? false,
    postHeld: patch.postHeld ?? false,
    note: patch.note ?? null,
    headSeenSha: patch.headSeenSha ?? null,
    headSeenAt: patch.headSeenAt ?? null,
    updatedAt: now,
  }).run()
  return id
}
