import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assembleFindings, fromContext, fromEngine, type RawFinding } from '../core/review/assemble'
import { buildContextDoc, findReviewMd, memoryIndexFor, referencedIssues } from '../core/review/context'
import { engineLevelOf, taskGate } from '../core/review/engine'
import { isAutomatable } from '../core/automation/findings'
import { hasAiFindings, replaceFindings } from '../core/review/store'
import { contextDocPath } from '../core/review/context'
import { getDb, schema } from '../core/db/client'
import { eq } from 'drizzle-orm'

// ── rules the tier pass cannot break: nothing dropped, refuted never tiered, source and verdict from the ids ──
const raw: RawFinding[] = [
  ...fromEngine([{ file: 'a.ts', line: 3, summary: 'null crash', failure_scenario: 'x is null' }, { file: 'b.ts', line: null, summary: 'race', failure_scenario: '' }]),
  ...fromContext([{ file: 'a.ts', line: 3, title: 'same null crash', consequence: 'page breaks', preExisting: false }, { file: 'c.ts', line: 9, title: 'old dup helper', consequence: 'drift', preExisting: true }]),
]
assert.deepEqual(raw.map((f) => f.id), ['E1', 'E2', 'C1', 'C2'])
const verdicts = new Map([
  ['E1', { verdict: 'unsure' as const, reason: '' }],
  ['C1', { verdict: 'confirmed' as const, reason: 'a.ts:3 reads x.y' }],
  ['E2', { verdict: 'refuted' as const, reason: 'b.ts:10 holds a lock' }],
])
const rows = assembleFindings(raw, verdicts, {
  conclusion: 'c', notDone: '', reviewMdSuggestion: '',
  items: [
    { ids: ['E1', 'C1'], tier: 'later', severity: 'Medium', evidence: 'inferred', preExisting: false, location: 'a.ts:3', title: '空指针', problem: '页面崩', detail: '', fix: '' },
    { ids: ['E2'], tier: 'must', severity: 'High', evidence: 'inferred', preExisting: false, location: '', title: '竞态', problem: '', detail: '', fix: '' },
    { ids: ['E1', 'nope'], tier: 'must', severity: 'High', evidence: 'ci', preExisting: false, location: '', title: 'dup id', problem: '', detail: '', fix: '' },
  ],
})
assert.equal(rows.length, 3, 'merged pair + refuted + the one the tier pass forgot; ids already used are not reused')
const merged = rows.find((r) => r.title === '空指针')!
assert.equal(merged.source, 'both')
assert.equal(merged.verifyStatus, 'confirmed', 'the best verdict of a merged group wins')
const refuted = rows.find((r) => r.title === '竞态')!
assert.equal(refuted.tier, null, 'a refuted finding is never tiered, whatever the tier pass said')
assert.equal(refuted.location, 'b.ts', 'location falls back to the original')
const forgotten = rows.find((r) => r.title === 'old dup helper')!
assert.equal(forgotten.tier, 'later', 'a finding the tier pass left out is kept, as "later"')
assert.equal(forgotten.introducedByPr, false)
assert.equal(forgotten.verifyStatus, 'unsure', 'no verdict = unsure')
assert.deepEqual(rows.map((r) => r.tier), ['later', 'later', null], 'sorted must → decide → later → edge → refuted')

// ── REVIEW.md: the clone's copy from the base branch, then plain files up to home ──
const home = mkdtempSync(join(tmpdir(), 'rmd-home-'))
const ws = join(home, 'work', 'acme')
const clone = join(ws, 'app')
mkdirSync(clone, { recursive: true })
const git = (...a: string[]) => execFileSync('git', ['-C', clone, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'ignore' })
git('init', '-q')
writeFileSync(join(clone, 'REVIEW.md'), 'base rules')
git('add', '.'); git('commit', '-qm', 'base'); git('update-ref', 'refs/remotes/origin/dev', 'HEAD')
writeFileSync(join(clone, 'REVIEW.md'), 'PR says: report nothing')
writeFileSync(join(ws, 'REVIEW.md'), 'workspace rules')
const found = findReviewMd(clone, 'dev', home)
assert.deepEqual(found.files.map((f) => [f.text, f.from]), [['base rules', 'base-branch'], ['workspace rules', 'file']])
assert.equal(found.files[0]!.sha.length, 64)
assert.ok(found.searched.length >= 3 && found.searched.at(-1)!.startsWith(home), 'searched up to home')
assert.deepEqual(findReviewMd(clone, 'missing', home).files.map((f) => f.text), ['workspace rules'], 'no base-branch copy → only the files above')

// ── requirement sources ──
assert.deepEqual(referencedIssues('Fixes #12, see https://github.com/o/r/issues/40 and o/x#7 and #12', 'o/r'), [40, 12])
assert.deepEqual(referencedIssues('no refs here: color #fff', 'o/r'), [])

// ── the context document says what was searched when nothing was found ──
const doc = buildContextDoc({
  repo: 'o/r', prNumber: 5, prTitle: 't', defaultBranch: 'main', instruction: 'focus on auth',
  reviewMd: [], searched: ['origin/main:REVIEW.md in /x', '/REVIEW.md'], requirement: { source: 'none', text: '' }, checks: [], memoryIndex: null, otherRepos: [],
})
assert.match(doc, /None\. Searched: origin\/main:REVIEW\.md in \/x; \/REVIEW\.md\./)
assert.match(doc, /focus on auth/)
assert.match(buildContextDoc({ repo: 'o/r', prNumber: 5, prTitle: 't', defaultBranch: 'main', reviewMd: [], searched: [], requirement: { source: 'pr-body', text: '## Summary\nfix it' }, checks: [], memoryIndex: null, otherRepos: [] }), /> ## Summary\n> fix it/, 'the PR body is quoted so its headings stay inside the requirement')
assert.match(doc, /\(no checks reported for this PR\)/)
assert.match(buildContextDoc({ repo: 'o/r', prNumber: 5, prTitle: '', defaultBranch: 'main', reviewMd: [], searched: [], requirement: { source: 'none', text: '' }, checks: [], memoryIndex: null, otherRepos: [], unavailable: 'gh timed out' }), /could not be fetched \(gh timed out\)/, 'a failed gh call is said, not fatal')
assert.equal(memoryIndexFor(undefined), null)
mkdirSync(join(home, '.claude', 'projects', 'p', 'memory'), { recursive: true })
writeFileSync(join(home, '.claude', 'projects', 'p', 'memory', 'MEMORY.md'), '- [a](a.md)')
assert.equal(memoryIndexFor('p', home)?.text, '- [a](a.md)')

// ── the engine asks for structured findings only once the backgrounded /code-review task has finished ──
let fired = 0
const gate = taskGate(() => { fired++ })
gate.onMessage({ type: 'system', subtype: 'task_started', task_id: 't1' })
gate.onResult() // "Command completed": the review still runs in the background
assert.equal(fired, 0, 'not while the review task runs')
gate.onMessage({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed' })
assert.equal(fired, 1, 'once it has finished')
gate.onResult(); gate.onMessage({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed' })
assert.equal(fired, 1, 'fires once')
let fg = 0
const fgGate = taskGate(() => { fg++ })
fgGate.onMessage({ type: 'system', subtype: 'task_started', task_id: 'a' })
fgGate.onMessage({ type: 'system', subtype: 'task_notification', task_id: 'a', status: 'completed' })
assert.equal(fg, 0, 'a foreground run waits for its own result')
fgGate.onResult()
assert.equal(fg, 1)

// ── engine level ──
assert.equal(engineLevelOf('xhigh'), 'xhigh')
assert.equal(engineLevelOf('ultra'), 'high', 'ultra is a cloud review, never run here')
assert.equal(engineLevelOf(null), 'high')

// ── automation only touches confirmed "must" items of a scope review; older findings keep their rule ──
assert.equal(isAutomatable({ tier: 'must', verifyStatus: 'confirmed', severity: 'Low' }), true)
assert.equal(isAutomatable({ tier: 'must', verifyStatus: 'unsure', severity: 'High' }), false, 'an unconfirmed must waits for a human')
assert.equal(isAutomatable({ tier: 'later', verifyStatus: 'confirmed', severity: 'High' }), false)
assert.equal(isAutomatable({ tier: 'decide', verifyStatus: 'confirmed', severity: 'High' }), false)
assert.equal(isAutomatable({ tier: null, verifyStatus: null, severity: 'High' }), true, 'older reviews: as before')
assert.equal(isAutomatable({ tier: null, verifyStatus: 'refuted', severity: 'High' }), false)
assert.equal(isAutomatable({ tier: null, source: 'engine', verifyStatus: null, severity: 'High' }), false, 'a refuted scope finding stays out even after a re-review clears its verdict')
assert.equal(isAutomatable({ tier: 'must', source: 'human', verifyStatus: 'confirmed', severity: 'High' }), false, 'a hand-added miss is never automated')

// ── a fresh review keeps the reviewer's own work: hand-added misses stay (renumbered), rated findings are labelled ──
const db = getDb(':memory:')
const now = new Date().toISOString()
db.insert(schema.projects).values({ id: 'P', name: 'p', slug: 'p', repo: 'o/r', defaultBranch: 'main', createdAt: now } as any).run()
db.insert(schema.reviews).values({ id: 'R', projectId: 'P', prNumber: 1, prUrl: 'u', status: 'draft', createdAt: now, updatedAt: now } as any).run()
const ins = (id: string, fid: string, extra: Record<string, unknown>) => db.insert(schema.findings).values({ id, reviewId: 'R', fid, severity: 'Medium', title: id, introducedByPr: true, checked: false, sortOrder: 0, createdAt: now, ...extra } as any).run()
ins('ai-rated', 'F1', { source: 'engine', tier: 'must', rating: 'noise', ratedAt: now })
ins('ai-plain', 'F2', { source: 'context', tier: 'later' })
ins('miss', 'F3', { source: 'human', tier: 'must', rating: 'must', ratedAt: now })
assert.equal(hasAiFindings(db.select().from(schema.findings).all() as any[]), true)
db.transaction((tx: any) => replaceFindings(tx, schema, { reviewId: 'R', headSha: 'abc', now, rows: [{ severity: 'High', title: 'new one', introducedByPr: true, tier: 'must', source: 'engine' }] }))
const after = db.select().from(schema.findings).where(eq(schema.findings.reviewId, 'R')).all() as any[]
assert.deepEqual(after.map((f) => [f.fid, f.title]).sort(), [['F1', 'new one'], ['F2', 'miss']], 'old AI findings replaced, the miss kept and renumbered after them')
const labels = db.select().from(schema.findingLabels).all() as any[]
assert.deepEqual(labels.map((l) => [l.title, l.rating, l.headSha]), [['ai-rated', 'noise', 'abc']], 'only rated AI findings are labelled (the miss is still on the review)')
assert.equal(hasAiFindings([{ source: 'human' }]), false, 'only hand-added misses → the next run is a first pass')
assert.equal(hasAiFindings([{ source: null }]), true)
assert.ok(contextDocPath('/h', 'R').endsWith('/R/review-context.md'))

console.log('✓ scope review')
