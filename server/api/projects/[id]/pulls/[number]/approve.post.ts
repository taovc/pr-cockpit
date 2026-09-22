import { and, desc, eq, isNotNull } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { approvePr, fetchPrState, fetchReviewsCount, getCurrentUserLogin, isPendingReviewClash } from '~core/github/gh'

// Approve the PR as the logged-in gh user (the button in the PR drawer header). Outward-facing and visible to the
// whole repo, so the refusals GitHub would answer with anyway are checked here first and named: a PR that is merged or
// closed (the drawer can be minutes stale), and your own PR, which GitHub never lets you approve. Draft PRs are
// approvable on GitHub, so they are allowed here too. `reason` is what the UI translates; `detail` carries the raw gh
// text for the cases no sentence covers.
export default defineEventHandler(async (event) => {
  const projectId = getRouterParam(event, 'id')!
  const prNumber = Number(getRouterParam(event, 'number'))
  if (!Number.isInteger(prNumber) || prNumber <= 0) throw createError({ statusCode: 400, statusMessage: 'PR 编号不合法', data: { reason: 'bad_number' } })

  const d = db()
  const project = d.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()
  if (!project) throw createError({ statusCode: 404, statusMessage: '项目不存在', data: { reason: 'no_project' } })

  // The prechecks talk to gh too, so a gh failure here has to read like the ones below rather than escape as a 500.
  let state: Awaited<ReturnType<typeof fetchPrState>>
  let me = ''
  try {
    ;[state, me] = await Promise.all([
      fetchPrState(project.repo, prNumber),
      getCurrentUserLogin().catch(() => ''),
    ])
  } catch (e: any) {
    const detail: string = e?.stderr?.toString?.() || e?.message || String(e)
    throw createError({ statusCode: 502, statusMessage: `读取 PR 状态失败：${detail.slice(0, 300)}`, data: { reason: 'gh', detail: detail.slice(0, 300) } })
  }

  if (state.state !== 'open' && state.state !== 'draft') {
    throw createError({ statusCode: 409, statusMessage: `PR 当前是 ${state.state}，不能批准`, data: { reason: 'not_open', state: state.state } })
  }
  if (me && state.author && me.toLowerCase() === state.author.toLowerCase()) {
    throw createError({ statusCode: 422, statusMessage: 'GitHub 不允许批准自己提交的 PR', data: { reason: 'own_pr' } })
  }

  let url = ''
  try {
    ;({ url } = await approvePr(project.repo, prNumber))
  } catch (e: any) {
    const detail: string = e?.stderr?.toString?.() || e?.message || String(e)
    // The author check above needs a login on both sides; when gh cannot supply one, GitHub still answers this.
    if (/approve your own pull request/i.test(detail)) {
      throw createError({ statusCode: 422, statusMessage: 'GitHub 不允许批准自己提交的 PR', data: { reason: 'own_pr' } })
    }
    // A review the user is still writing on github.com. Theirs to submit or discard — we never delete it for them.
    if (isPendingReviewClash(detail)) {
      throw createError({ statusCode: 409, statusMessage: '你在 GitHub 上有一份未提交的 review，先提交或丢弃它再批准', data: { reason: 'pending_review' } })
    }
    throw createError({ statusCode: 502, statusMessage: `批准失败：${detail.slice(0, 300)}`, data: { reason: 'gh', detail: detail.slice(0, 300) } })
  }

  // Our own approval raises the PR's review count, which is the baseline the list uses for "the reviewer came back
  // after your fix" — without moving the baseline, approving lights that dot on our own doing.
  const fix = d.select({ id: schema.runs.id })
    .from(schema.runs)
    .where(and(eq(schema.runs.projectId, projectId), eq(schema.runs.prNumber, prNumber), isNotNull(schema.runs.reviewsAtPush)))
    .orderBy(desc(schema.runs.updatedAt))
    .get()
  if (fix) {
    const count = await fetchReviewsCount(project.repo, prNumber).catch(() => null)
    if (count != null) d.update(schema.runs).set({ reviewsAtPush: count, updatedAt: new Date().toISOString() }).where(eq(schema.runs.id, fix.id)).run()
  }

  return { ok: true, url }
})
