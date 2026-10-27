import { eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '~core/db/client'
import { removeWorktree } from '~core/git/worktree'
import { snapshotRatings } from '~core/review/store'

// Clean up tasks by category: merged = PRs already merged; posted = those whose comment was already posted. The two are independent — the frontend has a separate button and a separate confirmation for each.
const Body = z.object({
  projectId: z.string().min(1),
  mode: z.enum(['merged', 'posted']),
})

export default defineEventHandler(async (event) => {
  const parsed = Body.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: '参数错误（需要 projectId + mode）' })
  const { projectId, mode } = parsed.data
  const cfg = useRuntimeConfig()
  const d = db()

  const project = d.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()
  const rows = d.select().from(schema.reviews).where(eq(schema.reviews.projectId, projectId)).all()
  const ids = rows
    .filter((r) => (mode === 'merged' ? r.prState === 'merged' : r.status === 'posted'))
    .map((r) => r.id)

  if (ids.length) {
    for (const rid of ids) await removeWorktree(project?.localPath ?? null, cfg.reposDir as string, rid, { location: cfg.worktreeLocation as string })
    const now = new Date().toISOString()
    d.transaction((tx: any) => {
      snapshotRatings(tx, schema, ids, now) // ratings stay as eval labels
      tx.delete(schema.reviews).where(inArray(schema.reviews.id, ids)).run()
    })
  }
  return { deleted: ids.length }
})
