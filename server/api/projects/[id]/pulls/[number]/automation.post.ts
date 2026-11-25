import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { upsertPrAutomation, getPrAutomationRow } from '~core/automation/state'

// Per-PR automation switch overrides (the two switches in the PR drawer: auto review / auto fix).
// Turning either switch on (set to true) = re-enabling the feature → clears round/note/optOut/pendingFix
// (user's call: every re-enable runs maxRounds rounds again).
// Turning it off only sets the switch to false (does not affect a run in flight; the engine stops after
// it finishes). Passing null for reviewOn/fixOn goes back to "inherit the project config".
const Body = z.object({
  reviewOn: z.boolean().nullable().optional(),
  fixOn: z.boolean().nullable().optional(),
})

export default defineEventHandler(async (event) => {
  const projectId = getRouterParam(event, 'id')!
  const prNumber = Number(getRouterParam(event, 'number'))
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'PR 编号不合法' })
  }
  const parsed = Body.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'reviewOn/fixOn 不合法' })
  const { reviewOn, fixOn } = parsed.data

  const d = db()
  const project = d.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()
  if (!project) throw createError({ statusCode: 404, statusMessage: '项目不存在' })

  const patch: Record<string, unknown> = {}
  let enabling = false
  if (reviewOn !== undefined) { patch.reviewOn = reviewOn; if (reviewOn === true) enabling = true }
  if (fixOn !== undefined) { patch.fixOn = fixOn; if (fixOn === true) enabling = true }
  // Re-enabling → reset the round count and the stop marker, and lift the opt-out (let the engine take
  // this PR back over).
  // Key point: lastFixReviewSha must be cleared too — otherwise decide's dedup gate (no repeat fix for the
  // same review head) blocks the first fix after re-enabling, defeating "re-enable runs maxRounds rounds again".
  if (enabling) {
    patch.round = 0
    patch.note = null
    patch.optOut = false
    patch.pendingFix = false
    patch.lastFixReviewSha = null
    patch.postHeld = false // the hold's note is cleared above; a hold left behind would stop auto posting with no sign of why
  }

  upsertPrAutomation(d, schema, projectId, prNumber, patch, new Date().toISOString())
  return getPrAutomationRow(d, schema, projectId, prNumber)
})
