import assert from 'node:assert/strict'
import { CodexReviewError, parseCodexRecheckJson, RECHECK_RESULT_JSON_SCHEMA, REVIEW_RESULT_JSON_SCHEMA } from '../core/agent/codexReview'
import { RecheckSchema } from '../core/agent/recheck'
import { ReviewResultSchema } from '../core/agent/review'
import { jsonSchemaFor } from '../core/agent/structured'

// ── recheck: all fields required, structure matches RecheckSchema ──
const recheck = parseCodexRecheckJson(JSON.stringify({
  rechecks: [
    { fid: 'F1', status: 'fixed', stance: 'kept', stanceReason: '', text: '已在 abc123 修复' },
    // the two axes are independent: the author fixed it AND we no longer think it was worth raising
    { fid: 'F2', status: 'fixed', stance: 'retracted', stanceReason: '按 reviewer 的范围要求，这条属于扩大 review', text: '' },
  ],
  newFindings: [{ severity: 'Medium', title: 'regression', location: 'core/c.ts:3', problem: 'p', detail: 'd', fix: 'f', text: '在 def456 引入' }],
  conclusion: '还剩 1 个 blocking',
}))
assert.equal(recheck.rechecks[0]?.status, 'fixed')
assert.equal(recheck.rechecks[0]?.stance, 'kept')
assert.equal(recheck.rechecks[1]?.stance, 'retracted', 'stance is judged separately from what the author did')
assert.ok(recheck.rechecks[1]?.stanceReason, 'a changed stance carries its reason')
assert.equal(recheck.newFindings[0]?.severity, 'Medium')

// Bad JSON → CodexReviewError
assert.throws(
  () => parseCodexRecheckJson('not-json'),
  (error) => error instanceof CodexReviewError && /invalid JSON/i.test(error.message),
)

// ── stance 'adjusted' carries the corrected wording (the schema used to forbid those keys outright) ──
const adjusted = parseCodexRecheckJson(JSON.stringify({
  rechecks: [
    {
      fid: 'F3', status: 'replied', stance: 'adjusted', stanceReason: '作者指出 location 指错了文件',
      severity: 'Low', title: '重复的空值检查', location: 'core/b.ts:12', problem: 'p2', detail: 'd2', fix: 'f2',
      text: '按作者的回复重写了这条',
    },
    // every other item sends the same keys as null; they must not reach the result
    { fid: 'F4', status: 'fixed', stance: 'kept', stanceReason: '', severity: null, title: null, location: null, problem: null, detail: null, fix: null, text: '已修' },
  ],
  newFindings: [],
  conclusion: '可以合了',
}))
assert.equal(adjusted.rechecks[0]?.severity, 'Low', 'an adjusted finding keeps its corrected severity')
assert.equal(adjusted.rechecks[0]?.title, '重复的空值检查')
assert.equal(adjusted.rechecks[0]?.location, 'core/b.ts:12')
assert.equal(adjusted.rechecks[1]?.severity, undefined, 'nulls are dropped, not passed through as null')
assert.equal(adjusted.rechecks[1]?.title, undefined)

// ── drift guard: the hand-written Codex schemas must mirror the zod schemas the results are validated against ──
function propsOf(node: any): string[] {
  return Object.keys(node?.properties ?? {}).sort()
}
function assertStrict(node: any, where: string) {
  assert.equal(node?.additionalProperties, false, `${where}: strict structured output needs additionalProperties: false`)
  assert.deepEqual([...(node?.required ?? [])].sort(), propsOf(node), `${where}: every property must be listed in required`)
}
function assertMirrors(codex: any, zod: any, where: string) {
  assert.deepEqual(propsOf(codex), propsOf(zod), `${where}: Codex schema drifted from the zod schema`)
  assertStrict(codex, where)
}

const zodRecheck: any = jsonSchemaFor(RecheckSchema)
assertMirrors(RECHECK_RESULT_JSON_SCHEMA, zodRecheck, 'recheck')
assertMirrors((RECHECK_RESULT_JSON_SCHEMA as any).properties.rechecks.items, zodRecheck.properties.rechecks.items, 'recheck.rechecks[]')
assertMirrors((RECHECK_RESULT_JSON_SCHEMA as any).properties.newFindings.items, zodRecheck.properties.newFindings.items, 'recheck.newFindings[]')

const zodReview: any = jsonSchemaFor(ReviewResultSchema)
assertMirrors(REVIEW_RESULT_JSON_SCHEMA, zodReview, 'review')
assertMirrors((REVIEW_RESULT_JSON_SCHEMA as any).properties.findings.items, zodReview.properties.findings.items, 'review.findings[]')

console.log('✓ codex recheck json')
