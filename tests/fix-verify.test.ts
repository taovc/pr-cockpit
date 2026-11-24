import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb, schema } from '../core/db/client'
import { lastVerifyResult, runVerifyCommand, verifyTail } from '../core/fix/verify'
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

console.log('fix-verify: ok')
