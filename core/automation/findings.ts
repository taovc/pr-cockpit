import { eq, asc, inArray } from 'drizzle-orm'
import { isRecheckResolved } from '../recheckAxes'
import { isAutomatable } from './automatable'

export { isAutomatable }

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
  total: number // findings automation may post (0 = nothing to post)
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
    if (!isAutomatable(f)) return false
    if (f.tier == null && !ACTIONABLE_SEVERITY.has(f.severity)) return false
    const rc = latest.get(f.id)
    return !rc || !isRecheckResolved(rc) // never rechecked, or the latest round left it open → still to fix
  })
  return { total: findings.filter(isAutomatable).length, actionable: actionableFindings.length, actionableFindings }
}
