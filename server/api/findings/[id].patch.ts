import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '~core/db/client'

// Edit a single finding: tick "post to PR comment" / write notes.
// checkedBy records who decided the checkbox: 'human' (the reviewer clicked, the default) or 'auto' (the drawer's
// recheck-status adjustment). Precision metrics only count human decisions.
const Body = z.object({
  checked: z.boolean().optional(),
  checkedBy: z.enum(['human', 'auto']).optional(),
  notes: z.string().optional(),
  rating: z.enum(['must', 'later', 'noise', 'wrong']).nullable().optional(), // the reviewer's value rating (null clears it)
  evidence: z.enum(['inferred', 'ci', 'preview', 'github']).optional(), // the reviewer marks what they saw in a preview
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const parsed = Body.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: '参数错误' })

  const patch: Record<string, unknown> = {}
  if (parsed.data.checked !== undefined) {
    const by = parsed.data.checkedBy ?? 'human'
    const ts = new Date().toISOString()
    patch.checked = parsed.data.checked
    patch.checkedBy = by
    patch.checkedAt = ts
    // Sticky acceptance: only a human sets or clears it; the drawer's auto-adjust must never erase a human's decision.
    if (by === 'human') patch.humanAcceptedAt = parsed.data.checked ? ts : null
  }
  if (parsed.data.notes !== undefined) patch.notes = parsed.data.notes
  if (parsed.data.evidence !== undefined) patch.evidence = parsed.data.evidence
  if (parsed.data.rating !== undefined) { patch.rating = parsed.data.rating; patch.ratedAt = parsed.data.rating ? new Date().toISOString() : null }
  if (Object.keys(patch).length) {
    const d = db()
    const row = d.select().from(schema.findings).where(eq(schema.findings.id, id)).get()
    d.update(schema.findings).set(patch).where(eq(schema.findings.id, id)).run()
    // A changed checkbox / note changes what gets posted → invalidate the preview cache; a rating or evidence mark does not
    const posted = parsed.data.checked !== undefined || parsed.data.notes !== undefined
    if (row) d.update(schema.reviews).set({ ...(posted ? { previewSig: null } : {}), updatedAt: new Date().toISOString() }).where(eq(schema.reviews.id, (row as any).reviewId)).run()
  }
  return { ok: true }
})
