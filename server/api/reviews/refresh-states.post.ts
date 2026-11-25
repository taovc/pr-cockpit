import { eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '~core/db/client'
import { fetchPrState } from '~core/github/gh'
import { headMoved } from '~core/review/postGate'

// Bulk-refresh the GitHub-side state of several tasks (prState / reviewDecision / authorUpdated).
// The frontend polls this roughly every 60s, passing only the ids of the current page's unfinished (not merged/closed) tasks.
// Concurrency capped at 4 so we don't spawn a pile of gh processes at once. One failure doesn't affect the others.
const Body = z.object({ ids: z.array(z.string()).max(50).default([]) })

export default defineEventHandler(async (event) => {
  const { ids } = Body.parse((await readBody(event)) || {})
  if (!ids.length) return { refreshed: 0 }
  const d = db()

  const rows = d.select().from(schema.reviews).where(inArray(schema.reviews.id, ids)).all()
  const projCache = new Map<string, any>()
  const getProject = (pid: string) => {
    if (!projCache.has(pid)) {
      projCache.set(pid, d.select().from(schema.projects).where(eq(schema.projects.id, pid)).get())
    }
    return projCache.get(pid)
  }

  let refreshed = 0
  let i = 0
  const worker = async () => {
    while (i < rows.length) {
      const review = rows[i++]
      if (!review) continue
      const project = getProject(review.projectId)
      if (!project) continue
      try {
        const { state, headSha: liveHead, reviewDecision, author } = await fetchPrState(project.repo, review.prNumber)
        // Same baseline as the single-task refresh and the pulls.get list: compare against "the sha the last review/recheck saw" (headSha); gating uses headSha too
        const authorUpdated = headMoved(review.headSha, liveHead)
        d.update(schema.reviews)
          // Also backfill an empty author (older records didn't store it at creation time → the list shows "-")
          .set({ prState: state, reviewDecision: reviewDecision || null, authorUpdated, updatedAt: new Date().toISOString(), ...(review.author ? {} : { author: author || null }) })
          .where(eq(schema.reviews.id, review.id))
          .run()
        refreshed++
      } catch {
        /* skip on a single failure */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, rows.length) }, worker))
  return { refreshed }
})
