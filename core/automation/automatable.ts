// Scope-review findings (tier or source set): only "must" items the check confirmed; hand-added misses never. Older ones:
// anything not refuted.
export function isAutomatable(f: { tier?: string | null; source?: string | null; verifyStatus?: string | null; severity: string }): boolean {
  if (f.tier != null || f.source != null) return f.tier === 'must' && f.verifyStatus === 'confirmed' && f.source !== 'human'
  return f.verifyStatus !== 'refuted'
}
