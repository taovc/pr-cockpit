import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { getDb, schema } from '../core/db/client'
import { checkBeforeUpload, lastVerifyResult, runVerifyCommand, verifyEnv, verifyFailureOf, verifyTail } from '../core/fix/verify'
import { inboxOverview } from '../core/inbox/queries'

// The pre-upload check: a real /bin/sh in a temp directory, recorded as its own runs row.
const d = getDb(':memory:')
const wt = mkdtempSync(join(tmpdir(), 'verify-wt-'))
const base = { cwd: wt, provider: 'claude' as const, projectId: 'P', prNumber: 3, branch: 'feat/x' }

// ── the tail: short output whole; long output = error lines cut off above the tail first, then the last lines ──
assert.equal(verifyTail('a\nb\n\n'), 'a\nb')
{
  const lines = Array.from({ length: 200 }, (_, i) => (i === 10 ? 'Error: boom at line 10' : `line ${i}`))
  const tail = verifyTail(lines.join('\n')).split('\n')
  assert.equal(tail[0], 'Error: boom at line 10', 'an error far above the tail comes first')
  assert.equal(tail[1], '…')
  assert.equal(tail.at(-1), 'line 199')
  assert.ok(tail.length <= 61)
}
assert.equal(verifyTail(Array.from({ length: 100 }, (_, i) => `ok ${i}`).join('\n')).split('\n').length, 60, 'no error lines: the last 60')

// ── success ──
const ok = await runVerifyCommand(d, schema, { ...base, command: 'echo checks fine' })
assert.equal(ok.ok, true)
assert.equal(ok.exitCode, 0)
const okRow = d.select().from(schema.runs).all().find((r: any) => r.id === ok.runId) as any
assert.equal(okRow.kind, 'check')
assert.equal(okRow.subkind, 'upload_check')
assert.equal(okRow.status, 'done')
assert.equal(okRow.workspacePath, wt)
assert.equal(lastVerifyResult(d, schema, wt)?.ok, true)

// ── failure: exit code, stderr in the tail, an error row the Inbox lists ──
await new Promise((r) => setTimeout(r, 5))
const bad = await runVerifyCommand(d, schema, { ...base, command: 'pwd; echo "Error: expected 1" >&2; exit 3' })
assert.equal(bad.ok, false)
assert.equal(bad.exitCode, 3)
assert.equal(bad.timedOut, false)
assert.match(bad.tail, /Error: expected 1/)
assert.ok(bad.tail.includes(wt.split('/').pop()!), 'runs in the worktree')
const last = lastVerifyResult(d, schema, wt)!
assert.equal(last.ok, false)
assert.match(last.error!, /exit 3/)
assert.match(last.tail, /Error: expected 1/)
assert.equal(lastVerifyResult(d, schema, '/elsewhere'), null, 'per worktree')
const inbox = inboxOverview(d, { sinceIso: new Date(Date.now() - 60_000).toISOString() })
assert.ok(inbox.errors.some((e) => e.runId === bad.runId && e.subkind === 'upload_check' && e.prNumber === 3), 'a failed check shows in the Inbox')

// ── timeout ──
const slow = await runVerifyCommand(d, schema, { ...base, command: 'sleep 5', timeoutMs: 200 })
assert.equal(slow.ok, false)
assert.equal(slow.timedOut, true)
assert.match(String((d.select().from(schema.runs).all().find((r: any) => r.id === slow.runId) as any).error), /超时/)

// ── per session: a later session reusing the worktree does not see an earlier session's result ──
assert.equal(lastVerifyResult(d, schema, wt, new Date(Date.now() + 60_000).toISOString()), null)
assert.equal(lastVerifyResult(d, schema, wt, new Date(Date.now() - 60_000).toISOString())?.ok, false)

// ── a timeout kills the whole process group, not only /bin/sh ──
{
  const pidFile = join(wt, 'grandchild.pid')
  const r = await runVerifyCommand(d, schema, { ...base, command: `sh -c 'echo $$ > "${pidFile}"; exec sleep 30' & wait`, timeoutMs: 300 })
  assert.equal(r.timedOut, true)
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  let alive = true
  for (let i = 0; i < 40 && alive; i++) {
    try { process.kill(pid, 0); await new Promise((res) => setTimeout(res, 50)) } catch { alive = false }
  }
  assert.equal(alive, false, 'the grandchild (a test runner) is killed with the shell')
}

// ── the env: no credentials or cockpit runtime config, CI set ──
{
  const env = verifyEnv({ PATH: '/bin', HOME: '/h', GH_TOKEN: 'x', ANTHROPIC_API_KEY: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'x', OPENAI_API_KEY: 'x', NUXT_DB_PATH: 'x', AWS_SECRET_ACCESS_KEY: 'x', NPM_TOKEN: 'x', SSH_AUTH_SOCK: 'x', LANG: 'C' })
  assert.deepEqual(Object.keys(env).sort(), ['CI', 'HOME', 'LANG', 'PATH'])
  assert.equal(env.CI, '1')
  process.env.COCKPIT_TEST_SECRET = 'leak'
  const r = await runVerifyCommand(d, schema, { ...base, command: 'echo "s=${COCKPIT_TEST_SECRET:-none} ci=$CI"' })
  delete process.env.COCKPIT_TEST_SECRET
  assert.match(r.tail, /s=none ci=\S+/)
}

// ── the push endpoint's gate on a real git worktree: a failing check commits and pushes nothing and releases the claim ──
const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
const remote = mkdtempSync(join(tmpdir(), 'verify-remote-'))
sh(remote, 'init', '-q', '--bare')
const repo = mkdtempSync(join(tmpdir(), 'verify-repo-'))
sh(repo, 'init', '-q', '-b', 'feat/x')
sh(repo, 'config', 'user.email', 't@t')
sh(repo, 'config', 'user.name', 't')
writeFileSync(join(repo, 'a.txt'), 'one\n')
writeFileSync(join(repo, '.gitignore'), 'out/\n')
sh(repo, 'add', '-A')
sh(repo, 'commit', '-q', '-m', 'init')
sh(repo, 'remote', 'add', 'origin', remote)
sh(repo, 'push', '-q', 'origin', 'HEAD:feat/x')
writeFileSync(join(repo, 'a.txt'), 'two\n') // the agent's uncommitted fix
const head0 = sh(repo, 'rev-parse', 'HEAD')
d.insert(schema.runs).values({ id: 'S1', kind: 'session', subkind: 'session', provider: 'claude', projectId: 'P', workspaceType: 'pr_worktree', workspacePath: repo, prNumber: 3, branch: 'feat/x', status: 'idle', uploadState: 'ready', busyAction: 'pushing', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as any).run()
const gate = { runId: 'S1', cwd: repo, provider: 'claude' as const, projectId: 'P', prNumber: 3, branch: 'feat/x' }
{
  const fail = await checkBeforeUpload(d, schema, { ...gate, command: 'echo "FAIL a.test" >&2; exit 1' })
  assert.ok(fail)
  assert.equal(fail!.statusCode, 422)
  assert.match(fail!.statusMessage, /exit 1/)
  assert.deepEqual({ ...fail!.data, tail: undefined }, { verifyFailed: true, exitCode: 1, timedOut: false, changedFiles: [], tail: undefined })
  assert.match(fail!.data.tail, /FAIL a\.test/)
  const s1 = d.select().from(schema.runs).all().find((r: any) => r.id === 'S1') as any
  assert.equal(s1.busyAction, null, 'the upload claim is released')
  assert.equal(s1.uploadState, 'ready', 'still uploadable by hand')
  assert.equal(sh(repo, 'rev-parse', 'HEAD'), head0, 'nothing committed')
  assert.equal(sh(remote, 'rev-parse', 'feat/x'), head0, 'nothing pushed')
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'two\n', 'the fix stays in the worktree')
  // what the automation plugin reads from the ofetch error ($fetch puts the JSON error body on e.data)
  const fetchError = Object.assign(new Error('[POST] "/api/runs/S1/push": 422'), { statusCode: 422, data: { error: true, url: '/api/runs/S1/push', statusCode: 422, statusMessage: fail!.statusMessage, message: fail!.statusMessage, data: fail!.data } })
  assert.deepEqual(verifyFailureOf(fetchError), { verifyFailed: true, tail: fail!.data.tail })
  assert.equal(verifyFailureOf(Object.assign(new Error('500'), { statusCode: 500, data: { statusCode: 500, statusMessage: '上传失败' } })), null)
  assert.equal(verifyFailureOf(new Error('network')), null)
}
{
  d.update(schema.runs).set({ busyAction: 'pushing' }).where(eq(schema.runs.id, 'S1')).run()
  assert.equal(await checkBeforeUpload(d, schema, { ...gate, command: 'mkdir -p out && echo x > out/cache && grep -q two a.txt' }), null, 'passing check; ignored output does not count')
  assert.equal(sh(repo, 'status', '--porcelain'), 'M a.txt', 'the real index is untouched')
  // a check that rewrites or creates files (lint --fix, a new snapshot) would push unseen changes
  const fail = await checkBeforeUpload(d, schema, { ...gate, command: 'echo fixed > a.txt; echo snap > new.snap' })
  assert.ok(fail)
  assert.deepEqual(fail!.data.changedFiles, ['a.txt', 'new.snap'])
  assert.match(fail!.statusMessage, /2 个文件/)
  assert.match(fail!.data.tail, /new\.snap/)
  assert.equal(sh(remote, 'rev-parse', 'feat/x'), head0)
  assert.ok(existsSync(join(repo, 'new.snap')), 'the changed files are left for the human to look at')
}

console.log('fix-verify: ok')
