import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixedUncheck, fixingCommit, headMoved, pathOfLocation } from '../core/review/postGate'
import { teamLabel, withTeamLabel } from '../core/github/post'
import { getDb, schema } from '../core/db/client'
import { getPrAutomationRow, upsertPrAutomation } from '../core/automation/state'

// ── posting checks the head the review saw ──
assert.equal(headMoved('a1', 'b2'), true)
assert.equal(headMoved('a1', 'a1'), false)
assert.equal(headMoved(null, 'b2'), false, 'an unknown reviewed head is not a move')
assert.equal(headMoved('a1', null), false)

// ── a re-review that finds a finding fixed ──
assert.deepEqual(fixedUncheck({ checked: true, postedPostId: null }, 'fixed'), { checked: false, checkedBy: null, checkedAt: null }, 'not posted yet: it no longer goes out')
assert.equal(fixedUncheck({ checked: true, postedPostId: 'p1' }, 'fixed'), null, 'posted before: stays ticked for the "Confirmed fixed" line')
assert.equal(fixedUncheck({ checked: true, postedPostId: null }, 'partial'), null)
assert.equal(fixedUncheck({ checked: false, postedPostId: null }, 'fixed'), null)
assert.equal(pathOfLocation('core/a.ts:12'), 'core/a.ts')
assert.equal(pathOfLocation('core/a.ts:12-20'), 'core/a.ts')
assert.equal(pathOfLocation('README.md'), 'README.md')
assert.equal(pathOfLocation(null), null)

// The fixing commit: the newest commit of the round that touched the file.
{
  const repo = mkdtempSync(join(tmpdir(), 'fixc-'))
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't')
  const commit = (file: string, text: string) => { writeFileSync(join(repo, file), text); git('add', file); git('commit', '-q', '-m', file); return git('rev-parse', 'HEAD') }
  const c1 = commit('a.ts', '1')
  const c2 = commit('b.ts', '1')
  const c3 = commit('a.ts', '2')
  assert.equal(await fixingCommit(repo, c1, c3, 'a.ts'), c3)
  assert.equal(await fixingCommit(repo, c1, c3, 'b.ts'), c2)
  assert.equal(await fixingCommit(repo, c1, c3, 'c.ts'), null, 'the file was not touched in the round')
  assert.equal(await fixingCommit(repo, c3, c3, 'a.ts'), null)
  assert.equal(await fixingCommit(repo, null, c3, 'a.ts'), null)
  assert.equal(await fixingCommit(repo, 'f'.repeat(40), c3, 'a.ts'), null, 'a force-pushed (unknown) old head gives no answer')
}

// ── the team comment header: **[Severity(, pre-existing)] title** ──
assert.equal(teamLabel({ severity: 'Medium', introducedByPr: false }), 'Medium, pre-existing')
assert.equal(teamLabel({ severity: 'High', introducedByPr: true }), 'High')
assert.equal(withTeamLabel('**[Medium] Unbounded read**\n\nText.\n\nSuggestion: cap it.', 'Medium, pre-existing'), '**[Medium, pre-existing] Unbounded read**\n\nText.\n\nSuggestion: cap it.', 'the bracket is ours, the title is the model\'s')
assert.equal(withTeamLabel('Unbounded read without a header', 'High'), 'Unbounded read without a header', 'no header to fix: the text stays')

// ── automation keeps "posting held" on its own column (a later note must not release it) ──
{
  const db = getDb(':memory:')
  const now = new Date().toISOString()
  db.insert(schema.projects).values({ id: 'P', name: 'p', slug: 'p', repo: 'o/r', defaultBranch: 'main', createdAt: now } as any).run()
  upsertPrAutomation(db, schema, 'P', 7, { postHeld: true, note: 'post_held' }, now)
  upsertPrAutomation(db, schema, 'P', 7, { note: 'converged' }, now)
  const row = getPrAutomationRow(db, schema, 'P', 7)!
  assert.equal(row.postHeld, true)
  assert.equal(row.note, 'converged')
}

console.log('post-head-check: ok')
