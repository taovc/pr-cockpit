import { fixStatusOf } from '../runs/session'
import { and, eq } from 'drizzle-orm'
import {
  decideAutoAction,
  effectiveReviewOn,
  effectiveFixOnGuarded,
  REVIEW_INFLIGHT,
  type AutoConfig,
  type PrSnapshot,
} from './decide'
import { getProjectAutomation, getPrAutomationRow, upsertPrAutomation, pullStatusKey, recordAutomationEvent } from './state'
import { reviewFindingStats } from './findings'

// Automation engine: pure orchestration of one polling round. Reads project_automation/pr_automation
// plus the GitHub PR list, builds a snapshot per PR → decideAutoAction → writes the pr_automation
// patch → dispatches work by calling the existing endpoints through injected deps.
// Every real side effect (gh / creating tasks / posting comments / push) goes through deps, with the
// plugin injecting the real implementations, which keeps the engine testable and core free of any
// runtime dependency.

export type EnginePull = {
  number: number
  author: string
  headSha: string
  state: string
  isDraft: boolean
}

export type EngineDeps = {
  listPulls(repo: string, state: 'open' | 'all', first: number): Promise<{ pulls: EnginePull[] }>
  isChatting(fixId: string): boolean
  dispatchReview(projectId: string, prNumber: number): Promise<void>
  dispatchRecheck(reviewId: string): Promise<void>
  // posted = whether a comment was actually posted; nothing to post → {posted:false};
  // posting failed → {posted:false,error} (already contained, no retry)
  dispatchPost(reviewId: string): Promise<{ posted: boolean; error?: string }>
  dispatchFix(projectId: string, prNumber: number, reviewId: string): Promise<void>
  dispatchPush(fixId: string): Promise<void>
  now(): string
  currentUser?: string | null // currently logged-in gh user (default for the auto-fix author allowlist)
  log?(msg: string): void
}

// Which PR statuses are ticked in the config → does the backend fetch open or all (same rule as
// backendState in the frontend's [id].vue, saving gh calls)
function backendState(statuses: string[]): 'open' | 'all' {
  if (!statuses.length) return 'all'
  return statuses.every((s) => s === 'open' || s === 'draft') ? 'open' : 'all'
}

// Whether this project should be processed this round: the master switch is on with at least one
// system running, or some PR row is explicitly on / still wrapping up (a PR turned on manually
// without any project config must still be handled).
// Note: reviewOn/fixOn/pendingFix are drizzle boolean-mode columns, so they read back as JS booleans
// (true/false/null), not the number 1 — use !! to test truthiness.
function isProjectArmed(db: any, schema: any, projectId: string, cfg: AutoConfig): boolean {
  if (cfg.masterEnabled && (cfg.reviewEnabled || cfg.fixEnabled)) return true
  const rows = db.select().from(schema.prAutomation).where(eq(schema.prAutomation.projectId, projectId)).all() as any[]
  return rows.some((r) => !r.optOut && (!!r.reviewOn || !!r.fixOn || !!r.pendingFix))
}

function getReview(db: any, schema: any, projectId: string, prNumber: number) {
  return db
    .select()
    .from(schema.reviews)
    .where(and(eq(schema.reviews.projectId, projectId), eq(schema.reviews.prNumber, prNumber)))
    .get()
}

// The PR's latest session run (workspace pr_worktree; delete is a hard delete, so there is usually at most one).
// `status` is the legacy fix status the decision core reasons about (open / ready / pushing / pushed / error).
function getLatestFix(db: any, schema: any, projectId: string, prNumber: number) {
  const rows = db
    .select()
    .from(schema.runs)
    .where(and(eq(schema.runs.kind, 'session'), eq(schema.runs.workspaceType, 'pr_worktree'), eq(schema.runs.projectId, projectId), eq(schema.runs.prNumber, prNumber)))
    .all() as any[]
  const live = rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const r = live.length ? live[live.length - 1] : null
  return r ? { ...r, status: fixStatusOf(r) } : null
}

async function evaluatePr(db: any, schema: any, deps: EngineDeps, project: any, cfg: AutoConfig, p: EnginePull) {
  const now = deps.now()
  const row = getPrAutomationRow(db, schema, project.id, p.number)
  const prKey = { author: p.author, status: pullStatusKey(p) }
  const reviewOn = effectiveReviewOn(cfg, row, prKey)
  const fixOn = effectiveFixOnGuarded(cfg, row, prKey, deps.currentUser ?? null)
  const rec = (kind: string, message: string | null = null) =>
    recordAutomationEvent(db, schema, project.id, p.number, kind, message, deps.now())

  if (!reviewOn && !fixOn) {
    // Automation is off for this PR: clear any leftover pendingFix so it doesn't keep the project
    // armed and spinning
    if (row?.pendingFix) upsertPrAutomation(db, schema, project.id, p.number, { pendingFix: false }, now)
    return
  }

  // When auto-fix alone is turned off (auto-review may still be on), don't push that in-flight fix on
  // the user's behalf — turning it off means they don't want it to continue, so the changes stay in
  // the worktree (status=ready, still uploadable by hand). Clear pendingFix.
  let pendingFix = row?.pendingFix ?? false
  if (!fixOn && pendingFix) {
    upsertPrAutomation(db, schema, project.id, p.number, { pendingFix: false }, now)
    pendingFix = false
  }

  // Cooldown: the clock starts the first time a PR's head is seen, and nothing is done until it
  // expires — this gives the user time to go in and turn off what they don't want to run.
  // A head change (new PR / someone else pushed / our own fix pushed) resets the clock.
  // 0 minutes = no cooldown.
  const cooldownMin = project.autoCooldownMinutes ?? 5
  if (cooldownMin > 0) {
    const head = p.headSha || null
    if ((row?.headSeenSha ?? null) !== head) {
      upsertPrAutomation(db, schema, project.id, p.number, { headSeenSha: head, headSeenAt: now }, now)
      rec('cooldown', String(cooldownMin)) // Into the timeline: cooldown started, the user can turn it off during this window
      return
    }
    if (row?.headSeenAt && Date.parse(now) - Date.parse(row.headSeenAt) < cooldownMin * 60_000) return // still cooling down
  }

  const review = getReview(db, schema, project.id, p.number)
  if (review && REVIEW_INFLIGHT.includes(review.status)) return // review running, wait
  const fix = getLatestFix(db, schema, project.id, p.number)
  if (fix && deps.isChatting(fix.id)) return // fix conversation running, wait
  if (fix && fix.status === 'pushing') return // upload in progress, wait

  // One scan computes both the actionable count and the total finding count (don't hit the DB twice)
  const stats = review ? reviewFindingStats(db, schema, review.id) : { total: 0, actionable: 0, actionableFindings: [] }
  const actionableCount = stats.actionable
  const reviewFindingsCount = stats.total
  const snap: PrSnapshot = {
    prStatus: pullStatusKey(p),
    headSha: p.headSha || null,
    reviewMode: cfg.reviewMode,
    maxRounds: project.autoMaxRounds ?? 2,
    actionableCount,
    reviewFindingsCount,
    review: review ? { exists: true, status: review.status, headSha: review.headSha ?? null } : null,
    fix: fix ? { status: fix.status, chatting: false } : null,
    auto: {
      reviewOn,
      fixOn,
      round: row?.round ?? 0,
      lastFixReviewSha: row?.lastFixReviewSha ?? null,
      pendingFix,
      optOut: row?.optOut ?? false,
      postHeld: row?.postHeld ?? false,
      note: row?.note ?? null,
    },
  }

  const d = decideAutoAction(snap)
  if (d.patch) {
    upsertPrAutomation(db, schema, project.id, p.number, d.patch, now)
    // Terminal reasons go into the timeline (converged / can't fix / fix errored)
    if (d.patch.note && ['converged', 'cant_fix', 'fix_error', 'post_held'].includes(d.patch.note)) rec(d.patch.note)
  }
  if (d.action.kind === 'cap') {
    rec('capped', `${snap.auto.round}/${snap.maxRounds}`)
    return
  }
  if (d.action.kind === 'none') return

  deps.log?.(`PR #${p.number}: ${d.action.kind} (${d.reason})`)
  try {
    switch (d.action.kind) {
      case 'review':
        await deps.dispatchReview(project.id, p.number)
        rec('review_created')
        break
      case 'recheck':
        if (review) { await deps.dispatchRecheck(review.id); rec('recheck') }
        break
      case 'post': {
        // Actually posted → record posted; nothing to post → skip silently; posting failed → stop all
        // automation for this PR (both switches off + clear pendingFix) and record post_error.
        // Otherwise the comment never goes out while the code still gets auto-fixed and pushed on the
        // next round (ready_to_post is still a fixable terminal state) — inconsistent with "stop as
        // soon as posting a comment errors".
        if (review) {
          const r = await deps.dispatchPost(review.id)
          if (r.posted) {
            rec('posted')
          } else if (r.error) {
            upsertPrAutomation(db, schema, project.id, p.number, { reviewOn: false, fixOn: false, pendingFix: false, note: 'post_error' }, deps.now())
            rec('post_error', r.error)
          }
        }
        break
      }
      case 'fix':
        if (review) { await deps.dispatchFix(project.id, p.number, review.id); rec('fix_started', `${d.patch?.round ?? ''}`) }
        break
      case 'push':
        if (fix) {
          try {
            await deps.dispatchPush(fix.id)
            // push succeeded → clear pendingFix (the head changed, so the next round's every_push
            // triggers a recheck)
            upsertPrAutomation(db, schema, project.id, p.number, { pendingFix: false }, deps.now())
            rec('pushed')
          } catch (e) {
            // push failed (including push.post.ts's up-front 4xx: worktree gone / invalid branch /
            // no changes etc., which throw before it sets fix=error).
            // pendingFix MUST be cleared — otherwise decide's step 1 unconditionally picks push again
            // every round, a permanent hot loop that also short-circuits the round cap. Stop
            // automation for this PR + record push_error.
            upsertPrAutomation(db, schema, project.id, p.number, { reviewOn: false, fixOn: false, pendingFix: false, note: 'push_error' }, deps.now())
            rec('push_error', (e as Error).message)
          }
        }
        break
    }
  } catch (e) {
    // A failed dispatch is not fatal: the endpoint has already persisted the task status (e.g. push
    // failure → fix=error), and the next round's decide wraps up accordingly.
    deps.log?.(`PR #${p.number} dispatch ${d.action.kind} failed: ${(e as Error).message}`)
  }
}

export async function runAutomationTick(db: any, schema: any, deps: EngineDeps) {
  const projects = db.select().from(schema.projects).all() as any[]
  for (const project of projects) {
    if (!project.localPath) continue // can't even create a worktree, skip
    const cfg = getProjectAutomation(db, schema, project.id)
    if (!isProjectArmed(db, schema, project.id, cfg)) continue

    const statuses = [...new Set([...cfg.reviewStatuses, ...cfg.fixStatuses])]
    let pulls: EnginePull[]
    try {
      pulls = (await deps.listPulls(project.repo, backendState(statuses), 100)).pulls
    } catch (e) {
      deps.log?.(`listPulls failed for ${project.repo}: ${(e as Error).message}`)
      continue
    }
    for (const p of pulls) {
      try {
        await evaluatePr(db, schema, deps, project, cfg, p)
      } catch (e) {
        deps.log?.(`evaluatePr #${p.number} failed: ${(e as Error).message}`)
      }
    }
  }
}
