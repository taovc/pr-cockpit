// The "pure decision core" of PR automation: given the current snapshot of one PR, work out what to do next.
// Zero side effects (no DB / no gh / no agent runs), so synthetic snapshots can exhaustively test every branch and the whole loop.
// The engine (core/automation/engine.ts) collects the snapshot, translates the action returned here into calls to existing endpoints, and persists the patch.
//
// Loop safety (matching what the user decided):
//  - Don't ignore our own pushes: a recheck triggers purely on whether head changed, regardless of who pushed it (we want to review "did we actually fix it").
//  - Round cap: each PR gets at most autoMaxRounds (default 2) "auto fix" dispatches; on reaching the cap both switches are turned off automatically and capped is recorded.
//  - Dedup: one fix per review head (lastFixReviewSha); one post per draft (status=draft→posted).
//  - Termination: auto fix/recheck only fire while round < max and round increases monotonically → at most max code-writing rounds before it necessarily stops; or it exits earlier through "converged".

// Review statuses that mean the task is "running" (the engine skips these too; here as a backstop we treat them as wait)
export const REVIEW_INFLIGHT = ['queued', 'cloning', 'reviewing', 'recheck_requested', 'rechecking', 'posting']
// Review statuses that mean "finished, with results we can act on" (error doesn't count — a failed review has no findings to fix, leave it to a human)
const REVIEW_TERMINAL = ['draft', 'posted', 'ready_to_post']

export type PrStatusKey = 'open' | 'draft' | 'merged' | 'closed'

export type AutoConfig = {
  masterEnabled: boolean
  reviewEnabled: boolean
  reviewMode: 'once' | 'every_push'
  reviewAuthors: string[] // empty = any author
  reviewStatuses: PrStatusKey[] // empty = any status
  fixEnabled: boolean
  fixAuthors: string[]
  fixStatuses: PrStatusKey[]
}

// A pr_automation row (may not exist = everything inherited from config)
export type PrAutoRow = {
  reviewOn: boolean | null // null = inherit from config
  fixOn: boolean | null
  round: number
  lastFixReviewSha: string | null
  pendingFix: boolean
  optOut: boolean
  note: string | null
  headSeenSha: string | null // cooldown: the head the engine first saw + when (engine-only)
  headSeenAt: string | null
}

export const EMPTY_AUTO_ROW: PrAutoRow = {
  reviewOn: null, fixOn: null, round: 0, lastFixReviewSha: null, pendingFix: false, optOut: false, note: null,
  headSeenSha: null, headSeenAt: null,
}

function matches(authors: string[], statuses: PrStatusKey[], pr: { author: string; status: PrStatusKey }): boolean {
  const aOk = authors.length === 0 || authors.includes(pr.author)
  const sOk = statuses.length === 0 || statuses.includes(pr.status)
  return aOk && sOk
}

// The "effective value" of an instance-level switch: an explicit override (0/1) wins; when null, inherit "master switch && system switch && author/status filter matches".
// Opting out (optOut, task was deleted) always turns it off. Note: when the user explicitly turns it on for a PR it runs even if the project master switch is off (user's call).
export function effectiveReviewOn(cfg: AutoConfig, row: PrAutoRow | null, pr: { author: string; status: PrStatusKey }): boolean {
  if (row?.optOut) return false
  if (row && row.reviewOn != null) return row.reviewOn
  return cfg.masterEnabled && cfg.reviewEnabled && matches(cfg.reviewAuthors, cfg.reviewStatuses, pr)
}
export function effectiveFixOn(cfg: AutoConfig, row: PrAutoRow | null, pr: { author: string; status: PrStatusKey }): boolean {
  if (row?.optOut) return false
  if (row && row.fixOn != null) return row.fixOn
  return cfg.masterEnabled && cfg.fixEnabled && matches(cfg.fixAuthors, cfg.fixStatuses, pr)
}

// The effective switch for auto fix (with a safety guardrail). A fix runs an agent on the PR and pushes automatically, far riskier than a read-only review, so:
// in project-level rules an "empty author filter" never means "everyone" — by default it only applies to the current user's (the machine owner's) own PRs (running a
// headless agent that executes someone else's / a bot's branch code + auto-pushing is dangerous, and prone to prompt injection).
// Explicitly turning the switch on for a given PR (row.fixOn===true) = manual per-PR authorization, allowed (not restricted by the author allowlist).
export function effectiveFixOnGuarded(
  cfg: AutoConfig,
  row: PrAutoRow | null,
  pr: { author: string; status: PrStatusKey },
  currentUser: string | null,
): boolean {
  if (!effectiveFixOn(cfg, row, pr)) return false
  if (row && row.fixOn === true) return true // explicit per-PR authorization, not bound by the author allowlist
  const allow = cfg.fixAuthors.length ? cfg.fixAuthors : currentUser ? [currentUser] : []
  return allow.includes(pr.author) // empty allowlist (and no currentUser available) → fix nobody (safe default)
}

export type ReviewSnapshot = { exists: boolean; status: string; headSha: string | null }
export type FixSnapshot = { status: string; chatting: boolean } | null

// One PR snapshot fed to decide
export type PrSnapshot = {
  prStatus: PrStatusKey
  headSha: string | null // the PR's current head (live from GitHub)
  reviewMode: 'once' | 'every_push'
  maxRounds: number
  actionableCount: number // number of findings still to handle (High/Med and unfixed; the engine computes it from the DB)
  reviewFindingsCount: number // findings automation may post (0 = nothing to post a comment about)
  review: ReviewSnapshot | null
  fix: FixSnapshot
  // Resolved runtime state (reviewOn/fixOn are already effective booleans; round/lastFixReviewSha/pendingFix/optOut come from the pr_automation row)
  auto: {
    reviewOn: boolean
    fixOn: boolean
    round: number
    lastFixReviewSha: string | null
    pendingFix: boolean
    optOut: boolean
    note: string | null
  }
}

export type AutoActionKind = 'none' | 'review' | 'recheck' | 'post' | 'fix' | 'push' | 'cap'
export type AutoAction = { kind: AutoActionKind }
// Incremental update written to the pr_automation row
export type PrAutoPatch = Partial<{
  reviewOn: boolean | null
  fixOn: boolean | null
  round: number
  lastFixReviewSha: string | null
  pendingFix: boolean
  note: string | null
}>
export type AutoDecision = { action: AutoAction; patch?: PrAutoPatch; reason: string }

function isTerminalReview(status: string): boolean {
  return REVIEW_TERMINAL.includes(status)
}
function reviewInflight(status: string): boolean {
  return REVIEW_INFLIGHT.includes(status)
}

export function decideAutoAction(s: PrSnapshot): AutoDecision {
  const none = (reason: string, patch?: PrAutoPatch): AutoDecision => ({ action: { kind: 'none' }, patch, reason })

  // 0. PR merged/closed → always stop (the default filter only accepts in-progress PRs; this is a backstop against the status changing mid-flight)
  if (s.prStatus === 'merged' || s.prStatus === 'closed') return none('pr-closed')
  if (s.auto.optOut) return none('opt-out')

  const { reviewOn, fixOn } = s.auto
  if (!reviewOn && !fixOn) return none('both-off')

  const review = s.review
  if (review?.exists && reviewInflight(review.status)) return none('review-inflight')

  // 1. First wrap up "the fix dispatched last time" (highest priority, so we don't stack new actions on top of one that hasn't settled)
  if (s.auto.pendingFix) {
    if (s.fix?.chatting) return none('fix-running')
    if (s.fix?.status === 'ready') {
      // fix produced changes to upload → upload (the engine clears pendingFix after a successful push)
      return { action: { kind: 'push' }, reason: 'fix-ready-push' }
    }
    if (s.fix?.status === 'pushed') {
      // already pushed (the engine normally clears pendingFix at the same time; backstop here)
      return none('fix-pushed', { pendingFix: false })
    }
    // the fix ran but produced nothing to upload (can't fix it) or errored → record the reason and stop, no idle retries (this round's budget is spent)
    const note = s.fix?.status === 'error' ? 'fix_error' : 'cant_fix'
    return none(note, { pendingFix: false, note })
  }

  // 2. Auto review: no review task yet → first review
  if (reviewOn && !review?.exists) {
    return { action: { kind: 'review' }, reason: 'first-review' }
  }

  // 3. Auto review (every push): head changed (the author edited it / our own fix pushed) → recheck "did it change / is it fixed"
  if (
    reviewOn && review?.exists && s.reviewMode === 'every_push' &&
    isTerminalReview(review.status) &&
    s.headSha && review.headSha && s.headSha !== review.headSha
  ) {
    return { action: { kind: 'recheck' }, reason: 'author-updated-recheck' }
  }

  // 4. Auto review: the review/recheck produced a draft (unpublished) and there are findings to post → auto select all + post the comment to GitHub
  //    A clean PR (0 findings) doesn't post an empty comment and stays in draft (otherwise every tick would hit the post endpoint's 400 empty-comment guard and spin on errors).
  if (reviewOn && review?.exists && review.status === 'draft' && s.reviewFindingsCount > 0) {
    return { action: { kind: 'post' }, reason: 'auto-post-draft' }
  }

  // 5. Auto fix: unresolved actionable findings remain and this review head hasn't been fixed yet → fix (or hit the cap)
  const fixableNow =
    fixOn && review?.exists && isTerminalReview(review.status) &&
    s.actionableCount > 0 && s.auto.lastFixReviewSha !== review.headSha
  if (fixableNow) {
    if (s.auto.round >= s.maxRounds) {
      // round cap reached: turn both switches off for this PR (explicit false), record capped, stop and wait for a human
      return { action: { kind: 'cap' }, patch: { reviewOn: false, fixOn: false, note: 'capped' }, reason: 'round-capped' }
    }
    return {
      action: { kind: 'fix' },
      patch: { round: s.auto.round + 1, lastFixReviewSha: review!.headSha ?? null, pendingFix: true },
      reason: 'auto-fix',
    }
  }

  // 5.5 The fix is pushed but will never be rechecked automatically (once mode / auto review off) → that fix would never be verified and the PR would sit armed-idle forever.
  //     Record fix_unverified, turn both switches off and stop (the fix is on GitHub, waiting for a human to confirm/recheck). every_push mode never gets here (branch 3 rechecks first).
  if (
    fixOn && review?.exists && isTerminalReview(review.status) &&
    s.actionableCount > 0 && s.fix?.status === 'pushed' &&
    s.auto.lastFixReviewSha === review.headSha && s.auto.round > 0 &&
    (s.reviewMode !== 'every_push' || !reviewOn)
  ) {
    return { action: { kind: 'none' }, patch: { reviewOn: false, fixOn: false, note: 'fix_unverified' }, reason: 'fix-unverified' }
  }

  // 6. Converged: reviewed with no actionable findings left (after at least one fix round) → record converged and stop
  if (
    review?.exists && isTerminalReview(review.status) &&
    s.actionableCount === 0 && s.auto.round > 0 && s.auto.note !== 'converged'
  ) {
    return none('converged', { note: 'converged' })
  }

  return none('idle')
}
