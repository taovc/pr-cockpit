import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import { reviewQueue } from './queue'
import { cockpitBus } from './events'
import { prepareWorktree } from './git/worktree'
import { fetchPrMergeable, fetchReviewComments, fetchTimeline } from './github/gh'
import { claudeReviewRunner } from './agent/claudeRunners'
import { codexReviewRunner } from './agent/codexReview'
import { runVerifyAgent, verdictMap } from './agent/verify'
import { pickByLang } from './agent/lang'
import { createRun, finishRun, recordRunUsage } from './runs/store'
import { formatUsageLabel } from './runs/format'
import type { ReviewProvider, ReviewRunner } from './agent/runners'
import { reviewAborts } from './agent/reviewAborts'
import { failedJobUsage, usageOfError } from './agent/claudeRun'
import { projectDirNameFor } from './host/options'
import { mergeUsage } from './agent/usage'
import { classifyFindings, runScopeReview, withFailedStages, type FailedStage, type StageRunner } from './review/scope'
import type { FindingRow, RawFinding } from './review/assemble'
import { contextDocPath } from './review/context'
import { existsSync } from 'node:fs'
import { engineLevelOf } from './review/engine'
import { adjustedPatch, replaceFindings } from './review/store'
import { maxFidNumber } from './review/findingRules'
import { fixedUncheck, fixingCommit, pathOfLocation } from './review/postGate'
import type { ProviderUsage } from './runs/types'
import {
  ROUND_EVENT, buildFindingIndex, buildHistoryDoc, computeRoundIntent, loadFindingHistory, writeReviewHistory,
} from './agent/reviewHistory'

export function selectReviewRunner(provider?: ReviewProvider): ReviewRunner {
  return provider === 'codex' ? codexReviewRunner : claudeReviewRunner
}

// The synthetic merge-conflict finding is stored in the DB, shown in the UI, and later fed back as a prompt to
// comment posting and auto-fix, so it must match this review's working language. The conflict markers
// <<<<<<< / ======= / >>>>>>> stay as-is in all three languages.
const CONFLICT_FINDING = {
  zh: {
    title: '解决与目标分支的合并冲突',
    problem: '该 PR 与目标分支存在合并冲突，当前无法干净合并。',
    fix: '把目标分支 merge/rebase 进来并解决所有冲突标记（<<<<<<< / ======= / >>>>>>>）。',
    stage: '检测到合并冲突，已加入需解决项',
  },
  en: {
    title: 'Resolve merge conflicts with the base branch',
    problem: 'This PR has merge conflicts with its base branch and cannot be merged as-is.',
    fix: 'Merge/rebase the base branch in and resolve all conflict markers (<<<<<<< / ======= / >>>>>>>).',
    stage: 'Merge conflicts detected, added as a finding',
  },
  fr: {
    title: 'Résoudre les conflits de fusion avec la branche cible',
    problem: 'Cette PR est en conflit avec sa branche cible et ne peut pas être fusionnée telle quelle.',
    fix: 'Fusionner/rebaser la branche cible puis résoudre tous les marqueurs de conflit (<<<<<<< / ======= / >>>>>>>).',
    stage: 'Conflits de fusion détectés, ajoutés comme point à traiter',
  },
}

// Don't import the db client here, so core doesn't depend on the runtime; the caller injects db + tables + config.
export type ReviewJobCtx = {
  db: any
  schema: any
  reviewId: string
  repo: string
  prNumber: number
  branch: string
  defaultBranch: string
  localPath: string | null
  methodology: string // the resolved methodology (active skill or default)
  reposDir: string
  worktreeLocation?: string | null
  historyRoot: string // where prepared re-review history lives (reviewHistoryRootFor(cfg.dbPath))
  provider?: ReviewProvider
  model: string // the actual model of the current provider (never mixed)
  effort: string
  codexServiceTier?: string | null
  lang?: string // working language of the AI output (UI locale); defaults to zh to preserve the old behavior
  instruction?: string | null // what the reviewer typed before this pass (fresh review); re-reviews read theirs from the event log
  // Observability: attribute the run to a project and to the exact skill version that ran (both optional for old callers).
  projectId?: string | null
  skillId?: string | null
  skillVersionId?: string | null
  verifyBeforePost?: boolean // fresh reviews: run the refute pass and store a verdict per finding (Codex path only)
  engineLevel?: string | null // /code-review level of the scope-review engine (Claude path)
}

type VerifyCounts = { confirmed: number; refuted: number; unsure: number }
const VERIFY_STAGE = {
  zh: { start: '发前验证：第二遍尝试反驳每条 finding…', done: (c: VerifyCounts) => `验证完成：确认 ${c.confirmed} · 反驳 ${c.refuted} · 不确定 ${c.unsure}`, failed: (m: string) => `验证失败（findings 保留，未标注）：${m}` },
  en: { start: 'Verify before post: a second pass tries to refute each finding…', done: (c: VerifyCounts) => `Verified: ${c.confirmed} confirmed · ${c.refuted} refuted · ${c.unsure} unsure`, failed: (m: string) => `Verify failed (findings kept, unlabelled): ${m}` },
  fr: { start: 'Vérification avant publication : une seconde passe tente de réfuter chaque finding…', done: (c: VerifyCounts) => `Vérifié : ${c.confirmed} confirmés · ${c.refuted} réfutés · ${c.unsure} incertains`, failed: (m: string) => `Vérification échouée (findings conservés, non annotés) : ${m}` },
}

// The review's own total: every stage's usage, timed by the wall clock (engine and project pass run in parallel).
function stageTotal(usages: Array<ProviderUsage | null>, t0: number): ProviderUsage | null {
  const u = mergeUsage(usages)
  return u ? { ...u, durationMs: Date.now() - t0 } : null
}

// One runs row per scope-review stage, with its usage recorded even when the stage fails.
function stageRunner(ctx: ReviewJobCtx, review: any, workspacePath: string, abort: AbortController, usages: Array<ProviderUsage | null>): StageRunner {
  const { db, schema, reviewId } = ctx
  return async (subkind, fn) => {
    const sid = createRun(db, schema, {
      kind: 'review', subkind, provider: 'claude', projectId: ctx.projectId ?? review?.projectId ?? null, reviewId, workspaceType: 'pr_worktree', workspacePath,
      prNumber: ctx.prNumber, branch: ctx.branch, model: ctx.model, effort: ctx.effort, lang: ctx.lang ?? null, title: review?.title ?? null,
    })
    try {
      const r = await fn()
      recordRunUsage(db, schema, sid, r.usage); usages.push(r.usage)
      finishRun(db, schema, sid, { status: 'done' })
      return r
    } catch (e) {
      const u = usageOfError(e)
      recordRunUsage(db, schema, sid, u); usages.push(u)
      finishRun(db, schema, sid, { status: abort.signal.aborted ? 'stopped' : 'error', error: (e as Error).message })
      throw e
    }
  }
}

export function enqueueReview(ctx: ReviewJobCtx) {
  reviewQueue.add(() => runReviewJob(ctx))
}

export function enqueueRecheck(ctx: ReviewJobCtx) {
  reviewQueue.add(() => runRecheckJob(ctx))
}

async function runReviewJob(ctx: ReviewJobCtx) {
  const { db, schema, reviewId } = ctx
  const now = () => new Date().toISOString()

  const emit = (kind: string, message?: string) => {
    const ts = now()
    cockpitBus.emit({ reviewId, ts, kind, message })
    try {
      db.insert(schema.events).values({ id: nanoid(), reviewId, ts, kind, message: message ?? null }).run()
    } catch {
      /* failing to persist the event doesn't affect the main flow */
    }
  }
  const setStatus = (status: string, extra: Record<string, unknown> = {}) => {
    db.update(schema.reviews).set({ status, updatedAt: now(), ...extra }).where(eq(schema.reviews.id, reviewId)).run()
    cockpitBus.emit({ reviewId, ts: now(), kind: 'status', message: status })
  }
  // Consistency gate: if the task was deleted, drop the result instead of writing it back (stops a task deleted during a network hiccup from being resurrected)
  const taskGone = () => !db.select().from(schema.reviews).where(eq(schema.reviews.id, reviewId)).get()

  let wt: { path: string; headSha: string; cleanup: () => Promise<void> } | null = null
  let runId: string | null = null // the runs row for this execution (cost / tokens / model / skill version)
  const abort = new AbortController()
  reviewAborts.set(reviewId, abort)
  const hostOpts = { abort, projectDirName: projectDirNameFor(ctx.localPath) }
  const stageUsages: Array<ProviderUsage | null> = []
  let t0 = Date.now()
  let usageRecorded = false
  try {
    setStatus('cloning')
    emit('stage', '准备代码（worktree）')
    wt = await prepareWorktree({
      localPath: ctx.localPath || '',
      reposDir: ctx.reposDir,
      location: ctx.worktreeLocation,
      reviewId,
      branch: ctx.branch,
      defaultBranch: ctx.defaultBranch,
      onStep: (m) => emit('stage', m),
    })

    setStatus('reviewing', { headSha: wt.headSha })

    const review = db.select().from(schema.reviews).where(eq(schema.reviews.id, reviewId)).get()

    // One run record per execution; the review row points at its latest run and skill version (the Claude pipeline has none).
    const skillId = ctx.provider === 'codex' ? ctx.skillId ?? null : null
    const skillVersionId = ctx.provider === 'codex' ? ctx.skillVersionId ?? null : null
    runId = createRun(db, schema, {
      kind: 'review', subkind: 'review', provider: ctx.provider === 'codex' ? 'codex' : 'claude',
      projectId: ctx.projectId ?? review?.projectId ?? null, reviewId, workspaceType: 'pr_worktree', workspacePath: wt.path,
      prNumber: ctx.prNumber, branch: ctx.branch, model: ctx.model, effort: ctx.effort, codexServiceTier: ctx.codexServiceTier,
      skillId, skillVersionId, lang: ctx.lang ?? null, title: review?.title ?? null,
    })
    db.update(schema.reviews).set({ lastRunId: runId, skillVersionId, updatedAt: now() }).where(eq(schema.reviews.id, reviewId)).run()

    let result: any
    let costUsd = 0
    let usage: any = null

    let draftPatch: Record<string, unknown> = {}
    if (ctx.provider === 'codex') {
      // ── Fresh review, Codex: the single-agent review (wipe and rewrite; re-reviews go through runRecheckJob) ──
      emit('stage', 'AI 审核中…')
      const reviewRunner = selectReviewRunner(ctx.provider)
      const r = await reviewRunner.runReview({
        cwd: wt.path, repo: ctx.repo, prNumber: ctx.prNumber, branch: ctx.branch,
        defaultBranch: ctx.defaultBranch, methodology: ctx.methodology, model: ctx.model, effort: ctx.effort, codexServiceTier: ctx.codexServiceTier, lang: ctx.lang,
        instruction: ctx.instruction ?? review?.reviewInstruction ?? null,
        onTool: (name, info) => emit('tool', `${name} ${info}`), ...hostOpts,
      })
      result = r.result
      costUsd = r.costUsd
      usage = r.usage
      recordRunUsage(db, schema, runId, usage)
      if (taskGone()) { emit('error', '任务已被删除，丢弃审核结果'); finishRun(db, schema, runId, { status: 'stopped', error: 'task deleted' }); return }
      // Wipe + insert in one transaction: all or nothing, so a crash halfway doesn't leave findings empty
      db.transaction((tx: any) => replaceFindings(tx, schema, {
        reviewId, headSha: wt!.headSha, now: now(),
        rows: result.findings.map((f: any) => ({ severity: f.severity, title: f.title, location: f.location || null, problem: f.problem || null, detail: f.detail || null, fix: f.fix || null, introducedByPr: f.introducedByPr })),
      }))

      // Verify-before-post: a second read-only pass tries to refute every finding; verdicts are stored on the findings
      // (refuted ones stay visible but unchecked). A failed verify pass never fails the review.
      if (ctx.verifyBeforePost && result.findings.length && !taskGone()) {
        emit('stage', pickByLang(ctx.lang, VERIFY_STAGE).start)
        const verifyRunId = createRun(db, schema, {
          kind: 'review', subkind: 'verify', provider: ctx.provider === 'codex' ? 'codex' : 'claude',
          projectId: ctx.projectId ?? review?.projectId ?? null, reviewId, workspaceType: 'pr_worktree', workspacePath: wt.path,
          prNumber: ctx.prNumber, branch: ctx.branch, model: ctx.model, effort: ctx.effort, codexServiceTier: ctx.codexServiceTier,
          skillId: ctx.skillId ?? null, skillVersionId: ctx.skillVersionId ?? null, lang: ctx.lang ?? null, title: review?.title ?? null,
        })
        try {
          const rows = (db.select().from(schema.findings).where(eq(schema.findings.reviewId, reviewId)).all() as any[]).filter((f) => f.source !== 'human')
          const v = await runVerifyAgent({
            cwd: wt.path, repo: ctx.repo, prNumber: ctx.prNumber, branch: ctx.branch, defaultBranch: ctx.defaultBranch,
            provider: ctx.provider, model: ctx.model, effort: ctx.effort, codexServiceTier: ctx.codexServiceTier, lang: ctx.lang, methodology: ctx.methodology,
            findings: rows.map((f) => ({ fid: f.fid, severity: f.severity, title: f.title, location: f.location, problem: f.problem, detail: f.detail })),
            onTool: (n, i) => emit('tool', `${n} ${i}`), ...hostOpts,
          })
          recordRunUsage(db, schema, verifyRunId, v.usage)
          costUsd += v.costUsd
          const verdicts = verdictMap(v.result, rows.map((f) => f.fid))
          const counts = { confirmed: 0, refuted: 0, unsure: 0 }
          for (const f of rows) {
            const x = verdicts.get(f.fid)!
            counts[x.verdict]++
            db.update(schema.findings).set({ verifyStatus: x.verdict, verifyNote: x.reason || null }).where(eq(schema.findings.id, f.id)).run()
          }
          finishRun(db, schema, verifyRunId, { status: 'done' })
          emit('stage', pickByLang(ctx.lang, VERIFY_STAGE).done(counts))
        } catch (e) {
          recordRunUsage(db, schema, verifyRunId, usageOfError(e))
          if (abort.signal.aborted) throw e
          finishRun(db, schema, verifyRunId, { status: 'error', error: (e as Error).message })
          emit('stage', pickByLang(ctx.lang, VERIFY_STAGE).failed((e as Error).message))
        }
      }

      draftPatch = {
        logic: result.logic || null, quality: result.quality || null, risk: result.risk || null,
        conclusion: result.conclusion || null, requirement: result.requirement || null, testPath: result.testPath || null,
        notDone: null, reviewMdSuggestion: null, pipelineMeta: null,
      }
    } else {
      // ── Fresh review, Claude: the scope-review pipeline (engine ∥ project context → check → tiers) ──
      emit('stage', 'AI 审核中：引擎 + 项目视角 → 核对 → 分档')
      t0 = Date.now() // like the Codex path: the review's own time, without the worktree preparation
      const stage = stageRunner(ctx, review, wt.path, abort, stageUsages)
      const projects = (db.select().from(schema.projects).all() as any[]).map((p) => ({ repo: p.repo, localPath: p.localPath, defaultBranch: p.defaultBranch }))
      const s = await runScopeReview({
        cwd: wt.path, repo: ctx.repo, prNumber: ctx.prNumber, defaultBranch: ctx.defaultBranch, localPath: ctx.localPath || wt.path,
        projectDirName: projectDirNameFor(ctx.localPath), projects, model: ctx.model, effort: ctx.effort || undefined, level: engineLevelOf(ctx.engineLevel), lang: ctx.lang,
        instruction: ctx.instruction ?? review?.reviewInstruction ?? null, historyRoot: ctx.historyRoot, reviewId, abort,
        onTool: (n, i) => emit('tool', `${n} ${i}`), emit: (m) => emit('stage', m), stage,
      })
      usage = stageTotal(stageUsages, t0)
      costUsd = usage?.costUsd ?? 0
      recordRunUsage(db, schema, runId, usage) // the review's own row carries the total; aggregates skip the stage rows
      usageRecorded = true
      if (taskGone()) { emit('error', '任务已被删除，丢弃审核结果'); finishRun(db, schema, runId, { status: 'stopped', error: 'task deleted' }); return }
      db.transaction((tx: any) => replaceFindings(tx, schema, { reviewId, headSha: wt!.headSha, now: now(), rows: s.rows }))
      for (const r of s.reviewMd) db.insert(schema.reviewRuleFiles).values({ sha: r.sha, path: r.path, content: r.text, createdAt: now() }).onConflictDoNothing().run()
      db.update(schema.runs).set({ reviewRules: JSON.stringify(s.reviewMd.map((r) => ({ path: r.path, sha: r.sha }))) }).where(eq(schema.runs.id, runId)).run()
      draftPatch = {
        logic: null, quality: null, risk: null, requirement: s.requirement || null, testPath: null,
        conclusion: s.conclusion || null, notDone: s.notDone || null, reviewMdSuggestion: s.reviewMdSuggestion || null, pipelineMeta: JSON.stringify(s.meta),
      }
      result = { findings: s.rows }
    }

    {
      // Merge conflict detection: the PR conflicts with its base branch → append a High "resolve merge conflicts" finding (auto-fix will try to resolve them).
      // A failed / UNKNOWN GitHub mergeable lookup never raises a false alarm.
      try {
        if ((await fetchPrMergeable(ctx.repo, ctx.prNumber)) === 'conflicting' && !taskGone()) {
          const c = pickByLang(ctx.lang, CONFLICT_FINDING)
          const n = db.select().from(schema.findings).where(eq(schema.findings.reviewId, reviewId)).all().length
          db.insert(schema.findings).values({
            id: nanoid(), reviewId, fid: `F${n + 1}`, severity: 'High',
            ...(ctx.provider === 'codex' ? {} : { tier: 'must', evidence: 'github', verifyStatus: 'confirmed' }),
            title: c.title,
            location: null,
            problem: c.problem,
            detail: null,
            fix: c.fix,
            introducedByPr: true, checked: false, notes: null, sortOrder: n, createdAt: now(),
          }).run()
          emit('stage', c.stage)
        }
      } catch { /* a failed mergeable lookup doesn't affect the review */ }
    }

    setStatus('draft', draftPatch)
    // The first pass is a round too. Without this marker the next re-review sees no previous round, and the
    // instruction typed before the first pass would go on binding it — the opposite of one-shot.
    db.insert(schema.events).values({ id: nanoid(), reviewId, ts: now(), kind: ROUND_EVENT, message: 'round 1' }).run()
    finishRun(db, schema, runId, { status: 'done' })
    emit('done', `审核完成 · ${formatUsageLabel(usage, costUsd)}`)
  } catch (e) {
    const stopped = abort.signal.aborted
    const message = stopped ? '已停止' : (e as Error).message
    if (runId) {
      if (!usageRecorded) recordRunUsage(db, schema, runId, stageUsages.length ? stageTotal(stageUsages, t0) : usageOfError(e)) // stage failures are already on their own rows
      finishRun(db, schema, runId, { status: stopped ? 'stopped' : 'error', error: message })
    }
    setStatus('error', { error: message })
    emit('error', message)
  } finally {
    reviewAborts.delete(reviewId)
    if (wt) await wt.cleanup()
  }
}

// Recheck: based on the new commits the author pushed after our comment, judge each finding fixed/partial/unaddressed and append finding_rechecks.
async function runRecheckJob(ctx: ReviewJobCtx) {
  const { db, schema, reviewId } = ctx
  const now = () => new Date().toISOString()
  const emit = (kind: string, message?: string) => {
    const ts = now()
    cockpitBus.emit({ reviewId, ts, kind, message })
    try {
      db.insert(schema.events).values({ id: nanoid(), reviewId, ts, kind, message: message ?? null }).run()
    } catch {}
  }
  const setStatus = (status: string, extra: Record<string, unknown> = {}) => {
    db.update(schema.reviews).set({ status, updatedAt: now(), ...extra }).where(eq(schema.reviews.id, reviewId)).run()
    cockpitBus.emit({ reviewId, ts: now(), kind: 'status', message: status })
  }

  const review = db.select().from(schema.reviews).where(eq(schema.reviews.id, reviewId)).get()
  const existing = db.select().from(schema.findings).where(eq(schema.findings.reviewId, reviewId)).all()
  // The head the previous round judged: read it before this run overwrites it, so the diff can start there.
  const previousHeadSha = review?.headSha ?? null

  let wt: { path: string; headSha: string; cleanup: () => Promise<void> } | null = null
  let runId: string | null = null
  const abort = new AbortController()
  reviewAborts.set(reviewId, abort)
  const hostOpts = { abort, projectDirName: projectDirNameFor(ctx.localPath) }
  const recheckStageUsages: Array<ProviderUsage | null> = [] // check/tier stages of this re-review, until recorded on its row
  try {
    setStatus('rechecking')
    emit('stage', '复审：准备最新代码')
    wt = await prepareWorktree({
      localPath: ctx.localPath || '', reposDir: ctx.reposDir, location: ctx.worktreeLocation, reviewId,
      branch: ctx.branch, defaultBranch: ctx.defaultBranch, onStep: (m) => emit('stage', m),
    })

    runId = createRun(db, schema, {
      kind: 'review', subkind: 'recheck', provider: ctx.provider === 'codex' ? 'codex' : 'claude',
      projectId: ctx.projectId ?? review?.projectId ?? null, reviewId, workspaceType: 'pr_worktree', workspacePath: wt.path,
      prNumber: ctx.prNumber, branch: ctx.branch, model: ctx.model, effort: ctx.effort, codexServiceTier: ctx.codexServiceTier,
      skillId: ctx.skillId ?? null, skillVersionId: ctx.skillVersionId ?? null, lang: ctx.lang ?? null, title: review?.title ?? null,
    })
    // Only the run pointer: the findings were produced by an earlier (fresh/guided) review, so the review keeps that skill version.
    db.update(schema.reviews).set({ lastRunId: runId, updatedAt: now() }).where(eq(schema.reviews.id, reviewId)).run()

    const intent = computeRoundIntent(db, schema, reviewId, wt.headSha, previousHeadSha, ctx.instruction ?? review?.reviewInstruction ?? null)
    const round = intent.round

    // Prepare the round's context before the agent starts: the conversation is fetched here (one gh call) rather than
    // spent out of the agent's turn budget, and everything bulky lands in a file it pulls from on its own.
    emit('stage', `复审 round ${round}：准备历史${intent.instruction ? '（带你的指令）' : ''}`)
    // A failed fetch must not read as "the author said nothing" — that turns a network blip into a wrong verdict that
    // looks exactly like a right one. Record what could not be fetched, in the file and in the log.
    const fetchErrors: string[] = []
    const [timeline, reviewComments] = await Promise.all([
      fetchTimeline(ctx.repo, ctx.prNumber).catch((e) => { fetchErrors.push(`PR conversation: ${(e as Error).message}`); return [] }),
      fetchReviewComments(ctx.repo, ctx.prNumber).catch((e) => { fetchErrors.push(`line-level comments: ${(e as Error).message}`); return [] }),
    ])
    if (fetchErrors.length) emit('stage', `⚠️ 抓取失败，历史文件会标注缺口：${fetchErrors.join('；')}`)
    const findingHistory = loadFindingHistory(db, schema, reviewId, { includeRounds: true })
    const { path: historyPath, bytes } = writeReviewHistory(ctx.historyRoot, reviewId, buildHistoryDoc({
      reviewId, repo: ctx.repo, prNumber: ctx.prNumber, intent, findings: findingHistory,
      timeline, reviewComments, since: intent.lastRoundAt, globalNotes: review?.globalNotes ?? null, fetchErrors,
    }))
    emit('stage', `历史已备好（${findingHistory.length} 条 finding · ${Math.round(bytes / 1024)}KB）：${historyPath}`)

    emit('stage', '复审中：判断作者改了没 + 我方立场')
    const { result, usage, historyRead } = await selectReviewRunner(ctx.provider).runRecheck({
      cwd: wt.path, repo: ctx.repo, prNumber: ctx.prNumber, defaultBranch: ctx.defaultBranch,
      requirement: review?.requirement ?? null,
      intent,
      findingIndex: buildFindingIndex(findingHistory),
      historyPath,
      methodology: ctx.methodology, model: ctx.model, effort: ctx.effort, codexServiceTier: ctx.codexServiceTier, lang: ctx.lang, onTool: (n, i) => emit('tool', `${n} ${i}`), ...hostOpts,
    })

    recordRunUsage(db, schema, runId, usage)
    // Scope reviews: check and tier the new issues before anything of this round is written (no half-written round).
    let classified: FindingRow[] | null = null
    let failedStages: FailedStage[] = []
    if (ctx.provider !== 'codex' && review?.pipelineMeta && result.newFindings?.length) {
      const raw: RawFinding[] = result.newFindings.map((nf: any, i: number) => {
        const m = /^(.*?)(?::(\d+))?$/.exec(String(nf.location || ''))
        return { id: `R${i + 1}`, source: 'recheck' as const, file: m?.[1] ?? '', line: m?.[2] ? Number(m[2]) : null, title: nf.title, scenario: [nf.problem, nf.detail].filter(Boolean).join('\n'), preExisting: false }
      })
      const contextPath = contextDocPath(ctx.historyRoot, reviewId)
      const c = await classifyFindings({
        cwd: wt.path, model: ctx.model, effort: ctx.effort || undefined, abort, onTool: (n, i) => emit('tool', `${n} ${i}`), baseBranch: ctx.defaultBranch, lang: ctx.lang,
        contextPath: existsSync(contextPath) ? contextPath : null, raw, stage: stageRunner(ctx, review, wt.path, abort, recheckStageUsages), emit: (m) => emit('stage', m), projectDirName: projectDirNameFor(ctx.localPath),
      })
      classified = c.rows
      failedStages = c.failed
      recordRunUsage(db, schema, runId, mergeUsage(recheckStageUsages))
      recheckStageUsages.length = 0 // recorded
    }
    if (!db.select().from(schema.reviews).where(eq(schema.reviews.id, reviewId)).get()) {
      emit('error', '任务已被删除，丢弃复审结果'); finishRun(db, schema, runId, { status: 'stopped', error: 'task deleted' }); return
    }
    const byFid = new Map(existing.map((f: any) => [f.fid, f]))
    const fixedBy = new Map<string, string | null>()
    for (const r of result.rechecks) {
      const old: any = byFid.get(r.fid)
      if (old && r.status === 'fixed') fixedBy.set(r.fid, await fixingCommit(wt.path, previousHeadSha, wt.headSha, pathOfLocation(old.location)))
    }
    let applied = 0
    let added = 0
    db.transaction((tx: any) => {
      for (const r of result.rechecks) {
        const old: any = byFid.get(r.fid)
        if (!old) continue // drop verdicts with no matching old finding (new issues go through newFindings)
        const patch = { ...(r.stance === 'adjusted' ? adjustedPatch(old, r as any, ctx.lang) : null), ...fixedUncheck(old, r.status) }
        if (Object.keys(patch).length) tx.update(schema.findings).set(patch).where(eq(schema.findings.id, old.id)).run()
        tx.insert(schema.findingRechecks).values({
          id: nanoid(), findingId: old.id, round, status: r.status, stance: r.stance, fixedBy: fixedBy.get(r.fid) ?? null,
          stanceReason: r.stanceReason || null, text: r.text || null, at: now(),
        }).run()
        applied++
      }

      // New issues introduced by the author's new commits: a new finding (unchecked) + a "new" recheck record
      let maxN = maxFidNumber(existing)
      const fresh = classified
        ? classified.map((f) => ({ values: { severity: f.severity, title: f.title, location: f.location, problem: f.problem, detail: f.detail, fix: f.fix, tier: f.tier, evidence: f.evidence, source: 'recheck', verifyStatus: f.verifyStatus, verifyNote: f.verifyNote }, text: f.problem }))
        : (result.newFindings ?? []).map((nf: any) => ({ values: { severity: nf.severity, title: nf.title, location: nf.location || null, problem: nf.problem || null, detail: nf.detail || null, fix: nf.fix || null, ...(review?.pipelineMeta ? { source: 'recheck' } : {}) }, text: nf.text || null }))
      for (const n of fresh) {
        const id = nanoid()
        tx.insert(schema.findings).values({ ...n.values, id, reviewId, fid: `F${++maxN}`, introducedByPr: true, checked: false, notes: null, sortOrder: maxN, createdAt: now() }).run()
        tx.insert(schema.findingRechecks).values({ id: nanoid(), findingId: id, round, status: 'new', stance: 'kept', text: n.text || null, at: now() }).run()
        added++
      }
      tx.insert(schema.events).values({ id: nanoid(), reviewId, ts: now(), kind: ROUND_EVENT, message: `round ${round}` }).run()
    })

    // The post-recheck overall conclusion overwrites the AI summary; if the AI gave none (empty), keep the old summary instead of clearing it
    const newConclusion = result.conclusion?.trim()
    setStatus('draft', { headSha: wt.headSha, authorUpdated: false, ...(newConclusion ? { conclusion: newConclusion } : {}), ...(review?.pipelineMeta ? { pipelineMeta: withFailedStages(review.pipelineMeta, failedStages) } : {}) })
    finishRun(db, schema, runId, { status: 'done' })
    // Ground truth, not self-report: the agent's own tool calls say whether it opened the history we prepared.
    if (findingHistory.some((f) => f.roundTexts.length) && !historyRead) {
      emit('history-skipped', '本轮未查阅历史文件（结论仅基于本轮所见）')
    }
    emit('recheck', `复审 round ${round} 完成 · 更新 ${applied} 条${added ? ` · 新增 ${added} 条` : ''} · ${formatUsageLabel(usage, 0)}`)
  } catch (e) {
    const stopped = abort.signal.aborted
    const message = stopped ? '已停止' : (e as Error).message
    if (runId) {
      recordRunUsage(db, schema, runId, failedJobUsage(recheckStageUsages, e))
      finishRun(db, schema, runId, { status: stopped ? 'stopped' : 'error', error: message })
    }
    setStatus('error', { error: message })
    emit('error', message)
  } finally {
    reviewAborts.delete(reviewId)
    if (wt) await wt.cleanup()
  }
}
