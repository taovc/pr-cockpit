import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '~core/db/client'
import { dismissReview, fetchMyReview, fetchPrState, getCurrentUserLogin } from '~core/github/gh'

// Withdraw your own approval (the drawer header's second state). GitHub cannot delete a submitted review, so this
// dismisses it — the message is mandatory and lands on the PR timeline for everyone, which is why the UI offers to
// write one. Only ever your own review: the id is looked up from your login here rather than taken from the request.
const Body = z.object({ message: z.string().max(500).optional() })
const DEFAULT_MESSAGE = 'Approval withdrawn.'

export default defineEventHandler(async (event) => {
  const projectId = getRouterParam(event, 'id')!
  const prNumber = Number(getRouterParam(event, 'number'))
  if (!Number.isInteger(prNumber) || prNumber <= 0) throw createError({ statusCode: 400, statusMessage: 'PR 编号不合法', data: { reason: 'bad_number' } })
  const parsed = Body.safeParse((await readBody(event).catch(() => ({}))) || {})
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: '理由不合法', data: { reason: 'bad_message' } })
  const message = parsed.data.message?.trim() || DEFAULT_MESSAGE

  const d = db()
  const project = d.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()
  if (!project) throw createError({ statusCode: 404, statusMessage: '项目不存在', data: { reason: 'no_project' } })

  let mine: Awaited<ReturnType<typeof fetchMyReview>> = null
  let state: Awaited<ReturnType<typeof fetchPrState>>
  try {
    const me = await getCurrentUserLogin()
    ;[mine, state] = await Promise.all([fetchMyReview(project.repo, prNumber, me), fetchPrState(project.repo, prNumber)])
  } catch (e: any) {
    const detail: string = e?.stderr?.toString?.() || e?.message || String(e)
    throw createError({ statusCode: 502, statusMessage: `读取 review 失败：${detail.slice(0, 300)}`, data: { reason: 'gh', detail: detail.slice(0, 300) } })
  }
  // Already gone (dismissed elsewhere, or the drawer is stale) — nothing to withdraw, and saying so beats a 422.
  if (!mine || mine.state !== 'APPROVED') {
    throw createError({ statusCode: 409, statusMessage: '你当前没有生效的批准', data: { reason: 'no_approval' } })
  }
  // A merged or closed PR takes the call and changes nothing (GitHub answers 200 with the review untouched), so the
  // refusal has to be ours or the user is told the approval was withdrawn when it was not.
  if (state!.state !== 'open' && state!.state !== 'draft') {
    throw createError({ statusCode: 409, statusMessage: `PR 已经是 ${state!.state}，GitHub 不会再撤回这条批准`, data: { reason: 'not_open', state: state!.state } })
  }

  try {
    const after = await dismissReview(project.repo, prNumber, mine.id, message)
    // Same reason as above, for every case that is not the PR state: trust the outcome, not the status code.
    if (after.state && after.state === 'APPROVED') {
      throw createError({ statusCode: 502, statusMessage: 'GitHub 收下了请求但这条批准仍然生效', data: { reason: 'not_dismissed' } })
    }
  } catch (e: any) {
    if (e?.statusCode) throw e // our own refusal above, already shaped
    const detail: string = e?.stderr?.toString?.() || e?.message || String(e)
    // Dismissing needs admin rights, or membership of the branch protection's dismissal allow-list.
    if (/\b403\b/.test(detail) || /not authorized|must be a repository administrator/i.test(detail)) {
      throw createError({ statusCode: 403, statusMessage: '你没有 dismiss review 的权限（需要仓库管理员或在允许名单里）', data: { reason: 'forbidden' } })
    }
    throw createError({ statusCode: 502, statusMessage: `取消批准失败：${detail.slice(0, 300)}`, data: { reason: 'gh', detail: detail.slice(0, 300) } })
  }

  return { ok: true }
})
