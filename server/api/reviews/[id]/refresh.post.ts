import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { fetchPrState } from '~core/github/gh'
import { headMoved } from '~core/review/postGate'

// Refresh the PR's real state + head sha.
// If a comment was already posted (last_post_sha), compare against the current head → tell the frontend
// whether the author pushed again after the comment.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const d = db()
  const review = d.select().from(schema.reviews).where(eq(schema.reviews.id, id)).get()
  if (!review) throw createError({ statusCode: 404, statusMessage: 'review 不存在' })

  const project = d
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, review.projectId))
    .get()
  if (!project) throw createError({ statusCode: 404, statusMessage: '项目不存在' })

  const { state, headSha: liveHead, reviewDecision, author } = await fetchPrState(project.repo, review.prNumber)

  // The "author updated" baseline is the sha you last reviewed/re-reviewed (review.headSha), not the sha of
  // the last posted comment — otherwise the red dot never clears after a re-review (which moves headSha forward).
  // The gate uses headSha too (it no longer requires a comment to have been posted), matching what the
  // pulls.get list does: after the first review, any further push by the author flags "new changes I have not
  // seen". Note: do not overwrite review.headSha with the live head, or the baseline is lost and the line
  // anchors of posted comments drift.
  const authorUpdated = headMoved(review.headSha, liveHead)

  d.update(schema.reviews)
    // Also backfill an empty author (older rows missed it at creation time → the list shows "-")
    .set({ prState: state, reviewDecision: reviewDecision || null, authorUpdated, updatedAt: new Date().toISOString(), ...(review.author ? {} : { author: author || null }) })
    .where(eq(schema.reviews.id, id))
    .run()

  return { prState: state, reviewDecision, liveHead, reviewedSha: review.headSha, authorUpdated }
})
