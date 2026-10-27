import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { schema } from '~core/db/client'
import { REVIEW_INFLIGHT } from '~core/automation/decide'
import { maxFidNumber } from '~core/review/findingRules'

// A missed issue the reviewer adds by hand: posted like any other finding, kept when a fresh review replaces the rest.
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
  const review = d.select().from(schema.reviews).where(eq(schema.reviews.id, id)).get()
  if (!review) throw createError({ statusCode: 404, statusMessage: 'review 不存在' })
  if (REVIEW_INFLIGHT.includes(review.status)) {
    throw createError({ statusCode: 409, statusMessage: `当前状态（${review.status}）不能补漏报，请等任务完成` })
  }
  const existing = d.select().from(schema.findings).where(eq(schema.findings.reviewId, id)).all()
  const n = maxFidNumber(existing) + 1
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
