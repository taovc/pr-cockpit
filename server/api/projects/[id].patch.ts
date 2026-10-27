import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '~core/db/client'

const Body = z.object({
  name: z.string().min(1).optional(),
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/).optional(),
  localPath: z.string().nullable().optional(),
  defaultBranch: z.string().optional(),
  provider: z.enum(['claude', 'codex']).optional(),
  model: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
  codexServiceTier: z.enum(['fast']).nullable().optional(),
  activeSkillId: z.string().nullable().optional(),
  autoMaxRounds: z.number().int().min(1).max(10).optional(), // round cap for the automated "fix ↔ recheck" loop
  autoCooldownMinutes: z.number().int().min(0).max(120).optional(), // automation cooldown (minutes, 0 = no cooldown)
  verifyBeforePost: z.boolean().optional(), // second read-only pass that tries to refute each finding of a fresh review
  reviewEngineLevel: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(), // /code-review level of the review engine (Claude)
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const parsed = Body.safeParse(await readBody(event))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: parsed.error.issues.map((i) => i.message).join('; ') })
  }
  const patch: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(parsed.data)) if (v !== undefined) patch[k] = v
  if (Object.keys(patch).length) {
    db().update(schema.projects).set(patch).where(eq(schema.projects.id, id)).run()
  }
  return db().select().from(schema.projects).where(eq(schema.projects.id, id)).get()
})
