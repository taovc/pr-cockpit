import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFile, mkdtemp, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { and, desc, eq, gte } from 'drizzle-orm'
import { createRun, finishRun } from '../runs/store'

// The project's own check (projects.verify_command, set by the human), run in the PR worktree before an upload.
// Each run is its own runs row (kind 'check', subkind 'upload_check'), so a failure lands in the Inbox.

export const VERIFY_TIMEOUT_MS = 10 * 60_000
const TAIL_LINES = 60
const ERROR_LINE = /\b(error|errors|fail|failed|failure|failing|panic|exception|traceback|assert(ion)?)\b|✗|✖|×/i
const pexec = promisify(execFile)

export type VerifyResult = { ok: boolean; exitCode: number | null; timedOut: boolean; changedFiles: string[]; tail: string; command: string; at: string; runId: string }
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

// The check runs the PR's own scripts: keep the server's credentials and its own runtime config out of their env.
const CREDENTIAL_ENV = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_KEY|AUTH/i
const CREDENTIAL_PREFIX = /^(ANTHROPIC_|CLAUDE|OPENAI_|CODEX_|GH_|GITHUB_|AWS_|AZURE_|GOOGLE_|GCP_|NUXT_)/i
export function verifyEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || CREDENTIAL_ENV.test(k) || CREDENTIAL_PREFIX.test(k)) continue
    out[k] = v
  }
  out.CI = env.CI || '1'
  return out
}

type ShOut = { code: number | null; timedOut: boolean; output: string }

function killGroup(pid: number | undefined) {
  if (!pid) return
  try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ }
}

// spawn, not execFile: execFile drops `detached`. Its own process group lets a timeout kill the test runners the shell
// started, not only the shell. Output keeps the last OUTPUT_CAP chars of each stream.
const OUTPUT_CAP = 4 * 1024 * 1024
function runSh(command: string, cwd: string, timeoutMs: number): Promise<ShOut> {
  return new Promise((done) => {
    let timedOut = false
    let stdout = ''
    let stderr = ''
    const child = spawn('/bin/sh', ['-c', command], { cwd, env: verifyEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.setEncoding('utf8').on('data', (s: string) => { stdout = (stdout + s).slice(-OUTPUT_CAP) })
    child.stderr.setEncoding('utf8').on('data', (s: string) => { stderr = (stderr + s).slice(-OUTPUT_CAP) })
    const timer = setTimeout(() => { timedOut = true; killGroup(child.pid) }, timeoutMs)
    const finish = (code: number | null, err?: Error) => {
      clearTimeout(timer)
      const output = [stdout, stderr].filter((s) => s && s.trim()).join('\n')
      done({ code, timedOut, output: output || (err ? String(err.message) : '') })
    }
    child.on('error', (err) => finish(null, err))
    child.on('close', (code) => finish(timedOut ? null : code))
  })
}

// A tree id for the whole worktree (tracked + untracked, .gitignore honoured), built in a throwaway index so the real
// index is untouched. null = not a git worktree / unreadable.
async function worktreeTree(cwd: string): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), 'cockpit-verify-'))
  try {
    const idx = join(dir, 'index')
    const real = resolve(cwd, (await pexec('git', ['-C', cwd, 'rev-parse', '--git-path', 'index'])).stdout.trim())
    // Keep the index mtime: git's racy-entry check compares file mtimes against it, so a fresh mtime would hide a
    // same-size edit made in the same second.
    await copyFile(real, idx).then(async () => { const st = await stat(real); await utimes(idx, st.atime, st.mtime) }).catch(() => {})
    const env = { ...process.env, GIT_INDEX_FILE: idx }
    await pexec('git', ['-C', cwd, 'add', '-A'], { env, maxBuffer: 64 * 1024 * 1024 })
    return (await pexec('git', ['-C', cwd, 'write-tree'], { env })).stdout.trim() || null
  } catch {
    return null
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

async function changedBetween(cwd: string, a: string | null, b: string | null): Promise<string[]> {
  if (!a || !b || a === b) return []
  const out = await pexec('git', ['-C', cwd, 'diff', '--name-only', a, b], { maxBuffer: 16 * 1024 * 1024 }).then((r) => r.stdout).catch(() => '')
  const files = out.split('\n').map((s) => s.trim()).filter(Boolean)
  return files.length ? files : ['(worktree)']
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
  const before = await worktreeTree(o.cwd)
  const r = await runSh(o.command, o.cwd, timeoutMs)
  // The upload commits the whole worktree, so a check that rewrote or created files (lint --fix, new snapshots) would
  // push changes nobody reviewed: block it instead.
  const changedFiles = r.timedOut ? [] : await changedBetween(o.cwd, before, await worktreeTree(o.cwd))
  const ok = r.code === 0 && !r.timedOut && !changedFiles.length
  const outTail = verifyTail(r.output)
  const tail = changedFiles.length
    ? [`检查改动了 worktree 里的 ${changedFiles.length} 个文件（未上传，请先看过这些改动）：`, ...changedFiles.slice(0, 30).map((f) => `  ${f}`), ...(changedFiles.length > 30 ? ['  …'] : []), '', outTail].join('\n').trim()
    : outTail
  const summary = r.timedOut ? `上传前检查超时（${Math.round(timeoutMs / 60_000)} 分钟）`
    : changedFiles.length && r.code === 0 ? `上传前检查改动了 ${changedFiles.length} 个文件`
    : `上传前检查失败（exit ${r.code ?? '?'}）`
  try { db.update(schema.runs).set({ description: tail, durationMs: Date.now() - t0 }).where(eq(schema.runs.id, runId)).run() } catch { /* recording must not fail the check */ }
  finishRun(db, schema, runId, ok ? { status: 'done' } : { status: 'error', error: `${summary}\n${tail}`.slice(0, 4000) })
  return { ok, exitCode: r.code, timedOut: r.timedOut, changedFiles, tail, command: o.command, at: new Date().toISOString(), runId }
}

export type UploadCheckFailure = {
  statusCode: 422
  statusMessage: string
  data: { verifyFailed: true; exitCode: number | null; timedOut: boolean; changedFiles: string[]; tail: string }
}

// The push endpoint's gate, after it claimed busy_action: null = go on; a failure releases the claim (nothing committed
// or pushed, upload_state untouched) and returns the 422 to throw.
export async function checkBeforeUpload(db: any, schema: any, o: {
  runId: string
  command: string
  cwd: string
  provider: 'claude' | 'codex'
  projectId: string | null
  prNumber: number | null
  branch: string | null
  timeoutMs?: number
}): Promise<UploadCheckFailure | null> {
  const { runId, ...rest } = o
  const v = await runVerifyCommand(db, schema, rest)
    .catch((e: any) => ({ ok: false, exitCode: null, timedOut: false, changedFiles: [] as string[], tail: String(e?.message || e) }))
  if (v.ok) return null
  db.update(schema.runs).set({ busyAction: null, updatedAt: new Date().toISOString() }).where(eq(schema.runs.id, runId)).run()
  const statusMessage = v.timedOut ? '上传前检查超时，未上传'
    : v.changedFiles.length && v.exitCode === 0 ? `上传前检查改动了 ${v.changedFiles.length} 个文件，未上传`
    : `上传前检查失败（exit ${v.exitCode ?? '?'}），未上传`
  return { statusCode: 422, statusMessage, data: { verifyFailed: true, exitCode: v.exitCode, timedOut: v.timedOut, changedFiles: v.changedFiles, tail: v.tail } }
}

// Reads the gate's 422 out of an ofetch error (e.data = the JSON error body: { statusCode, statusMessage, data }).
export function verifyFailureOf(e: any): { verifyFailed: true; tail: string } | null {
  const body = e?.data
  if (!body?.data?.verifyFailed) return null
  return { verifyFailed: true, tail: String(body.data.tail || body.statusMessage || '') }
}

// The latest upload check run in this worktree since the session started (a later session may reuse the worktree).
export function lastVerifyResult(db: any, schema: any, workspacePath: string, sinceIso?: string | null): LastVerify | null {
  const conds = [eq(schema.runs.kind, 'check'), eq(schema.runs.subkind, 'upload_check'), eq(schema.runs.workspacePath, workspacePath)]
  if (sinceIso) conds.push(gte(schema.runs.createdAt, sinceIso))
  const row = db.select().from(schema.runs).where(and(...conds)).orderBy(desc(schema.runs.createdAt)).limit(1).get() as any
  if (!row) return null
  return {
    ok: row.status === 'done', running: row.status === 'running', command: row.title ?? '', tail: row.description ?? '',
    error: row.status === 'error' ? String(row.error ?? '').split('\n')[0]! : null, at: row.endedAt ?? row.createdAt,
  }
}
