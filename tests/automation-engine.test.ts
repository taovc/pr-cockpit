import assert from 'node:assert/strict'
import { nanoid } from 'nanoid'
import { and, eq } from 'drizzle-orm'
import { getDb, schema } from '../core/db/client'
import { runAutomationTick, type EngineDeps } from '../core/automation/engine'
import { getPrAutomationRow } from '../core/automation/state'
import { buildAutoFixMessage } from '../core/automation/fixprompt'

// Fully in-memory engine integration test: runs the real runAutomationTick + state/findings/decide against a
// :memory: SQLite DB, but replaces every dispatch that would touch GitHub/git (create review / recheck / post comment /
// fix / push) with a stand-in that only simulates its side effects in the in-memory DB.
// Zero external side effects: no gh calls, no PRs opened, no worktree touched. Verifies that the whole loop also caps /
// converges / respects opt-out / gives up when it can't fix, on the real code path.

const d = getDb(':memory:')
const now = () => new Date().toISOString()
const PID = 'P1'
const PR = 7

d.insert(schema.projects).values({
  id: PID, name: 'p', slug: 'p', repo: 'o/r', localPath: '/tmp/clone', defaultBranch: 'main',
  provider: 'claude', autoMaxRounds: 2, autoCooldownMinutes: 0, createdAt: now(), // cooldown off, tested separately at the end
}).run()

function setConfig(over: Partial<any> = {}) {
  const row = {
    projectId: PID, masterEnabled: true, reviewEnabled: true, reviewMode: 'every_push' as const,
    reviewAuthors: '[]', reviewStatuses: '["open","draft"]', fixEnabled: true, fixAuthors: '[]', fixStatuses: '["open","draft"]',
    updatedAt: now(), ...over,
  }
  const existing = d.select().from(schema.projectAutomation).where(eq(schema.projectAutomation.projectId, PID)).get()
  if (existing) d.update(schema.projectAutomation).set(row).where(eq(schema.projectAutomation.projectId, PID)).run()
  else d.insert(schema.projectAutomation).values(row).run()
}

function resetWorld() {
  for (const t of [schema.findingRechecks, schema.findings, schema.reviews, schema.runs, schema.prAutomation]) {
    d.delete(t).run()
  }
}

// ── Stand-ins: simulate each endpoint's side effects in the in-memory DB, driven by test knobs (head advancing / recheck verdict / whether the fix produces anything) ──
function makeWorld(opts: { convergeAfter?: number; fixProducesChanges?: boolean }) {
  const convergeAfter = opts.convergeAfter ?? Infinity // which review round declares everything fixed
  const fixProducesChanges = opts.fixProducesChanges ?? true
  let headN = 0
  const head = () => `H${headN}`
  let reviewRound = 0
  const calls = { review: 0, recheck: 0, post: 0, fix: 0, push: 0 }

  const insertFindings = (reviewId: string, n: number) => {
    for (let i = 0; i < n; i++) {
      d.insert(schema.findings).values({
        id: nanoid(), reviewId, fid: `F${i + 1}`, severity: 'High', title: `bug ${i}`,
        introducedByPr: true, checked: false, sortOrder: i, createdAt: now(),
      }).run()
    }
  }
  const setRechecks = (reviewId: string, status: string, round: number) => {
    const fs = d.select().from(schema.findings).where(eq(schema.findings.reviewId, reviewId)).all() as any[]
    for (const f of fs) {
      d.insert(schema.findingRechecks).values({ id: nanoid(), findingId: f.id, round, status, at: now() }).run()
    }
  }

  const deps: EngineDeps = {
    now,
    isChatting: () => false,
    log: () => {},
    currentUser: 'alice', // default of the auto-fix author allowlist; the PR author is alice too, so it passes
    listPulls: async () => ({ pulls: [{ number: PR, author: 'alice', headSha: head(), state: 'open', isDraft: false }] }),
    dispatchReview: async (pid, pr) => {
      calls.review++; reviewRound++
      d.insert(schema.reviews).values({
        id: 'R1', projectId: pid, prNumber: pr, prUrl: 'u', branch: 'b', headSha: head(),
        status: 'draft', prState: 'open', createdAt: now(), updatedAt: now(),
      }).run()
      insertFindings('R1', 2)
    },
    dispatchRecheck: async (rid) => {
      calls.recheck++; reviewRound++
      setRechecks(rid, reviewRound >= convergeAfter ? 'fixed' : 'unaddressed', reviewRound)
      d.update(schema.reviews).set({ status: 'draft', headSha: head(), updatedAt: now() }).where(eq(schema.reviews.id, rid)).run()
    },
    dispatchPost: async (rid) => {
      calls.post++
      d.update(schema.reviews).set({ status: 'posted', updatedAt: now() }).where(eq(schema.reviews.id, rid)).run()
      return { posted: true }
    },
    dispatchFix: async (pid, pr) => {
      calls.fix++
      // fixProducesChanges=true → the fix produced uploadable changes (ready); false → it couldn't fix anything (stays open)
      const status = fixProducesChanges ? 'ready' : 'open'
      // A PR session run; the legacy fix status is expressed through upload_state / status.
      const patch = status === 'ready' ? { status: 'idle', uploadState: 'ready' } : status === 'pushed' ? { status: 'idle', uploadState: 'pushed' } : status === 'error' ? { status: 'error' } : { status: 'idle', uploadState: 'none' }
      const existing = d.select().from(schema.runs).where(and(eq(schema.runs.projectId, pid), eq(schema.runs.prNumber, pr))).get() as any
      if (existing) d.update(schema.runs).set({ ...patch, updatedAt: now() } as any).where(eq(schema.runs.id, existing.id)).run()
      else d.insert(schema.runs).values({ id: 'FX1', kind: 'session', subkind: 'session', provider: 'claude', projectId: pid, workspaceType: 'pr_worktree', prNumber: pr, branch: 'b', ...patch, createdAt: now(), updatedAt: now() } as any).run()
    },
    dispatchPush: async (fid) => {
      calls.push++; headN++ // pushed → head moves
      d.update(schema.runs).set({ status: 'idle', uploadState: 'pushed', lastPushSha: head(), pushedAt: now(), updatedAt: now() } as any).where(eq(schema.runs.id, fid)).run()
    },
  }
  return { deps, calls }
}

// Keep ticking until it settles (dispatch counts unchanged across two rounds) or the cap is hit
async function runUntilStable(deps: EngineDeps, calls: any, max = 40) {
  let prev = -1
  for (let i = 0; i < max; i++) {
    await runAutomationTick(d, schema, deps)
    const total = calls.review + calls.recheck + calls.post + calls.fix + calls.push
    if (total === prev) return i
    prev = total
  }
  return max
}

// ── 1) Never fully fixed → the real engine also caps after exactly 2 fixes, both switches turn off automatically, note=capped ──
{
  resetWorld(); setConfig()
  const { deps, calls } = makeWorld({ convergeAfter: Infinity })
  await runUntilStable(deps, calls)
  assert.equal(calls.fix, 2, `expected the cap at 2 fixes, got ${calls.fix}`)
  assert.equal(calls.push, 2, `expected 2 pushes`)
  assert.ok(calls.recheck >= 2, `expected at least 2 rechecks, got ${calls.recheck}`)
  const row = getPrAutomationRow(d, schema, PID, PR)!
  assert.equal(row.note, 'capped')
  assert.equal(row.reviewOn, false)
  assert.equal(row.fixOn, false)
  // The workflow timeline is persisted: at least the review-created + fix + push + capped events are there
  const evs = d.select().from(schema.automationEvents).where(eq(schema.automationEvents.projectId, PID)).all() as any[]
  const kinds = new Set(evs.map((e) => e.kind))
  assert.ok(kinds.has('review_created') && kinds.has('fix_started') && kinds.has('pushed') && kinds.has('capped'), `timeline events should all be present, got ${[...kinds].join(',')}`)
  console.log(`automation-engine cap: ok (review${calls.review}/recheck${calls.recheck}/post${calls.post}/fix${calls.fix}/push${calls.push}, 时间线 ${evs.length} 条)`)
}

// ── 2) The second review (first review=1, recheck=2) declares everything fixed → converged, only 1 fix ──
{
  resetWorld(); setConfig()
  const { deps, calls } = makeWorld({ convergeAfter: 2 })
  await runUntilStable(deps, calls)
  assert.equal(calls.fix, 1, `expected convergence after only 1 fix, got ${calls.fix}`)
  const row = getPrAutomationRow(d, schema, PID, PR)!
  assert.equal(row.note, 'converged')
  console.log(`automation-engine converge: ok (fix${calls.fix}/recheck${calls.recheck})`)
}

// ── 3) opt-out (simulating a deleted task) → the engine does nothing at all ──
{
  resetWorld(); setConfig()
  d.insert(schema.prAutomation).values({
    id: nanoid(), projectId: PID, prNumber: PR, reviewOn: false, fixOn: false, optOut: true, round: 0, pendingFix: false, updatedAt: now(),
  }).run()
  const { deps, calls } = makeWorld({ convergeAfter: Infinity })
  await runUntilStable(deps, calls)
  assert.equal(calls.review + calls.fix + calls.push, 0, 'the engine must not act after opt-out')
  console.log('automation-engine opt-out: ok')
}

// ── 4) Can't fix (the fix ran but produced no uploadable changes) → only 1 fix dispatched, no push, note=cant_fix, stop ──
{
  resetWorld(); setConfig()
  const { deps, calls } = makeWorld({ convergeAfter: Infinity, fixProducesChanges: false })
  await runUntilStable(deps, calls)
  assert.equal(calls.fix, 1, `when it can't fix, only 1 fix should be dispatched, got ${calls.fix}`)
  assert.equal(calls.push, 0, "no push when it can't fix")
  const row = getPrAutomationRow(d, schema, PID, PR)!
  assert.equal(row.note, 'cant_fix')
  assert.equal(row.round, 1, 'the round where it could not fix still spends one round of budget')
  console.log('automation-engine cant-fix: ok')
}

// ── 6) Posting the comment fails → stop the PR's whole automation: no further fix/push, both switches off, note=post_error, post_error on the timeline ──
{
  resetWorld(); setConfig()
  const { deps, calls } = makeWorld({ convergeAfter: Infinity })
  // Override dispatchPost: simulate a publish failure (translation timeout) and, like the plugin does, move the review out of draft to stop the bleeding
  deps.dispatchPost = async (rid) => {
    calls.post++
    d.update(schema.reviews).set({ status: 'ready_to_post', updatedAt: now() }).where(eq(schema.reviews.id, rid)).run()
    return { posted: false, error: '翻译超时' }
  }
  await runUntilStable(deps, calls)
  assert.equal(calls.fix, 0, 'auto-fix must never continue after a failed post')
  assert.equal(calls.push, 0, 'must never push after a failed post')
  const row = getPrAutomationRow(d, schema, PID, PR)!
  assert.equal(row.note, 'post_error')
  assert.equal(row.reviewOn, false)
  assert.equal(row.fixOn, false)
  const evs = d.select().from(schema.automationEvents).where(eq(schema.automationEvents.projectId, PID)).all() as any[]
  assert.ok(evs.some((e) => e.kind === 'post_error'), 'the timeline should contain post_error')
  console.log('automation-engine post-error-stops: ok')
}

// ── 7) Push fails (a precondition 4xx, e.g. the worktree was deleted) → clear pendingFix, stop automation, record push_error, no endless hot loop ──
{
  resetWorld(); setConfig()
  const { deps, calls } = makeWorld({ convergeAfter: Infinity })
  // Override dispatchPush: simulate push.post.ts throwing before it sets fix=error (the worktree is gone)
  deps.dispatchPush = async () => { calls.push++; throw new Error('worktree 不在了') }
  await runUntilStable(deps, calls)
  assert.equal(calls.push, 1, 'must never retry every round after a failed push (hot loop)')
  const row = getPrAutomationRow(d, schema, PID, PR)!
  assert.equal(row.pendingFix, false, 'a failed push must clear pendingFix, otherwise step 1 of decide picks push forever')
  assert.equal(row.note, 'push_error')
  assert.equal(row.reviewOn, false)
  assert.equal(row.fixOn, false)
  const evs = d.select().from(schema.automationEvents).where(eq(schema.automationEvents.projectId, PID)).all() as any[]
  assert.ok(evs.some((e) => e.kind === 'push_error'), 'the timeline should contain push_error')
  console.log('automation-engine push-error-stops: ok')
}

// ── 8) Auto-fix author allowlist: currentUser=alice, PR author=bob, empty author filter → don't fix bob's PR (review only) ──
{
  resetWorld(); setConfig() // fixAuthors empty
  const { deps, calls } = makeWorld({ convergeAfter: Infinity })
  deps.currentUser = 'alice'
  deps.listPulls = async () => ({ pulls: [{ number: PR, author: 'bob', headSha: 'Hb', state: 'open', isDraft: false }] })
  await runUntilStable(deps, calls)
  assert.equal(calls.fix, 0, "an empty author filter must not auto-fix someone else's (bob's) PR")
  assert.equal(calls.push, 0)
  assert.ok(calls.review >= 1, "auto-review may still run on someone else's PR (read-only)")
  console.log('automation-engine fix-author-guard: ok')
}

// ── 5) Auto-review only (no fixing) → review once + post the comment, never enter fixing, stops by itself ──
{
  resetWorld(); setConfig({ fixEnabled: false, reviewMode: 'once' })
  const { deps, calls } = makeWorld({ convergeAfter: Infinity })
  await runUntilStable(deps, calls)
  assert.equal(calls.review, 1)
  assert.equal(calls.post, 1)
  assert.equal(calls.fix, 0, 'no fixing when auto-fix is off')
  console.log('automation-engine review-only: ok')
}

// ── 9) Cooldown: do nothing for 5 minutes after a head is first seen, only then start the review (a controllable clock simulates elapsed time) ──
{
  resetWorld(); setConfig()
  d.update(schema.projects).set({ autoCooldownMinutes: 5 }).where(eq(schema.projects.id, PID)).run()
  let clockMs = Date.UTC(2026, 0, 1, 0, 0, 0)
  const isoNow = () => new Date(clockMs).toISOString()
  const { deps, calls } = makeWorld({ convergeAfter: Infinity })
  deps.now = isoNow

  await runAutomationTick(d, schema, deps) // head seen for the first time → cooldown starts
  assert.equal(calls.review, 0, 'no review must start during the cooldown')
  const evs = d.select().from(schema.automationEvents).where(eq(schema.automationEvents.projectId, PID)).all() as any[]
  assert.ok(evs.some((e) => e.kind === 'cooldown'), 'a cooldown event should be recorded')

  clockMs += 3 * 60_000 // 3 minutes in (<5)
  await runAutomationTick(d, schema, deps)
  assert.equal(calls.review, 0, 'still cooling down at 3 minutes')

  clockMs += 3 * 60_000 // 6 minutes total (>5)
  await runAutomationTick(d, schema, deps)
  assert.equal(calls.review, 1, 'the review should start once the cooldown is over')
  d.update(schema.projects).set({ autoCooldownMinutes: 0 }).where(eq(schema.projects.id, PID)).run() // restore on the way out
  console.log('automation-engine cooldown: ok')
}

// ── 10) Auto-fix switched off midway (auto-review still on) + fix already ready + pendingFix → don't push on the user's behalf, clear pendingFix ──
{
  resetWorld(); setConfig()
  const { deps, calls } = makeWorld({ convergeAfter: Infinity })
  // Set the stage: a posted review + 2 High findings + a ready fix + pr_automation (fixOn explicitly off, reviewOn inherited on, pendingFix=true)
  d.insert(schema.reviews).values({ id: 'R1', projectId: PID, prNumber: PR, prUrl: 'u', branch: 'b', headSha: 'H0', status: 'posted', prState: 'open', createdAt: now(), updatedAt: now() }).run()
  for (let i = 0; i < 2; i++) d.insert(schema.findings).values({ id: nanoid(), reviewId: 'R1', fid: `F${i}`, severity: 'High', title: 'x', introducedByPr: true, checked: false, sortOrder: i, createdAt: now() }).run()
  d.insert(schema.runs).values({ id: 'FX1', kind: 'session', subkind: 'session', provider: 'claude', projectId: PID, workspaceType: 'pr_worktree', prNumber: PR, branch: 'b', status: 'idle', uploadState: 'ready', createdAt: now(), updatedAt: now() } as any).run()
  d.insert(schema.prAutomation).values({ id: nanoid(), projectId: PID, prNumber: PR, reviewOn: null, fixOn: false, pendingFix: true, round: 1, optOut: false, updatedAt: now() }).run()
  await runAutomationTick(d, schema, deps)
  assert.equal(calls.push, 0, 'with auto-fix off, the in-flight fix must not be pushed')
  assert.equal(getPrAutomationRow(d, schema, PID, PR)!.pendingFix, false, 'pendingFix should be cleared')
  console.log('automation-engine off-autofix-no-push: ok')
}

// ── 11) Unattended gate: a scope review whose only "must" findings are Low (or rated noise) has nothing to post or fix ──
for (const [label, rows] of [
  ['low-only', [{ severity: 'Low', rating: null }, { severity: 'Low', rating: null }]],
  ['rated-noise', [{ severity: 'High', rating: 'noise' }]],
] as const) {
  resetWorld(); setConfig()
  const { deps, calls } = makeWorld({ convergeAfter: Infinity })
  deps.dispatchReview = async (pid, pr) => {
    calls.review++
    d.insert(schema.reviews).values({ id: 'R1', projectId: pid, prNumber: pr, prUrl: 'u', branch: 'b', headSha: 'H0', status: 'draft', prState: 'open', createdAt: now(), updatedAt: now() }).run()
    rows.forEach((r, i) => d.insert(schema.findings).values({
      id: nanoid(), reviewId: 'R1', fid: `F${i + 1}`, severity: r.severity, title: 'x', introducedByPr: true, checked: false, sortOrder: i, createdAt: now(),
      tier: 'must', source: 'engine', verifyStatus: 'confirmed', rating: r.rating,
    } as any).run())
  }
  await runUntilStable(deps, calls)
  assert.equal(calls.review, 1)
  assert.equal(calls.post, 0, `${label}: nothing may be posted unattended (the draft stays silent)`)
  assert.equal(calls.fix, 0, `${label}: nothing may be fixed unattended`)
  assert.equal(calls.push, 0)
  console.log(`automation-engine unattended-gate ${label}: ok`)
}

// ── 12) The project's verify command fails before the upload → no push, both switches off, note + event verify_failed, no re-dispatch, round unchanged ──
{
  resetWorld(); setConfig(); d.delete(schema.automationEvents).run()
  const { deps, calls } = makeWorld({ convergeAfter: Infinity })
  deps.dispatchPush = async () => { calls.push++; return { verifyFailed: true as const, tail: 'FAIL tests/a.test.ts\nexpected 1, got 2' } }
  await runUntilStable(deps, calls)
  assert.equal(calls.fix, 1)
  assert.equal(calls.push, 1, 'a failed check is not retried every tick')
  const row = getPrAutomationRow(d, schema, PID, PR)!
  assert.equal(row.note, 'verify_failed')
  assert.equal(row.reviewOn, false)
  assert.equal(row.fixOn, false)
  assert.equal(row.pendingFix, false)
  assert.equal(row.round, 1, 'the failed check does not spend or reset a round')
  const fx = d.select().from(schema.runs).where(eq(schema.runs.id, 'FX1')).get() as any
  assert.equal(fx.uploadState, 'ready', 'nothing was pushed: the changes stay uploadable by hand')
  const evs = d.select().from(schema.automationEvents).where(eq(schema.automationEvents.projectId, PID)).all() as any[]
  const ev = evs.find((e) => e.kind === 'verify_failed')
  assert.ok(ev && ev.message.includes('expected 1, got 2'), 'the timeline keeps the output tail')
  assert.ok(!evs.some((e) => e.kind === 'push_error' || e.kind === 'pushed'), 'distinct from push_error')
  const before = { ...calls }
  await runAutomationTick(d, schema, deps); await runAutomationTick(d, schema, deps)
  assert.deepEqual(calls, before, 'nothing is dispatched on later ticks (no new fix turn, no push)')
  for (const lang of ['zh', 'en', 'fr']) assert.match(buildAutoFixMessage(d, schema, 'R1', lang)!, /lint/, `the ${lang} auto-fix instruction asks for the checks and their output`)
  console.log('automation-engine verify-failed-stops: ok')
}

console.log('automation-engine: all ok')
