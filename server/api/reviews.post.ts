import { nanoid } from 'nanoid'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { enqueueReview } from '~core/pipeline'
import { reviewQueue } from '~core/queue'
import { fetchPrMeta } from '~core/github/gh'
import { resolveLang } from '~core/agent/lang'
import { recordRoundInstruction, reviewHistoryRootFor } from '~core/agent/reviewHistory'

// Create review tasks straight from the entries ticked in "all PRs" (the metadata comes with the list, no extra gh call needed).
const Pull = z.object({
  number: z.number().int().positive(),
  title: z.string().optional(),
  author: z.string().optional(),
  branch: z.string().optional(),
  headSha: z.string().optional(),
  state: z.enum(['open', 'merged', 'closed', 'draft', 'unknown']).optional(),
  additions: z.number().optional(),
  deletions: z.number().optional(),
})
const Body = z.object({
  projectId: z.string().min(1),
  pulls: z.array(Pull).min(1),
  // Optional guidance typed before the first pass ever runs. Until now the first review was blind to intent: the
  // instruction box only fed re-reviews, so the only way to steer was to let it go wide once and correct afterwards.
  instruction: z.string().optional(),
})

export default defineEventHandler(async (event) => {
  const parsed = Body.safeParse(await readBody(event))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: parsed.error.issues.map((i) => i.message).join('; ') })
  }
  const { projectId, pulls } = parsed.data
  const instruction = (parsed.data.instruction || '').trim()
  const cfg = useRuntimeConfig()
  const d = db()

  const project = d.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()
  if (!project) throw createError({ statusCode: 404, statusMessage: '项目不存在' })

  const canAutoRun = !!project.localPath
  reviewQueue.setLimit(Number(cfg.maxConcurrency) || 3)
  const rc = resolveReviewConfig(d, project)
  const created: any[] = []
  const skipped: { number: number; reason: string }[] = []

  for (const p of pulls) {
    const exists = d
      .select()
      .from(schema.reviews)
      .where(and(eq(schema.reviews.projectId, projectId), eq(schema.reviews.prNumber, p.number)))
      .get()
    if (exists) {
      skipped.push({ number: p.number, reason: '已建任务' })
      continue
    }

    // Ticking entries in the list brings the full metadata; but the "PR detail drawer" only sends { number } → no branch.
    // In that case fill it in via GitHub (like fix.post.ts) rather than letting an empty branch
    // break further down on `git rev-parse origin/`.
    let meta = p
    if (!p.branch) {
      try {
        const m = await fetchPrMeta(project.repo, p.number)
        meta = {
          ...p,
          title: p.title ?? m.title,
          author: p.author ?? m.author, // this used to be missed when only {number} was sent → the list showed "-" as the author
          branch: m.branch,
          headSha: p.headSha ?? m.headSha,
          state: p.state ?? m.state,
          additions: p.additions ?? m.additions,
          deletions: p.deletions ?? m.deletions,
        }
      } catch (e) {
        skipped.push({ number: p.number, reason: `无法获取 PR 元数据：${(e as Error).message}` })
        continue
      }
    }
    if (!meta.branch) {
      skipped.push({ number: p.number, reason: 'PR 无可用分支（可能已删除）' })
      continue
    }

    const now = new Date().toISOString()
    const row = {
      id: nanoid(),
      projectId,
      prNumber: meta.number,
      prUrl: `https://github.com/${project.repo}/pull/${meta.number}`,
      title: meta.title ?? null,
      author: meta.author ?? null,
      branch: meta.branch,
      headSha: meta.headSha ?? null,
      status: 'queued' as const, // the engine hooks in on the second batch; for now just queue it
      reviewInstruction: instruction || null,
      prState: meta.state ?? 'unknown',
      additions: meta.additions ?? null,
      deletions: meta.deletions ?? null,
      createdAt: now,
      updatedAt: now,
    }
    d.insert(schema.reviews).values(row).run()
    // Round 0 of the instruction log: what was asked for before anything had been reviewed.
    recordRoundInstruction(d, schema, row.id, instruction, nanoid(), now)
    created.push(row)

    // Start the review automatically when a local path is set; otherwise leave it queued for the user to run manually after configuring one
    if (canAutoRun) {
      enqueueReview({
        db: d,
        schema,
        reviewId: row.id,
        repo: project.repo,
        prNumber: row.prNumber,
        branch: row.branch,
        defaultBranch: project.defaultBranch,
        localPath: project.localPath,
        methodology: rc.methodology,
        reposDir: cfg.reposDir as string,
        worktreeLocation: cfg.worktreeLocation as string,
        historyRoot: reviewHistoryRootFor(cfg.dbPath as string),
        provider: rc.provider,
        model: rc.model,
        effort: rc.effort,
        codexServiceTier: rc.codexServiceTier,
        lang: resolveLang(getCookie(event, 'mr-locale')),
        verifyBeforePost: !!project.verifyBeforePost,
        engineLevel: (project as any).reviewEngineLevel ?? null,
        instruction: instruction || null,
        projectId, skillId: rc.skillId, skillVersionId: rc.skillVersionId,
      })
    }
  }

  return { created, skipped }
})
