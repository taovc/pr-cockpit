import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { removeWorktree } from '~core/git/worktree'
import { optOutPr } from '~core/automation/state'
import { removeReviewHistory, reviewHistoryRootFor } from '~core/agent/reviewHistory'

// Delete a single review task: clean up its worktree at the same time (only the local task is deleted, GitHub comments are left alone)
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const cfg = useRuntimeConfig()
  const d = db()

  const review = d.select().from(schema.reviews).where(eq(schema.reviews.id, id)).get()
  if (review) {
    const project = d.select().from(schema.projects).where(eq(schema.projects.id, review.projectId)).get()
    await removeWorktree(project?.localPath ?? null, cfg.reposDir as string, id, { location: cfg.worktreeLocation as string })
    // Deleting the task means leaving automation: mark the PR opt-out so the project-level config can't resurrect it on the next round (until the user turns it back on by hand)
    optOutPr(d, schema, review.projectId, review.prNumber, new Date().toISOString())
  }
  d.delete(schema.reviews).where(eq(schema.reviews.id, id)).run()
  d.delete(schema.findingLabels).where(eq(schema.findingLabels.reviewId, id)).run() // its rating snapshots go with it
  removeReviewHistory(reviewHistoryRootFor(cfg.dbPath as string), id) // the prepared re-review history goes with the task
  return { ok: true }
})
