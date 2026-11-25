import { eq, asc, inArray, sql } from 'drizzle-orm'
import { isRecheckResolved } from '../recheckAxes'
import { isAutomatable, isUnattendedAutomatable } from './automatable'
import { stillToPost } from '../review/postGate'

export { isAutomatable, isUnattendedAutomatable }

// Single definition of an "outstanding finding": severity is High/Medium (we don't chase Low/nit) and it is not yet resolved.
// Resolved = we retracted it, or the author fixed/replied to it — decided by isRecheckResolved, which reads both axes.
// Everything else counts as still to fix: kept (we stand by it), adjusted (reworded, still valid), discuss, new,
// unaddressed and partial. Reading the resolved side rather than the unresolved side means a status added later is
// treated as unresolved by default, so a High is never dropped and convergence is never falsely reported.
// Auto-fix's "should we fix again / have we converged" (engine uses actionable) and "the instructions fed to the agent"
// (buildAutoFixMessage uses actionableFindings) both rely on this definition, so it lives here in reviewFindingStats to keep the
// two from drifting apart. db/schema are injected by the caller (core does not depend on the runtime db directly).
const ACTIONABLE_SEVERITY = new Set(['High', 'Medium'])


export type ReviewFindingStats = {
  total: number // findings automation may post unattended (0 = nothing to post)
  actionable: number // how many still need handling
  actionableFindings: any[] // the finding rows still needing handling (by sortOrder, for buildAutoFixMessage)
}

// One scan yields total + outstanding count + outstanding rows (the engine gets everything at once, no repeated db reads).
export function reviewFindingStats(db: any, schema: any, reviewId: string): ReviewFindingStats {
  const findings = db
    .select()
    .from(schema.findings)
    .where(eq(schema.findings.reviewId, reviewId))
    .orderBy(asc(schema.findings.sortOrder))
    .all() as any[]
  if (!findings.length) return { total: 0, actionable: 0, actionableFindings: [] }

  const ids = findings.map((f) => f.id)
  const rechecks = db.select().from(schema.findingRechecks).where(inArray(schema.findingRechecks.findingId, ids)).all() as any[]
  // For each finding, take the recheck status from the latest round (highest round)
  const latest = new Map<string, { round: number; status: string; stance: string | null }>()
  for (const rc of rechecks) {
    const cur = latest.get(rc.findingId)
    if (!cur || rc.round > cur.round) latest.set(rc.findingId, { round: rc.round, status: rc.status, stance: rc.stance ?? null })
  }

  const actionableFindings = findings.filter((f) => {
    if (!isUnattendedAutomatable(f)) return false
    if (f.tier == null && !ACTIONABLE_SEVERITY.has(f.severity)) return false
    const rc = latest.get(f.id)
    return !rc || !isRecheckResolved(rc) // never rechecked, or the latest round left it open → still to fix
  })
  return { total: findings.filter(isUnattendedAutomatable).length, actionable: actionableFindings.length, actionableFindings }
}

// Before an unattended post: tick what the stricter gate allows and is still to post (autoPostIds), and untick the machine
// ticks the gate rejects (the drawer's 'auto' tick or an earlier round's 'engine' tick on a Low / noise-rated scope
// finding). A human's tick is left alone.
export function prepareUnattendedPost(db: any, schema: any, reviewId: string, nowIso: string): { ticked: number; unticked: number } {
  const rows = db.select().from(schema.findings).where(eq(schema.findings.reviewId, reviewId)).all() as any[]
  const rechecks = rows.length ? db.select().from(schema.findingRechecks).where(inArray(schema.findingRechecks.findingId, rows.map((f) => f.id))).all() as any[] : []
  const postable = new Set(autoPostIds(rows, rechecks))
  const tick = rows.filter((f) => isUnattendedAutomatable(f) && postable.has(f.id)).map((f) => f.id)
  const untick = rows
    .filter((f) => f.checked && (f.checkedBy === 'auto' || f.checkedBy === 'engine') && (f.tier != null || f.source != null) && !isUnattendedAutomatable(f))
    .map((f) => f.id)
  if (tick.length) {
    db.update(schema.findings)
      .set({ checked: true, checkedBy: sql`CASE WHEN ${schema.findings.checked} = 1 AND ${schema.findings.checkedBy} IS NOT NULL THEN ${schema.findings.checkedBy} ELSE 'engine' END`, checkedAt: nowIso })
      .where(inArray(schema.findings.id, tick)).run()
  }
  if (untick.length) {
    db.update(schema.findings).set({ checked: false, checkedBy: 'engine', checkedAt: nowIso }).where(inArray(schema.findings.id, untick)).run()
  }
  return { ticked: tick.length, unticked: untick.length }
}

// Which findings automation ticks before posting: automatable ones, minus those a re-review settled (fixed, replied,
// retracted) before they were ever posted — the author never saw them, so they are not announced as fixed either.
export function autoPostIds(findings: any[], rechecks: Array<{ findingId: string; round: number; status: string; stance?: string | null }>): string[] {
  const latest = new Map<string, { round: number; status: string; stance: string | null }>()
  for (const rc of rechecks) {
    const cur = latest.get(rc.findingId)
    if (!cur || rc.round > cur.round) latest.set(rc.findingId, { round: rc.round, status: rc.status, stance: rc.stance ?? null })
  }
  return findings.filter((f) => isAutomatable(f) && stillToPost(f, isRecheckResolved(latest.get(f.id)))).map((f) => f.id)
}
