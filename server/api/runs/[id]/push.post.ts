import { eq, and, isNull } from 'drizzle-orm'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { schema } from '~core/db/client'
import { fetchReviewsCount } from '~core/github/gh'
import { isRunBusy } from '~core/runs/session'
import { fixChangesDiff, fixChangesStat, hasUploadable } from '~core/fix/changes'
import { genCommitMessage } from '~core/fix/commitmsg'
import { assertCodexAheadCommitSafe, assertCodexCommitSafe } from '~core/fix/codexCommitSafety'
import { getRunOr404 } from '../../../utils/runContext'

const pexec = promisify(execFile)
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/

// "Commit and upload" for a PR session: `git add -A && commit && push` the changes the agent left in the worktree to the
// PR branch. dryRun=true → the pending diff + a generated commit message + stats (nothing committed); dryRun=false → for
// real, with the (possibly edited) message from the preview. Always user-triggered (or the automation engine).
const Body = z.object({ dryRun: z.boolean().default(false), message: z.string().max(500).optional() })

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const { dryRun, message } = Body.parse((await readBody(event).catch(() => ({}))) || {})
  const d = db()
  const run = getRunOr404(id)
  if (run.workspaceType !== 'pr_worktree') throw createError({ statusCode: 400, statusMessage: '只有 PR 会话可以上传' })
  if (isRunBusy(id)) throw createError({ statusCode: 409, statusMessage: '对话正在进行，请等它完成或停止再上传' })
  if (!run.workspacePath || !existsSync(run.workspacePath)) throw createError({ statusCode: 400, statusMessage: 'worktree 不在了' })
  if (!run.branch || !SAFE_REF.test(run.branch)) throw createError({ statusCode: 400, statusMessage: `分支名不合法: ${run.branch}` })
  const project = run.projectId ? d.select().from(schema.projects).where(eq(schema.projects.id, run.projectId)).get() : null
  if (!project) throw createError({ statusCode: 404, statusMessage: '项目不存在' })

  const wt = run.workspacePath
  const branch = run.branch
  const git = (args: string[]) => pexec('git', ['-C', wt, ...args], { maxBuffer: 64 * 1024 * 1024 })
  const now = () => new Date().toISOString()

  // Merge in progress (the agent ran `git merge --no-commit` and resolved conflicts)? Keep git's own merge message.
  const mergeState = async (): Promise<{ merging: boolean; msg: string }> => {
    const merging = await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD']).then(() => true).catch(() => false)
    if (!merging) return { merging: false, msg: '' }
    let msg = ''
    try {
      const p = (await git(['rev-parse', '--git-path', 'MERGE_MSG'])).stdout.trim()
      msg = (await readFile(resolve(wt, p), 'utf8')).trim()
    } catch { /* unreadable → --no-edit below */ }
    return { merging: true, msg }
  }

  const { dirty, ahead } = await hasUploadable(wt, branch)
  if (!dirty && !ahead) throw createError({ statusCode: 400, statusMessage: '没有可上传的改动' })

  if (dryRun) {
    const [{ diff, truncated }, stat] = await Promise.all([
      fixChangesDiff(wt).catch(() => ({ diff: '', truncated: false })),
      fixChangesStat(wt).catch(() => ({ filesChanged: 0, additions: 0, deletions: 0 })),
    ])
    const { merging, msg: mergeMsg } = await mergeState()
    const genMsg = !dirty ? '' : merging ? (mergeMsg || `Merge into ${branch}`) : await genCommitMessage(helperTargetOf(resolveReviewConfig(d, project)), diff, wt)
    return { dryRun: true, diff, truncated, message: genMsg, needsCommit: dirty, isMerge: merging, ...stat }
  }

  // CAS-claim the worktree: busy_action = pushing.
  const claimed = d.update(schema.runs).set({ busyAction: 'pushing', error: null, updatedAt: now() })
    .where(and(eq(schema.runs.id, id), isNull(schema.runs.busyAction))).run()
  if (!claimed.changes) throw createError({ statusCode: 409, statusMessage: '该会话正在上传或状态已变，请刷新' })

  try {
    const { merging } = await mergeState()
    if (project.provider === 'codex') {
      if (dirty && !merging) {
        const { stdout: porcelain } = await git(['status', '--porcelain'])
        assertCodexCommitSafe(porcelain)
      }
      if (ahead) {
        const [{ stdout: head }, { stdout: nameStatus }] = await Promise.all([git(['rev-parse', 'HEAD']), git(['diff', '--name-status', `origin/${branch}..HEAD`])])
        assertCodexAheadCommitSafe({ currentHead: head.trim() || null, fixHeadSha: run.fixHeadSha ?? null, nameStatus })
      }
    }
    if (dirty) {
      await git(['add', '-A'])
      const userMsg = (message || '').trim()
      if (userMsg) await git(['commit', '-m', userMsg])
      else if (merging) await git(['commit', '--no-edit'])
      else {
        const { diff } = await fixChangesDiff(wt).catch(() => ({ diff: '' }))
        await git(['commit', '-m', await genCommitMessage(helperTargetOf(resolveReviewConfig(d, project)), diff, wt)])
      }
    }
    const headSha = (await git(['rev-parse', 'HEAD'])).stdout.trim()
    // Persist the head first: a crash between push and the write-back is reconciled by origin == fix_head_sha on restart.
    d.update(schema.runs).set({ fixHeadSha: headSha, updatedAt: now() }).where(eq(schema.runs.id, id)).run()
    await git(['push', 'origin', `HEAD:${branch}`])
    const reviewsAtPush = await fetchReviewsCount(project.repo, run.prNumber!).catch(() => null)
    d.update(schema.runs)
      .set({ busyAction: null, error: null, fixHeadSha: headSha, lastPushSha: headSha, uploadState: 'pushed', reviewsAtPush, pushedAt: now(), updatedAt: now() })
      .where(eq(schema.runs.id, id)).run()
    return { ok: true, sha: headSha.slice(0, 7), url: `https://github.com/${project.repo}/pull/${run.prNumber}` }
  } catch (e: any) {
    const m = String(e?.stderr || e?.message || '').slice(0, 400)
    d.update(schema.runs).set({ busyAction: null, status: 'error', error: `上传失败: ${m}`, updatedAt: now() }).where(eq(schema.runs.id, id)).run()
    throw createError({ statusCode: 500, statusMessage: `上传失败: ${m}` })
  }
})
