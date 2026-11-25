import assert from 'node:assert/strict'
import {
  decideAutoAction,
  effectiveReviewOn,
  effectiveFixOn,
  effectiveFixOnGuarded,
  EMPTY_AUTO_ROW,
  type AutoConfig,
  type PrSnapshot,
  type PrStatusKey,
} from '../core/automation/decide'

// ── Test fixtures: default config + snapshot builder ────────────────────────
const CFG: AutoConfig = {
  masterEnabled: true,
  reviewEnabled: true,
  reviewMode: 'every_push',
  reviewAuthors: [],
  reviewStatuses: ['open', 'draft'],
  fixEnabled: true,
  fixAuthors: [],
  fixStatuses: ['open', 'draft'],
}

function snap(over: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    prStatus: 'open',
    headSha: 'H0',
    reviewMode: 'every_push',
    maxRounds: 2,
    actionableCount: 0,
    reviewFindingsCount: 2,
    review: null,
    fix: null,
    auto: { reviewOn: true, fixOn: true, round: 0, lastFixReviewSha: null, pendingFix: false, optOut: false, note: null },
    ...over,
  }
}

// ── 1) effective switches: inherit / override / optOut / filters ────────────
{
  const pr = { author: 'alice', status: 'open' as PrStatusKey }
  // Inherited: master on + system on + filters match → on
  assert.equal(effectiveReviewOn(CFG, null, pr), true)
  assert.equal(effectiveFixOn(CFG, null, pr), true)
  // Master off → inherits off
  assert.equal(effectiveReviewOn({ ...CFG, masterEnabled: false }, null, pr), false)
  // System off → off
  assert.equal(effectiveReviewOn({ ...CFG, reviewEnabled: false }, null, pr), false)
  // Author filter misses → off
  assert.equal(effectiveReviewOn({ ...CFG, reviewAuthors: ['bob'] }, null, pr), false)
  assert.equal(effectiveReviewOn({ ...CFG, reviewAuthors: ['alice'] }, null, pr), true)
  // Status filter misses (PR is open, filter only wants merged) → off
  assert.equal(effectiveReviewOn({ ...CFG, reviewStatuses: ['merged'] }, null, pr), false)
  // Explicit override wins: row has reviewOn=false → off (even with everything enabled in config)
  assert.equal(effectiveReviewOn(CFG, { ...EMPTY_AUTO_ROW, reviewOn: false }, pr), false)
  // Explicitly turned on runs even with the master switch off (owner's call: works per ticket without any config)
  assert.equal(effectiveReviewOn({ ...CFG, masterEnabled: false }, { ...EMPTY_AUTO_ROW, reviewOn: true }, pr), true)
  assert.equal(effectiveFixOn({ ...CFG, masterEnabled: false }, { ...EMPTY_AUTO_ROW, fixOn: true }, pr), true)
  // optOut always wins and forces off
  assert.equal(effectiveReviewOn(CFG, { ...EMPTY_AUTO_ROW, reviewOn: true, optOut: true }, pr), false)
  assert.equal(effectiveFixOn(CFG, { ...EMPTY_AUTO_ROW, fixOn: true, optOut: true }, pr), false)
  console.log('automation-decide effective: ok')
}

// ── 1b) Auto-fix author allowlist guard (H2) ────────────────────────────────
{
  const mine = { author: 'alice', status: 'open' as PrStatusKey }
  const theirs = { author: 'bob', status: 'open' as PrStatusKey }
  // Empty author filter + inherited: only applies to the current user's (alice) own PRs, never bob's
  assert.equal(effectiveFixOnGuarded(CFG, null, mine, 'alice'), true)
  assert.equal(effectiveFixOnGuarded(CFG, null, theirs, 'alice'), false)
  // currentUser unavailable (null) + empty filter → fix nobody (safe default)
  assert.equal(effectiveFixOnGuarded(CFG, null, mine, null), false)
  // Author bob explicitly selected → fix bob's, not alice's
  assert.equal(effectiveFixOnGuarded({ ...CFG, fixAuthors: ['bob'] }, null, theirs, 'alice'), true)
  assert.equal(effectiveFixOnGuarded({ ...CFG, fixAuthors: ['bob'] }, null, mine, 'alice'), false)
  // Turning the switch on for a specific PR = manual authorization, bypasses the author allowlist (even on bob's PR)
  assert.equal(effectiveFixOnGuarded(CFG, { ...EMPTY_AUTO_ROW, fixOn: true }, theirs, 'alice'), true)
  // Explicitly off → off
  assert.equal(effectiveFixOnGuarded(CFG, { ...EMPTY_AUTO_ROW, fixOn: false }, mine, 'alice'), false)
  console.log('automation-decide fix-author-guard: ok')
}

// ── 2) Single-step branch decisions ─────────────────────────────────────────
{
  // Merged/closed → stop
  assert.equal(decideAutoAction(snap({ prStatus: 'merged' })).action.kind, 'none')
  assert.equal(decideAutoAction(snap({ prStatus: 'closed' })).action.kind, 'none')
  // optOut → stop
  assert.equal(decideAutoAction(snap({ auto: { ...snap().auto, optOut: true } })).action.kind, 'none')
  // Both switches off → stop
  assert.equal(decideAutoAction(snap({ auto: { ...snap().auto, reviewOn: false, fixOn: false } })).action.kind, 'none')

  // No review task yet + reviewOn → first review
  assert.equal(decideAutoAction(snap({ review: null })).action.kind, 'review')
  // Only auto-fix on (reviewOn off) + not reviewed yet → never creates a review by itself
  assert.equal(decideAutoAction(snap({ review: null, auto: { ...snap().auto, reviewOn: false } })).action.kind, 'none')

  // Review running → wait
  assert.equal(decideAutoAction(snap({ review: { exists: true, status: 'reviewing', headSha: 'H0' } })).action.kind, 'none')

  // Draft not posted + has findings + reviewOn → post comments automatically
  assert.equal(
    decideAutoAction(snap({ review: { exists: true, status: 'draft', headSha: 'H0' }, actionableCount: 2, reviewFindingsCount: 2 })).action.kind,
    'post',
  )
  // The PR moved since the review (once mode): no post on the stale review → one re-review, and posting is held for a human
  {
    const moved = decideAutoAction(snap({ reviewMode: 'once', headSha: 'H1', review: { exists: true, status: 'draft', headSha: 'H0' }, reviewFindingsCount: 2 }))
    assert.equal(moved.action.kind, 'recheck')
    assert.deepEqual(moved.patch, { postHeld: true, note: 'post_held' })
    const held = decideAutoAction(snap({ reviewMode: 'once', headSha: 'H1', review: { exists: true, status: 'draft', headSha: 'H1' }, reviewFindingsCount: 2, auto: { ...snap().auto, postHeld: true } }))
    assert.equal(held.action.kind, 'none', 'after that re-review nothing is posted automatically')
    assert.equal(held.reason, 'post-held')
    // every_push: a moved head is a normal re-review (branch 3), not a hold
    assert.equal(decideAutoAction(snap({ headSha: 'H1', review: { exists: true, status: 'draft', headSha: 'H0' } })).reason, 'author-updated-recheck')
  }
  // Clean PR: draft but 0 findings → don't post an empty comment (no more spinning on the post endpoint's 400)
  assert.equal(
    decideAutoAction(snap({ review: { exists: true, status: 'draft', headSha: 'H0' }, actionableCount: 0, reviewFindingsCount: 0 })).action.kind,
    'none',
  )

  // Posted + has actionable findings + this head hasn't been fixed yet → fix
  {
    const d = decideAutoAction(snap({
      review: { exists: true, status: 'posted', headSha: 'H0' },
      actionableCount: 2,
      auto: { ...snap().auto, lastFixReviewSha: null },
    }))
    assert.equal(d.action.kind, 'fix')
    assert.equal(d.patch?.round, 1)
    assert.equal(d.patch?.lastFixReviewSha, 'H0')
    assert.equal(d.patch?.pendingFix, true)
  }

  // Same review head already fixed (lastFixReviewSha == review.headSha) → don't fix again
  assert.equal(
    decideAutoAction(snap({
      review: { exists: true, status: 'posted', headSha: 'H0' },
      actionableCount: 2,
      auto: { ...snap().auto, lastFixReviewSha: 'H0' },
    })).action.kind,
    'none',
  )

  // every_push + head changed → recheck
  assert.equal(
    decideAutoAction(snap({
      reviewMode: 'every_push',
      headSha: 'H1',
      review: { exists: true, status: 'posted', headSha: 'H0' },
    })).action.kind,
    'recheck',
  )
  // once mode + head changed → no recheck
  assert.equal(
    decideAutoAction(snap({
      reviewMode: 'once',
      headSha: 'H1',
      review: { exists: true, status: 'posted', headSha: 'H0' },
      actionableCount: 0,
      auto: { ...snap().auto, lastFixReviewSha: 'H0', round: 1 },
    })).action.kind,
    'none',
  )

  // Cap: round already at max + still needs fixing → cap (both switches off + note=capped)
  // headSha aligned with review.headSha (head didn't change again, so no recheck), isolating the fix/cap branch
  {
    const d = decideAutoAction(snap({
      headSha: 'H2',
      review: { exists: true, status: 'posted', headSha: 'H2' },
      actionableCount: 2,
      maxRounds: 2,
      auto: { ...snap().auto, round: 2, lastFixReviewSha: 'H1' },
    }))
    assert.equal(d.action.kind, 'cap')
    assert.equal(d.patch?.reviewOn, false)
    assert.equal(d.patch?.fixOn, false)
    assert.equal(d.patch?.note, 'capped')
  }

  // Converged: reviewed + no actionable findings + fixed at least one round → none + note=converged
  {
    const d = decideAutoAction(snap({
      headSha: 'H1',
      review: { exists: true, status: 'posted', headSha: 'H1' },
      actionableCount: 0,
      auto: { ...snap().auto, round: 1, lastFixReviewSha: 'H1' },
    }))
    assert.equal(d.action.kind, 'none')
    assert.equal(d.patch?.note, 'converged')
  }
  console.log('automation-decide branches: ok')
}

// ── 3) pendingFix wrap-up: push / nothing fixable / error ───────────────────
{
  const base = snap({ auto: { ...snap().auto, pendingFix: true } })
  // Still running → wait
  assert.equal(decideAutoAction({ ...base, fix: { status: 'open', chatting: true } }).action.kind, 'none')
  // Finished with something uploadable → push
  assert.equal(decideAutoAction({ ...base, fix: { status: 'ready', chatting: false } }).action.kind, 'push')
  // Finished with nothing uploadable (couldn't fix it) → stop + clear pendingFix + note=cant_fix
  {
    const d = decideAutoAction({ ...base, fix: { status: 'open', chatting: false } })
    assert.equal(d.action.kind, 'none')
    assert.equal(d.patch?.pendingFix, false)
    assert.equal(d.patch?.note, 'cant_fix')
  }
  // Finished with an error → note=fix_error
  {
    const d = decideAutoAction({ ...base, fix: { status: 'error', chatting: false } })
    assert.equal(d.patch?.note, 'fix_error')
  }
  console.log('automation-decide pendingFix: ok')
}

// ── 4) Full-loop simulator: run decide repeatedly + mimic action side effects, prove it always stops ──
// world mimics how the real pipeline moves state; actionableGen decides how many items remain after each review/recheck.
function simulate(opts: {
  reviewMode: 'once' | 'every_push'
  maxRounds: number
  actionableAfter: (reviewRound: number) => number // items left to fix after the nth review/recheck
}) {
  let headN = 0
  const head = () => `H${headN}`
  let reviewRound = 0
  let actionable = 0
  let review: PrSnapshot['review'] = null
  let fix: PrSnapshot['fix'] = null
  const auto = { reviewOn: true, fixOn: true, round: 0, lastFixReviewSha: null as string | null, pendingFix: false, optOut: false, note: null as string | null }
  const trace: string[] = []
  let fixDispatches = 0

  for (let step = 0; step < 60; step++) {
    const s: PrSnapshot = {
      prStatus: 'open', headSha: head(), reviewMode: opts.reviewMode, maxRounds: opts.maxRounds,
      actionableCount: actionable, reviewFindingsCount: review ? 2 : 0, review, fix, auto: { ...auto },
    }
    const d = decideAutoAction(s)
    // apply patch
    if (d.patch) {
      if (d.patch.round != null) auto.round = d.patch.round
      if (d.patch.lastFixReviewSha !== undefined) auto.lastFixReviewSha = d.patch.lastFixReviewSha
      if (d.patch.pendingFix != null) auto.pendingFix = d.patch.pendingFix
      if (d.patch.note !== undefined) auto.note = d.patch.note ?? null
      if (d.patch.reviewOn != null) auto.reviewOn = d.patch.reviewOn
      if (d.patch.fixOn != null) auto.fixOn = d.patch.fixOn
    }
    trace.push(d.action.kind)
    // simulate the action's side effects (mimic what the real endpoints do to the world)
    switch (d.action.kind) {
      case 'review':
        reviewRound++
        review = { exists: true, status: 'draft', headSha: head() }
        actionable = opts.actionableAfter(reviewRound)
        break
      case 'recheck':
        reviewRound++
        review = { exists: true, status: 'draft', headSha: head() }
        actionable = opts.actionableAfter(reviewRound)
        break
      case 'post':
        review = { ...review!, status: 'posted' }
        break
      case 'fix':
        fixDispatches++
        fix = { status: 'ready', chatting: false } // assume the fix produced uploadable changes
        break
      case 'push':
        headN++ // pushed → head changes
        fix = { status: 'pushed', chatting: false }
        auto.pendingFix = false // the engine clears it after a successful push (decide's push branch carries no such patch)
        break
      case 'cap':
        return { ended: 'cap', step, trace, fixDispatches, auto }
      case 'none':
        if (['converged', 'idle', 'both-off', 'opt-out', 'pr-closed'].includes(d.reason)) {
          return { ended: d.reason, step, trace, fixDispatches, auto }
        }
        break
    }
  }
  return { ended: 'TIMEOUT', step: 60, trace, fixDispatches, auto }
}

// 4a) Never fully fixed (2 items left every round) → must cap after maxRounds fixes
{
  const r = simulate({ reviewMode: 'every_push', maxRounds: 2, actionableAfter: () => 2 })
  assert.equal(r.ended, 'cap', `expected cap, got ${r.ended} · trace=${r.trace.join('>')}`)
  assert.equal(r.fixDispatches, 2, `expected exactly 2 fixes, got ${r.fixDispatches}`)
  console.log(`automation-decide loop/cap: ok (修 ${r.fixDispatches} 次后封顶，${r.step} 步)`)
}

// 4b) First recheck already finds everything fixed (0 items afterwards) → converges without using up maxRounds
{
  const r = simulate({ reviewMode: 'every_push', maxRounds: 5, actionableAfter: (n) => (n >= 2 ? 0 : 2) })
  assert.equal(r.ended, 'converged', `expected converged, got ${r.ended} · trace=${r.trace.join('>')}`)
  assert.equal(r.fixDispatches, 1, `expected to converge after just 1 fix, got ${r.fixDispatches}`)
  console.log(`automation-decide loop/converge: ok (修 ${r.fixDispatches} 次后收敛，${r.step} 步)`)
}

// 4c) once mode + fix: review once + fix once + push, then no auto recheck → no spinning, record fix_unverified, switches off, stop (M3)
{
  const r = simulate({ reviewMode: 'once', maxRounds: 3, actionableAfter: () => 2 })
  assert.equal(r.fixDispatches, 1, `once mode expected exactly 1 fix, got ${r.fixDispatches}`)
  assert.equal(r.auto.note, 'fix_unverified', `expected fix_unverified, got ${r.auto.note} · trace=${r.trace.join('>')}`)
  assert.ok(!r.trace.includes('recheck'), 'once mode should never recheck')
  console.log(`automation-decide loop/once: ok (修 ${r.fixDispatches} 次后记 fix_unverified 停手，${r.step} 步)`)
}

// 4d) maxRounds=3 likewise caps after 3 fixes (parameterized check that the limit is configurable)
{
  const r = simulate({ reviewMode: 'every_push', maxRounds: 3, actionableAfter: () => 1 })
  assert.equal(r.ended, 'cap')
  assert.equal(r.fixDispatches, 3)
  console.log('automation-decide loop/cap-3: ok')
}

console.log('automation-decide: all ok')
