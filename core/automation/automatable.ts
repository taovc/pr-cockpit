// Scope-review findings (tier or source set): only "must" items the check confirmed; hand-added misses never. Older ones:
// anything not refuted.
export function isAutomatable(f: { tier?: string | null; source?: string | null; verifyStatus?: string | null; severity: string }): boolean {
  if (f.tier != null || f.source != null) return f.tier === 'must' && f.verifyStatus === 'confirmed' && f.source !== 'human'
  return f.verifyStatus !== 'refuted'
}

// What automation may post or fix with nobody watching: a scope finding must also be High/Medium and not rated noise or
// wrong by the reviewer. Older findings keep isAutomatable's rule.
export function isUnattendedAutomatable(f: { tier?: string | null; source?: string | null; verifyStatus?: string | null; severity: string; rating?: string | null }): boolean {
  if (!isAutomatable(f)) return false
  if (f.tier == null && f.source == null) return true
  return (f.severity === 'High' || f.severity === 'Medium') && f.rating !== 'noise' && f.rating !== 'wrong'
}
