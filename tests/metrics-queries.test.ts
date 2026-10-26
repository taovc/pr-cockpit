import assert from 'node:assert/strict'
import { nanoid } from 'nanoid'
import { getDb, schema } from '../core/db/client'
import { countRuns, metricsOverview, percentile, precisionBySkillVersion, recentRuns, recheckFunnel, reviewRunsByModel } from '../core/metrics/queries'
import { createRun, recordRunUsage, finishRun } from '../core/runs/store'

// Dashboard queries against a seeded in-memory DB. The key property: only HUMAN checks count as accepted.
const d = getDb(':memory:')
const now = () => new Date().toISOString()
d.insert(schema.projects).values({ id: 'P', name: 'proj', slug: 'p', repo: 'o/r', defaultBranch: 'main', createdAt: now() }).run()
d.insert(schema.skills).values({ id: 'S', projectId: 'P', name: 'method', content: 'x', source: 'ai', createdAt: now() }).run()
d.insert(schema.skillVersions).values({ id: 'SV1', skillId: 'S', version: 1, content: 'x', contentSha: 'sha', source: 'ai', createdAt: now() }).run()

function review(id: string, skillVersionId: string | null, findings: Array<{ checked: boolean; by: 'human' | 'auto' | 'engine' | null; posted?: boolean; accepted?: boolean }>, cost: number | null, model = 'opus', effort = 'high', durationMs = 60_000) {
  d.insert(schema.reviews).values({ id, projectId: 'P', prNumber: Number(id.replace(/\D/g, '')) || 1, prUrl: 'u', branch: 'b', status: 'draft', prState: 'open', skillVersionId, createdAt: now(), updatedAt: now() }).run()
  findings.forEach((f, i) => {
    // human_accepted_at is what the PATCH handler sets on a human tick (sticky); legacy rows get it from the startup backfill
    const accepted = f.accepted ?? (f.checked && (f.by === 'human' || f.by === null))
    d.insert(schema.findings).values({ id: `${id}-F${i}`, reviewId: id, fid: `F${i}`, severity: 'High', title: 't', introducedByPr: true, checked: f.checked, checkedBy: f.by, humanAcceptedAt: accepted ? now() : null, postedPostId: f.posted ? 'post' : null, sortOrder: i, createdAt: now() }).run()
  })
  const runId = createRun(d, schema, { kind: 'review', subkind: 'review', provider: 'claude', projectId: 'P', reviewId: id, model, effort, skillId: 'S', skillVersionId })
  recordRunUsage(d, schema, runId, cost == null ? null : { models: [{ model, inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: cost, costSource: 'reported' }], costUsd: cost, costSource: 'reported', durationMs, numTurns: 3 })
  finishRun(d, schema, runId, { status: 'done' })
}

// Skill v1: 2 reviews, 5 findings, 2 human-accepted, 1 auto-checked, 1 engine-checked → precision 2/5, cost $1.0 → $0.5 per accepted
review('R1', 'SV1', [{ checked: true, by: 'human', posted: true }, { checked: true, by: 'auto' }, { checked: false, by: null }], 0.6)
review('R2', 'SV1', [{ checked: true, by: 'human' }, { checked: true, by: 'engine' }], 0.4, 'opus', 'high', 120_000)
// Same skill, but nobody triaged it (draft with an untouched finding) → must NOT count against precision
review('R9', 'SV1', [{ checked: false, by: null }, { checked: false, by: null }], 0.9)
// Default methodology (no skill version): 1 review, 1 finding checked by a human
review('R3', null, [{ checked: true, by: 'human' }], null, 'sonnet', 'medium')
// Pre-upgrade tick (checked, NULL provenance) counts as human
review('R4', null, [{ checked: true, by: null }], null, 'sonnet', 'medium')
// The success path: a human ticked it, the author fixed it, the drawer auto-unchecked it → still accepted (sticky)
review('R5', 'SV1', [{ checked: false, by: 'auto', accepted: true }], 0.1)
// Skill generation is a run too, but must not enter the review latency/cost percentiles
{ const gid = createRun(d, schema, { kind: 'review', subkind: 'skillgen', provider: 'claude', projectId: 'P', model: 'opus', effort: 'high' }); recordRunUsage(d, schema, gid, { models: [{ model: 'opus', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 9, costSource: 'reported' }], costUsd: 9, costSource: 'reported', durationMs: 999_000, numTurns: 1 }); finishRun(d, schema, gid, { status: 'done' }) }

const prec = precisionBySkillVersion(d, { projectId: 'P' })
const v1 = prec.find((r: any) => r.skill_version_id === 'SV1')!
assert.equal(Number(v1.reviews), 3, 'R1, R2 and the auto-unchecked R5 are triaged; the untouched draft R9 is not')
assert.equal(Number(v1.findings), 6)
assert.equal(Number(v1.human_accepted), 3, 'auto/engine checks must not count; a sticky human acceptance survives auto-uncheck')
assert.equal(Number(v1.machine_checked), 2)
assert.equal(Number(v1.posted), 1)
assert.ok(Math.abs(v1.precision - 0.5) < 1e-9)
assert.ok(Math.abs(v1.cost_usd - 1.1) < 1e-9)
assert.ok(Math.abs(v1.costPerAccepted - 1.1 / 3) < 1e-9)
const dflt = prec.find((r: any) => r.skill_version_id == null)!
assert.equal(Number(dflt.findings), 2)
assert.equal(Number(dflt.human_accepted), 2, 'NULL provenance on a ticked finding = pre-upgrade human tick')
assert.equal(dflt.costPerAccepted, null, 'unpriced runs → no cost per accepted')
console.log('metrics precision: ok')

// Model × effort: opus/high has 2 runs (60s, 120s) → p50 60s; sonnet/medium 1 run
const byModel = reviewRunsByModel(d, { projectId: 'P' })
const opus = byModel.find((r) => r.model === 'opus' && r.effort === 'high')!
assert.equal(opus.runs, 4, 'skillgen run excluded from review percentiles')
assert.equal(opus.p50DurationMs, 60_000)
assert.equal(opus.p95DurationMs, 120_000)
assert.ok(Math.abs(opus.avgCostUsd! - (2.0 / 4)) < 1e-9)
assert.equal(byModel.find((r) => r.model === 'sonnet')!.avgCostUsd, null)
assert.equal(percentile([], 50), null)
assert.equal(percentile([5, 1, 3], 50), 3)

// Recheck funnel: latest entry per finding by time — R1-F0 retracted (guided), R1-F1 fixed then unaddressed (latest wins),
// R2-F0 has a guided round 1 AND an author round 1 (separate counters): only the later one counts.
const t0 = '2026-01-01T00:00:00.000Z', t1 = '2026-01-02T00:00:00.000Z'
d.insert(schema.findingRechecks).values({ id: nanoid(), findingId: 'R1-F0', round: 1, status: 'retracted', at: t0 }).run()
d.insert(schema.findingRechecks).values({ id: nanoid(), findingId: 'R1-F1', round: 1, status: 'fixed', at: t0 }).run()
d.insert(schema.findingRechecks).values({ id: nanoid(), findingId: 'R1-F1', round: 2, status: 'unaddressed', at: t1 }).run()
d.insert(schema.findingRechecks).values({ id: nanoid(), findingId: 'R2-F0', round: 1, status: 'kept', at: t0 }).run()
d.insert(schema.findingRechecks).values({ id: nanoid(), findingId: 'R2-F0', round: 1, status: 'fixed', at: t1 }).run()
const rc = recheckFunnel(d, { projectId: 'P' })
assert.equal(rc.byStatus.retracted, 1)
assert.equal(rc.byStatus.unaddressed, 1)
assert.equal(rc.byStatus.fixed, 1, 'R2-F0: the later author round wins over the same-numbered guided round')
assert.equal(rc.byStatus.kept, undefined)
assert.ok(Math.abs(rc.retractionRate! - 1) < 1e-9, 'retracted / guided-latest (only R1-F0 remains guided)')

// Filters: a project id with no data → empty everything, no throw
const empty = metricsOverview(d, { projectId: 'nope' })
assert.equal(empty.runsBySubkind.length, 0)
assert.equal(recentRuns(d, { projectId: 'nope' }).length, 0)
assert.equal(countRuns(d, { projectId: 'nope' }), 0)
const full = metricsOverview(d, {})
// The run list pages with limit/offset and reports the total separately
assert.equal(recentRuns(d, {}).length, 7)
assert.equal(countRuns(d, {}), 7)
assert.equal(recentRuns(d, {}, { limit: 3, offset: 0 }).length, 3)
assert.equal(recentRuns(d, {}, { limit: 3, offset: 6 }).length, 1)
assert.equal(full.costByDay.length, 1)
assert.ok(full.runsBySubkind.some((r: any) => r.subkind === 'review' && Number(r.runs) === 6 && Number(r.unpriced) === 2))
assert.ok(full.runsBySubkind.some((r: any) => r.subkind === 'skillgen' && Number(r.runs) === 1))
// date filter applies to cost too: a window that excludes everything → no cost, no rows
assert.equal(precisionBySkillVersion(d, { from: '2999-01-01' }).length, 0)
// ── scope-review stage rows break a review down; the review's own row carries the total, so nothing counts twice ──
const runsBefore = countRuns(d, { projectId: 'P' })
const subkindsBefore = JSON.stringify(metricsOverview(d, { projectId: 'P' }).runsBySubkind)
for (const subkind of ['engine', 'context', 'check', 'tier'] as const) {
  const sid = createRun(d, schema, { kind: 'review', subkind, provider: 'claude', projectId: 'P', reviewId: 'R1', model: 'opus' })
  recordRunUsage(d, schema, sid, { models: [{ model: 'opus', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 3, costSource: 'reported' }], costUsd: 3, costSource: 'reported', durationMs: 1, numTurns: 1 })
  finishRun(d, schema, sid, { status: 'error', error: 'handled' })
}
assert.equal(countRuns(d, { projectId: 'P' }), runsBefore, 'the run list counts reviews, not their stages')
assert.ok(recentRuns(d, { projectId: 'P' }, { limit: 100 }).every((r: any) => !['engine', 'context', 'check', 'tier'].includes(r.subkind)))
assert.equal(JSON.stringify(metricsOverview(d, { projectId: 'P' }).runsBySubkind), subkindsBefore, 'stage costs are not added a second time')
// Precision is about what the AI presented as holding: refuted and hand-added findings stay out of it.
const precBefore = precisionBySkillVersion(d, { projectId: 'P' }).find((r: any) => r.skill_version_id === 'SV1') as any
d.insert(schema.findings).values({ id: 'R1-miss', reviewId: 'R1', fid: 'F90', severity: 'Medium', title: 'miss', introducedByPr: true, checked: true, checkedBy: 'human', humanAcceptedAt: now(), source: 'human', sortOrder: 90, createdAt: now() }).run()
d.insert(schema.findings).values({ id: 'R1-ref', reviewId: 'R1', fid: 'F91', severity: 'Low', title: 'refuted', introducedByPr: true, checked: false, verifyStatus: 'refuted', sortOrder: 91, createdAt: now() }).run()
const precAfter = precisionBySkillVersion(d, { projectId: 'P' }).find((r: any) => r.skill_version_id === 'SV1') as any
assert.equal(Number(precAfter.findings), Number(precBefore.findings))
assert.equal(Number(precAfter.human_accepted), Number(precBefore.human_accepted))
console.log('metrics-queries: all ok')
