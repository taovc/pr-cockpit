// Re-review needs AI findings to re-review; a review holding only hand-added misses gets a first pass.
export function hasAiFindings(rows: Array<{ source?: string | null }>): boolean {
  return rows.some((f) => f.source !== 'human')
}

// Highest F<n> number among a review's findings (0 when none); new findings continue from it.
export function maxFidNumber(rows: Array<{ fid: string | null }>): number {
  return rows.reduce((m, f) => Math.max(m, parseInt(String(f.fid).replace(/\D/g, '')) || 0), 0)
}
