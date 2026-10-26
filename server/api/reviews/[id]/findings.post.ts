import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { schema } from '~core/db/client'

// A finding the reviewer adds by hand: something the review missed. It is a labelled miss for the eval set and can be
// posted like any other finding.
const Body = z.object({
  location: z.string().trim().max(300).default(''),
  title: z.string().trim().min(1).max(500),
  rating: z.enum(['must', 'later']).default('must'),
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const parsed = Body.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: '参数错误' })
  const d = db()
  if (!d.select().from(schema.reviews).where(eq(schema.reviews.id, id)).get()) throw createError({ statusCode: 404, statusMessage: 'review 不存在' })
  const existing = d.select().from(schema.findings).where(eq(schema.findings.reviewId, id)).all()
  const n = existing.reduce((m, f) => Math.max(m, parseInt(String(f.fid).replace(/\D/g, '')) || 0), 0) + 1
  const now = new Date().toISOString()
  const row = {
    id: nanoid(), reviewId: id, fid: `F${n}`, severity: 'Medium' as const, title: parsed.data.title, location: parsed.data.location || null,
    problem: null, detail: null, fix: null, introducedByPr: true, tier: parsed.data.rating, source: 'human' as const,
    rating: parsed.data.rating, ratedAt: now, checked: false, notes: null,
    sortOrder: existing.reduce((m, f) => Math.max(m, f.sortOrder), 0) + 1, createdAt: now,
  }
  d.insert(schema.findings).values(row).run()
  d.update(schema.reviews).set({ previewSig: null, updatedAt: now }).where(eq(schema.reviews.id, id)).run()
  return { ...row, rechecks: [] }
})
