import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { fetchMyReview, fetchPrDetail, fetchTimeline, getCurrentUserLogin } from '~core/github/gh'

// Timeline (main view): PR metadata + description + changed files + the full timeline (comments/reviews/commits/deployments…)
// The diff is not here (heavy, lazy-loaded — see diff.get.ts)
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const number = Number(getRouterParam(event, 'number'))
  if (!number) throw createError({ statusCode: 400, statusMessage: 'PR number 无效' })

  const d = db()
  const project = d.select().from(schema.projects).where(eq(schema.projects.id, id)).get()
  if (!project) throw createError({ statusCode: 404, statusMessage: '项目不存在' })

  try {
    const me = await getCurrentUserLogin().catch(() => '')
    const [detail, nodes, myReview] = await Promise.all([
      fetchPrDetail(project.repo, number),
      fetchTimeline(project.repo, number),
      // What the header's approve/withdraw button offers depends on the caller's own standing verdict, so it is read
      // with the rest of the drawer rather than behind a second round trip. A failure leaves the button on "approve".
      fetchMyReview(project.repo, number, me).catch(() => null),
    ])
    return { detail, nodes, myReview }
  } catch (e) {
    throw createError({ statusCode: 502, statusMessage: (e as Error).message })
  }
})
