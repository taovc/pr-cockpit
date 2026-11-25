import { inArray, eq, and, lt } from 'drizzle-orm'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { getDb, schema } from '~core/db/client'
import { migrateWorktreeToRepo, removeWorktree } from '~core/git/worktree'
import { recoverHostState } from '~core/host/recover'
import { interruptedPushLanded } from '~core/fix/status'
import { reviewHistoryRootFor, sweepOrphanHistories } from '~core/agent/reviewHistory'

const pexec = promisify(execFile)

// Startup recovery: tasks that were "running" in the previous process die with it. As soon as the server starts,
// bring anything stuck back to a consistent state.
// - Review tasks (agent running): reset to error + clean the worktree.
// - Session runs (PR / feature / cwd): a chat turn has no persistent stage state (an in-flight chat is held by an in-memory lock, released
//   on restart); the only thing to reconcile is pushing (a crash midway through commit-and-push, where the push may
//   already have reached GitHub). Interrupted chat turns are just marked stopped, and the changes stay in the worktree
//   waiting for the user to upload them (no automatic commit).
const REVIEW_IN_FLIGHT = ['queued', 'cloning', 'reviewing', 'recheck_requested', 'rechecking']

export default defineNitroPlugin(async () => {
  const cfg = useRuntimeConfig()
  const d = getDb(cfg.dbPath as string)
  const now = () => new Date().toISOString()
  const bootAt = now() // rows created after this instant belong to the live server, not to a dead process
  const git = (wt: string, args: string[]) => pexec('git', ['-C', wt, ...args], { maxBuffer: 64 * 1024 * 1024, timeout: 15000 })

  // 0) By default migrate into .pr-cockpit-worktrees/ inside the project repo.
  // Only persistent worktrees that still exist are moved (fix / feature); review worktrees are temporary and startup recovery cleans them up.
  try {
    const projects = new Map(d.select().from(schema.projects).all().map((p: any) => [p.id, p]))
    let moved = 0
    let cleared = 0
    const writePath = (id: string, worktreePath: string | null) => {
      d.update(schema.runs).set({ workspacePath: worktreePath, updatedAt: now() }).where(eq(schema.runs.id, id)).run()
    }
    const moveOne = async (row: any) => {
      // The directory is long gone (cleaned on restart / deleted by hand) but the path to the old central directory is
      // still recorded: migration can't move it, and keeping it makes "upload" fail outright with worktree gone.
      // Clearing it → the next turn recreates the worktree at the new location on the same branch.
      if (!existsSync(row.workspacePath)) {
        writePath(row.id, null)
        cleared++
        return
      }
      const proj: any = projects.get(row.projectId)
      const nextPath = await migrateWorktreeToRepo({
        localPath: proj?.localPath ?? null,
        reposDir: cfg.reposDir as string,
        taskId: row.id,
        currentPath: row.workspacePath ?? null,
        location: cfg.worktreeLocation as string,
      })
      if (!nextPath) return
      writePath(row.id, nextPath)
      moved++
    }

    const sessions = d.select().from(schema.runs).where(and(eq(schema.runs.kind, 'session'), inArray(schema.runs.workspaceType, ['pr_worktree', 'branch_worktree']))).all() as any[]
    for (const r of sessions) {
      if (r.workspacePath) {
        try { await moveOne(r) } catch (e) { console.error(`[recover] session worktree 迁移失败 ${r.id}`, e) }
      }
    }
    if (moved) console.log(`[recover] 迁移了 ${moved} 个持久 worktree 到项目 repo 内`)
    if (cleared) console.log(`[recover] 清空了 ${cleared} 条指向已消失 worktree 的路径（下次使用时按原分支重建）`)
  } catch (e) {
    console.error('[recover] worktree 启动迁移失败', e)
  }

  // 1) Review tasks: reset + clean the worktree (review worktrees are throwaway)
  try {
    const stuck = d.select().from(schema.reviews).where(inArray(schema.reviews.status, REVIEW_IN_FLIGHT as any)).all()
    if (stuck.length) {
      const projects = new Map(d.select().from(schema.projects).all().map((p: any) => [p.id, p]))
      for (const r of stuck) {
        d.update(schema.reviews)
          .set({ status: 'error', error: '服务重启导致审核中断，请重新审核', updatedAt: now() })
          .where(eq(schema.reviews.id, r.id))
          .run()
        const proj: any = projects.get(r.projectId)
        await removeWorktree(proj?.localPath ?? null, cfg.reposDir as string, r.id, { location: cfg.worktreeLocation as string })
      }
      console.log(`[recover] 重置了 ${stuck.length} 个中断的审核任务并清理 worktree`)
    }
  } catch (e) {
    console.error('[recover] 审核任务启动恢复失败', e)
  }

  // 1.5) Interrupted comment posting (posting): the agent stage finished long ago and the findings are intact, only the
  // publish window died with the process. Reset to ready_to_post (no automatic retry — the post may already have reached
  // GitHub and retrying would duplicate the comment; let the user decide in the UI whether to post again).
  try {
    const stuck = d.select().from(schema.reviews).where(eq(schema.reviews.status, 'posting' as any)).all()
    for (const r of stuck as any[]) {
      d.update(schema.reviews).set({ status: 'ready_to_post', updatedAt: now() }).where(eq(schema.reviews.id, r.id)).run()
    }
    if (stuck.length) console.log(`[recover] 重置了 ${stuck.length} 个中断的发布（posting → ready_to_post，请在 GitHub 确认后再决定是否重发）`)
  } catch (e) {
    console.error('[recover] posting 启动恢复失败', e)
  }

  // 1.6) Prepared re-review history whose task is gone: deleting a task removes its directory, but a crash between
  // writing one and deleting it leaves a directory nobody owns. Whatever no review claims goes.
  try {
    const live = new Set((d.select().from(schema.reviews).all() as any[]).map((r) => r.id))
    const removed = sweepOrphanHistories(reviewHistoryRootFor(cfg.dbPath as string), live)
    if (removed) console.log(`[recover] 清理了 ${removed} 份无主的复审历史目录`)
  } catch (e) {
    console.error('[recover] 复审历史清理失败', e)
  }

  // 2) Interrupted upload (busy_action = pushing): the push may already have reached GitHub (it just wasn't written back).
  // Reconcile origin/<branch> against the worktree's real HEAD: equal on a clean worktree = it succeeded → pushed; otherwise
  // → error (the user re-uploads; push is idempotent and has no side effects).
  try {
    const stuck = d.select().from(schema.runs).where(eq(schema.runs.busyAction, 'pushing')).all()
    for (const f of stuck as any[]) {
      let pushed = false
      let localHead: string | null = f.fixHeadSha
      if (f.workspacePath && existsSync(f.workspacePath) && f.branch) {
        try { localHead = (await git(f.workspacePath, ['rev-parse', 'HEAD'])).stdout.trim() || f.fixHeadSha } catch { /* fall back to the DB value */ }
        let dirty: boolean | null = null
        try { dirty = (await git(f.workspacePath, ['status', '--porcelain'])).stdout.trim() !== '' } catch { /* unknown → not pushed */ }
        let remoteHead: string | null = null
        try {
          const { stdout } = await git(f.workspacePath, ['ls-remote', 'origin', f.branch])
          remoteHead = stdout.trim().split(/\s+/)[0] || null
        } catch { /* network/remote unreachable → treat as not pushed */ }
        pushed = interruptedPushLanded({ localHead, remoteHead, dirty })
      }
      if (pushed) {
        d.update(schema.runs)
          .set({ busyAction: null, error: null, fixHeadSha: localHead, lastPushSha: localHead, uploadState: 'pushed', pushedAt: f.pushedAt || now(), updatedAt: now() })
          .where(eq(schema.runs.id, f.id))
          .run()
      } else {
        d.update(schema.runs)
          .set({ busyAction: null, status: 'error', error: '上传中断，请重新上传', updatedAt: now() })
          .where(eq(schema.runs.id, f.id))
          .run()
      }
    }
    if (stuck.length) console.log(`[recover] 对账了 ${stuck.length} 个中断的上传`)
  } catch (e) {
    console.error('[recover] 上传启动恢复失败', e)
  }

  // 2.5) Session host: prompts parked in the dead process expire, runs it left running/awaiting → stopped (core/host/recover.ts).
  try {
    const r = recoverHostState(d, schema, bootAt, now())
    if (r.expiredPrompts || r.stoppedRuns) console.log(`[recover] 会话宿主：${r.expiredPrompts} 个待回答的权限请求已过期，${r.stoppedRuns} 个运行标记为 stopped`)
  } catch (e) {
    console.error('[recover] 会话宿主启动恢复失败', e)
  }

  // 3) Interrupted chat turns: assistant turns still streaming → stopped. The changes stay in the worktree (uncommitted),
  // and next time it's opened the dirty check makes the upload button appear.
  try {
    const streaming = d.select().from(schema.runTurns).where(inArray(schema.runTurns.status, ['streaming', 'queued'] as any)).all() // queued messages died with the process too
    for (const tn of streaming as any[]) {
      d.update(schema.runTurns).set({ status: 'stopped', endedAt: now() }).where(eq(schema.runTurns.id, tn.id)).run()
    }
    if (streaming.length) console.log(`[recover] 重置了 ${streaming.length} 个中断的对话轮`)
  } catch (e) {
    console.error('[recover] 对话轮启动恢复失败', e)
  }
})
