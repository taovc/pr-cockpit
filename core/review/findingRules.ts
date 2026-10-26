// Re-review needs AI findings to re-review; a review holding only hand-added misses gets a first pass.
export function hasAiFindings(rows: Array<{ source?: string | null }>): boolean {
  return rows.some((f) => f.source !== 'human')
}
