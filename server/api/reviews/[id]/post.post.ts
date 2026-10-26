import { nanoid } from 'nanoid'
import { createHash } from 'node:crypto'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '~core/db/client'
import { assembleReview, languageHold, postReview, type PostFinding } from '~core/github/post'
import { fetchPrDiff } from '~core/github/gh'

// Publish the review comment. dryRun=true only returns the assembled preview (the default); only dryRun=false actually posts to GitHub.
// The preview is cached by an "input signature": if the signature is unchanged it is reused as-is without re-translating; publishing reuses the preview too, so it never runs twice.
const Body = z.object({
  dryRun: z.boolean().default(true).catch(true),
  force: z.boolean().default(false).catch(false),
  acceptLangWarnings: z.boolean().default(false).catch(false), // set by the UI after the user saw the preview
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const { dryRun, force, acceptLangWarnings } = Body.parse((await readBody(event)) || {})
  const d = db()

  const review = d.select().from(schema.reviews).where(eq(schema.reviews.id, id)).get()
  if (!review) throw createError({ statusCode: 404, statusMessage: 'review 不存在' })
  // While the task is running (cloning/reviewing/rechecking) or already publishing (posting), publishing/previewing is not allowed, to avoid racing the job that is writing findings over the same data.
  // Allowed: draft / ready_to_post / posted (post again) / error.
  if (['queued', 'cloning', 'reviewing', 'recheck_requested', 'rechecking', 'posting'].includes(review.status)) {
    throw createError({ statusCode: 409, statusMessage: `当前状态（${review.status}）不能发布评论，请等任务完成` })
  }
  const project = d.select().from(schema.projects).where(eq(schema.projects.id, review.projectId)).get()
  if (!project) throw createError({ statusCode: 404, statusMessage: '项目不存在' })

  // Real publish (not a preview): **claim atomically** before any await — CAS the row from a postable status straight to
  // 'posting', holding the whole assemble(translate)+publish window (a few seconds). better-sqlite3 runs synchronously and
  // the claim happens before every await → of two concurrent publishers only one gets changes===1; 'posting' is already part
  // of the in-flight checks in run/recheck/the engine/this endpoint → reruns/rechecks/re-posts during that window are all blocked.
  // Rules out "posting twice / posting stale deleted findings / status overwritten by a concurrent write". A preview (dryRun) does not claim.
  const prevStatus = review.status
  if (!dryRun) {
    const claimed = d.update(schema.reviews)
      .set({ status: 'posting', updatedAt: new Date().toISOString() })
      .where(and(eq(schema.reviews.id, id), inArray(schema.reviews.status, ['draft', 'ready_to_post', 'posted', 'error'])))
      .run()
    if (claimed.changes !== 1) throw createError({ statusCode: 409, statusMessage: '评论正在发布中或状态已变化，请稍后再试' })
  }
  // Any failure / no content after the claim → restore the pre-claim status, so the row is not stuck in 'posting' forever.
  const restore = () => {
    if (dryRun) return
    d.update(schema.reviews).set({ status: prevStatus, updatedAt: new Date().toISOString() })
      .where(and(eq(schema.reviews.id, id), eq(schema.reviews.status, 'posting'))).run()
  }

  try {
    const checked = d
      .select()
      .from(schema.findings)
      .where(and(eq(schema.findings.reviewId, id), eq(schema.findings.checked, true)))
      .orderBy(asc(schema.findings.sortOrder))
      .all()
    if (!checked.length) {
      throw createError({ statusCode: 400, statusMessage: '没有勾选任何 finding，不发空评论' })
    }

    // Latest recheck verdict for each checked finding (decides how it is posted: fixed → one summary line / partial → only state what is still missing / reply-only → respond again per the note, or skip)
    const checkedIds = checked.map((f) => f.id)
    const rcs = d.select().from(schema.findingRechecks).where(inArray(schema.findingRechecks.findingId, checkedIds)).all()
    const latestRc = new Map<string, { status: string; stance: string | null; text: string | null; round: number }>()
    for (const rc of rcs) {
      const cur = latestRc.get(rc.findingId)
      if (!cur || rc.round > cur.round) latestRc.set(rc.findingId, { status: rc.status, stance: rc.stance ?? null, text: rc.text, round: rc.round })
    }

    const findings: PostFinding[] = checked.map((f) => {
      const rc = latestRc.get(f.id)
      return {
        fid: f.fid, severity: f.severity as any, title: f.title, location: f.location,
        problem: f.problem, detail: f.detail, fix: f.fix, notes: f.notes, introducedByPr: f.introducedByPr,
        recheck: rc ? { status: rc.status, stance: rc.stance, text: rc.text } : null,
      }
    })

    // Input signature: checked finding contents + recheck verdicts + global notes + headSha (affects line-level mapping). Only regenerate when it changes.
    const rc = resolveReviewConfig(d, project)
    const sig = createHash('sha256')
      .update(JSON.stringify({
        gn: review.globalNotes || '',
        sha: review.headSha || '',
        provider: rc.provider,
        model: rc.translateModel,
        effort: rc.translateEffort,
        codexServiceTier: rc.codexServiceTier || '',
        f: findings.map((f) => [f.fid, f.severity, f.title, f.problem, f.detail, f.fix, f.notes, f.location, f.introducedByPr, f.recheck?.status || '', f.recheck?.text || '']),
      }))
      .digest('hex')

    let assembled: any
    const cached = !force && review.previewSig === sig && review.previewJson ? JSON.parse(review.previewJson) : null
    // Failed translations are retried by a preview and by an unattended publish; a publish the user confirmed after the
    // preview posts exactly what the preview showed.
    const usedCache = !!cached && !((dryRun || !acceptLangWarnings) && cached.warnings?.some((w: any) => w.kind === 'failed'))
    if (usedCache) {
      assembled = cached
    } else {
      const { diff } = await fetchPrDiff(project.repo, review.prNumber)
      // Translation follows the project's provider (never mixed) and its configured model, at a low reasoning effort.
      assembled = await assembleReview({
        provider: rc.provider,
        model: rc.translateModel,
        effort: rc.translateEffort,
        codexServiceTier: rc.codexServiceTier,
        cwd: project.localPath || undefined,
        findings,
        globalNotes: review.globalNotes || '',
        diff,
      })
      d.update(schema.reviews)
        .set({ previewJson: JSON.stringify(assembled), previewSig: sig, updatedAt: new Date().toISOString() })
        .where(eq(schema.reviews.id, id))
        .run()
    }

    if (dryRun) return { dryRun: true, assembled, cached: usedCache }

    // The user's acceptance covers the preview they saw: a publish that re-assembled is checked again.
    const hold = languageHold(assembled.warnings, acceptLangWarnings && usedCache)
    if (hold) throw createError({ statusCode: 422, statusMessage: hold })

    // Every checked item was filtered out by its recheck status (reply-only with no response / retracted) → nothing left to post, don't post an empty review
    if (!assembled.comments.length && !String(assembled.body || '').trim()) {
      throw createError({ statusCode: 400, statusMessage: '勾选的 finding 都按复审状态跳过了（仅回复未写回应 note / 已撤回），没有可发内容' })
    }

    const headSha = review.headSha || ''
    const { url } = await postReview({ repo: project.repo, prNumber: review.prNumber, headSha, assembled })

    const now = new Date().toISOString()
    const round = d.select().from(schema.posts).where(eq(schema.posts.reviewId, id)).all().length + 1
    const postId = nanoid()
    d.insert(schema.posts).values({
      id: postId, reviewId: id, round, url, sha: headSha, mode: assembled.mode, body: assembled.body, at: now,
    }).run()
    // Which post each checked finding went out with (publish yield / "posted then retracted" metrics) — minus the ones the
    // assembler skipped because of their recheck status (they never reached GitHub).
    const skippedFids = new Set<string>((assembled.skipped ?? []).map((s: any) => String(s.fid)))
    const postedIds = checked.filter((f) => !skippedFids.has(f.fid)).map((f) => f.id)
    if (postedIds.length) d.update(schema.findings).set({ postedPostId: postId }).where(inArray(schema.findings.id, postedIds)).run()
    // The claimed 'posting' → 'posted' (wrap-up). Since 'posting' was held for the whole window, we can settle it directly here.
    d.update(schema.reviews)
      .set({ status: 'posted', lastPostSha: headSha, lastPostUrl: url, authorUpdated: false, updatedAt: now })
      .where(eq(schema.reviews.id, id))
      .run()
    d.insert(schema.events).values({ id: nanoid(), reviewId: id, ts: now, kind: 'posted', message: url }).run()

    return { dryRun: false, url, mode: assembled.mode }
  } catch (e) {
    restore()
    throw e
  }
})
