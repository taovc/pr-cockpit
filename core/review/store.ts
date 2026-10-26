import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'

// A fresh review replaces the AI findings: rated ones are copied to finding_labels first, hand-added misses stay and are
// renumbered after the new findings.
export function replaceFindings(tx: any, schema: any, o: { reviewId: string; headSha: string | null; rows: Array<Record<string, unknown>>; now: string }): void {
  const old = tx.select().from(schema.findings).where(eq(schema.findings.reviewId, o.reviewId)).all() as any[]
  for (const f of old) {
    if (f.source === 'human' || !f.rating) continue
    tx.insert(schema.findingLabels).values({
      id: nanoid(), reviewId: o.reviewId, headSha: o.headSha, fid: f.fid, severity: f.severity, title: f.title, location: f.location, problem: f.problem,
      tier: f.tier, verifyStatus: f.verifyStatus, source: f.source, rating: f.rating, ratedAt: f.ratedAt, createdAt: o.now,
    }).run()
  }
  for (const f of old) if (f.source !== 'human') tx.delete(schema.findings).where(eq(schema.findings.id, f.id)).run()
  o.rows.forEach((r, i) => {
    tx.insert(schema.findings).values({ checked: false, notes: null, ...r, id: nanoid(), reviewId: o.reviewId, fid: `F${i + 1}`, sortOrder: i, createdAt: o.now }).run()
  })
  old.filter((f) => f.source === 'human').forEach((f, i) => {
    tx.update(schema.findings).set({ fid: `F${o.rows.length + i + 1}`, sortOrder: o.rows.length + i }).where(eq(schema.findings.id, f.id)).run()
  })
}

// Re-review needs AI findings to re-review; a review holding only hand-added misses gets a first pass.
export function hasAiFindings(rows: Array<{ source?: string | null }>): boolean {
  return rows.some((f) => f.source !== 'human')
}
