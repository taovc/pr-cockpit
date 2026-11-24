import { execFile } from 'node:child_process'
import { and, desc, eq } from 'drizzle-orm'
import { createRun, finishRun } from '../runs/store'

// The project's own check (projects.verify_command, set by the human), run in the PR worktree before an upload.
// Each run is its own runs row (kind 'check', subkind 'upload_check'), so a failure lands in the Inbox.

export const VERIFY_TIMEOUT_MS = 10 * 60_000
const TAIL_LINES = 60
const ERROR_LINE = /\b(error|errors|fail|failed|failure|failing|panic|exception|traceback|assert(ion)?)\b|✗|✖|×/i

export type VerifyResult = { ok: boolean; exitCode: number | null; timedOut: boolean; tail: string; command: string; at: string; runId: string }
export type LastVerify = { ok: boolean; running: boolean; command: string; tail: string; error: string | null; at: string | null }

// About the last 60 lines, with the error-looking lines from anywhere in the output first.
export function verifyTail(output: string, max = TAIL_LINES): string {
  const lines = output.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, ''))
  while (lines.length && !lines[lines.length - 1]) lines.pop()
  if (lines.length <= max) return lines.join('\n')
  const errIdx = lines.map((l, i) => (ERROR_LINE.test(l) ? i : -1)).filter((i) => i >= 0)
  const errors = errIdx.slice(-Math.floor(max / 3))
  const rest = max - errors.length
  const tailStart = lines.length - rest
  const head = errors.filter((i) => i < tailStart).map((i) => lines[i]!)
  const tail = lines.slice(tailStart)
  return head.length ? [...head, '…', ...tail].join('\n') : tail.join('\n')
}

type ShOut = { code: number | null; timedOut: boolean; output: string }

function runSh(command: string, cwd: string, timeoutMs: number): Promise<ShOut> {
  const t0 = Date.now()
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', command], { cwd, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (err: any, stdout, stderr) => {
      const output = [stdout, stderr].filter((s) => s && s.trim()).join('\n')
      if (!err) return resolve({ code: 0, timedOut: false, output })
      const timedOut = !!err.killed && Date.now() - t0 >= timeoutMs
      resolve({ code: typeof err.code === 'number' ? err.code : null, timedOut, output: output || String(err.message || '') })
    })
  })
}

export async function runVerifyCommand(db: any, schema: any, o: {
  command: string
  cwd: string
  provider: 'claude' | 'codex'
  projectId: string | null
  prNumber: number | null
  branch: string | null
  timeoutMs?: number
}): Promise<VerifyResult> {
  const runId = createRun(db, schema, {
    kind: 'check', subkind: 'upload_check', provider: o.provider, projectId: o.projectId,
    workspaceType: 'pr_worktree', workspacePath: o.cwd, prNumber: o.prNumber, branch: o.branch, title: o.command.slice(0, 200),
  })
  const t0 = Date.now()
  const timeoutMs = o.timeoutMs ?? VERIFY_TIMEOUT_MS
  const r = await runSh(o.command, o.cwd, timeoutMs)
  const ok = r.code === 0 && !r.timedOut
  const tail = verifyTail(r.output)
  const summary = r.timedOut ? `上传前检查超时（${Math.round(timeoutMs / 60_000)} 分钟）` : `上传前检查失败（exit ${r.code ?? '?'}）`
  try { db.update(schema.runs).set({ description: tail, durationMs: Date.now() - t0 }).where(eq(schema.runs.id, runId)).run() } catch { /* recording must not fail the check */ }
  finishRun(db, schema, runId, ok ? { status: 'done' } : { status: 'error', error: `${summary}\n${tail}`.slice(0, 4000) })
  return { ok, exitCode: r.code, timedOut: r.timedOut, tail, command: o.command, at: new Date().toISOString(), runId }
}

// The latest upload check run in this worktree, for the upload preview.
export function lastVerifyResult(db: any, schema: any, workspacePath: string): LastVerify | null {
  const row = db.select().from(schema.runs)
    .where(and(eq(schema.runs.kind, 'check'), eq(schema.runs.subkind, 'upload_check'), eq(schema.runs.workspacePath, workspacePath)))
    .orderBy(desc(schema.runs.createdAt)).limit(1).get() as any
  if (!row) return null
  return {
    ok: row.status === 'done', running: row.status === 'running', command: row.title ?? '', tail: row.description ?? '',
    error: row.status === 'error' ? String(row.error ?? '').split('\n')[0]! : null, at: row.endedAt ?? row.createdAt,
  }
}
