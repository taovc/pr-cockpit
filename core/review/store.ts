import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import { pickByLang } from '../agent/lang'

function insertLabel(tx: any, schema: any, f: any, at: { reviewId: string; repo: string | null; prNumber: number | null; headSha: string | null; now: string }): void {
  tx.insert(schema.findingLabels).values({
    id: nanoid(), reviewId: at.reviewId, repo: at.repo, prNumber: at.prNumber, headSha: at.headSha, fid: f.fid, severity: f.severity, title: f.title, location: f.location, problem: f.problem,
    tier: f.tier, verifyStatus: f.verifyStatus, source: f.source, rating: f.rating, ratedAt: f.ratedAt, createdAt: at.now,
  }).run()
}

function prOf(tx: any, schema: any, reviewId: string): { repo: string | null; prNumber: number | null } {
  const r = tx.select({ prNumber: schema.reviews.prNumber, repo: schema.projects.repo }).from(schema.reviews)
    .leftJoin(schema.projects, eq(schema.projects.id, schema.reviews.projectId)).where(eq(schema.reviews.id, reviewId)).get()
  return { repo: r?.repo ?? null, prNumber: r?.prNumber ?? null }
}

// A fresh review replaces the AI findings: rated ones are copied to finding_labels first, hand-added misses stay and are
// renumbered after the new findings.
export function replaceFindings(tx: any, schema: any, o: { reviewId: string; headSha: string | null; rows: Array<Record<string, unknown>>; now: string }): void {
  const old = tx.select().from(schema.findings).where(eq(schema.findings.reviewId, o.reviewId)).all() as any[]
  const pr = prOf(tx, schema, o.reviewId)
  for (const f of old) {
    if (f.source === 'human' || !f.rating) continue
    insertLabel(tx, schema, f, { reviewId: o.reviewId, ...pr, headSha: o.headSha, now: o.now })
  }
  for (const f of old) if (f.source !== 'human') tx.delete(schema.findings).where(eq(schema.findings.id, f.id)).run()
  o.rows.forEach((r, i) => {
    tx.insert(schema.findings).values({ checked: false, notes: null, ...r, id: nanoid(), reviewId: o.reviewId, fid: `F${i + 1}`, sortOrder: i, createdAt: o.now }).run()
  })
  old.filter((f) => f.source === 'human').forEach((f, i) => {
    tx.update(schema.findings).set({ fid: `F${o.rows.length + i + 1}`, sortOrder: o.rows.length + i }).where(eq(schema.findings.id, f.id)).run()
  })
}

// Before reviews are cleaned up or their project deleted: rated findings and hand-added misses become labels.
export function snapshotRatings(tx: any, schema: any, reviewIds: string[], now: string): number {
  let n = 0
  for (const id of reviewIds) {
    const review = tx.select({ headSha: schema.reviews.headSha }).from(schema.reviews).where(eq(schema.reviews.id, id)).get()
    if (!review) continue
    const pr = prOf(tx, schema, id)
    const rows = tx.select().from(schema.findings).where(eq(schema.findings.reviewId, id)).all() as any[]
    for (const f of rows) {
      if (!f.rating && f.source !== 'human') continue
      insertLabel(tx, schema, f, { reviewId: id, ...pr, headSha: review.headSha ?? null, now })
      n++
    }
  }
  return n
}

const ADJUSTED_NOTE = { zh: '复审时改写过，未重新核对', en: 'Reworded by a re-review, not checked again', fr: 'Reformulé par une re-revue, non revérifié' }

// 'adjusted' on re-review: the new wording replaces the old. A scope finding becomes "unsure" and loses a machine tick
// until a human looks; a refuted one stays refuted; an older finding drops its verdict.
export function adjustedPatch(
  old: { tier?: string | null; source?: string | null; verifyStatus?: string | null; checked?: boolean | null; checkedBy?: string | null },
  r: Record<string, unknown>,
  lang?: string | null,
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {}
  for (const k of ['severity', 'title', 'location', 'problem', 'detail', 'fix'] as const) {
    const v = r[k]
    if (typeof v === 'string' && v.trim()) patch[k] = v
  }
  if (!Object.keys(patch).length) return null
  if (old.tier == null && old.source == null) return { ...patch, verifyStatus: null, verifyNote: null }
  if (old.verifyStatus === 'refuted') return patch
  const machineTick = !!old.checked && (old.checkedBy === 'auto' || old.checkedBy === 'engine')
  return { ...patch, verifyStatus: 'unsure', verifyNote: pickByLang(lang, ADJUSTED_NOTE), ...(machineTick ? { checked: false, checkedBy: null, checkedAt: null } : {}) }
}
