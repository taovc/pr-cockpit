import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { enqueueRecheck, enqueueReview } from '~core/pipeline'
import { reviewQueue } from '~core/queue'
import { fetchPrMeta } from '~core/github/gh'
import { resolveLang } from '~core/agent/lang'
import { recordRoundInstruction, reviewHistoryRootFor } from '~core/agent/reviewHistory'
import { nanoid } from 'nanoid'
import { hasAiFindings } from '~core/review/findingRules'

// Trigger a re-review (the author pushed again after our comment and we want the AI to check whether it was fixed)
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const cfg = useRuntimeConfig()
  const d = db()

  const review = d.select().from(schema.reviews).where(eq(schema.reviews.id, id)).get()
  if (!review) throw createError({ statusCode: 404, statusMessage: 'review 不存在' })
  if (['queued', 'cloning', 'reviewing', 'recheck_requested', 'rechecking', 'posting'].includes(review.status)) {
    throw createError({ statusCode: 409, statusMessage: '该任务正在处理中，请等它完成再操作' })
  }
  const project = d.select().from(schema.projects).where(eq(schema.projects.id, review.projectId)).get()
  if (!project) throw createError({ statusCode: 404, statusMessage: '项目不存在' })
  if (!project.localPath) throw createError({ statusCode: 400, statusMessage: '项目未配置本地 clone 路径' })

  // Task without a branch (created via the drawer) → resolve it through GitHub and persist it before re-running.
  let branch = review.branch
  if (!branch) {
    try {
      branch = (await fetchPrMeta(project.repo, review.prNumber)).branch
    } catch (e) {
      throw createError({ statusCode: 502, statusMessage: (e as Error).message })
    }
    if (!branch) throw createError({ statusCode: 400, statusMessage: '无法获取 PR 分支（可能已删除）' })
    d.update(schema.reviews).set({ branch, updatedAt: new Date().toISOString() }).where(eq(schema.reviews.id, id)).run()
  }

  if (review.reviewInstruction) recordRoundInstruction(d, schema, id, review.reviewInstruction, nanoid(), new Date().toISOString())

  // No AI findings yet (a clean review, or only hand-added misses): there is nothing to re-review, so this is a first pass.
  const firstPass = !hasAiFindings(d.select().from(schema.findings).where(eq(schema.findings.reviewId, id)).all())
  const status = firstPass ? 'queued' : 'recheck_requested'
  reviewQueue.setLimit(Number(cfg.maxConcurrency) || 3)
  // Clear the previous round's error when re-entering a re-review (it may have been restarted from the error state)
  d.update(schema.reviews).set({ status, error: null, updatedAt: new Date().toISOString() }).where(eq(schema.reviews.id, id)).run()

  const rc = resolveReviewConfig(d, project)
  const enqueue = firstPass ? enqueueReview : enqueueRecheck
  enqueue({
    db: d, schema, reviewId: id,
    repo: project.repo, prNumber: review.prNumber, branch,
    defaultBranch: project.defaultBranch, localPath: project.localPath,
    methodology: rc.methodology,
    historyRoot: reviewHistoryRootFor(cfg.dbPath as string),
    reposDir: cfg.reposDir as string, worktreeLocation: cfg.worktreeLocation as string, provider: rc.provider, model: rc.model, effort: rc.effort, codexServiceTier: rc.codexServiceTier, lang: resolveLang(getCookie(event, 'mr-locale')),
    verifyBeforePost: !!project.verifyBeforePost,
    engineLevel: (project as any).reviewEngineLevel ?? null,
    projectId: project.id, skillId: rc.skillId, skillVersionId: rc.skillVersionId,
  })
  return { ok: true, status }
})
