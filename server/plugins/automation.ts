import { eq, sql, and, or, isNull, ne } from 'drizzle-orm'
import { getDb, schema } from '~core/db/client'
import { listPulls, getCurrentUserLogin } from '~core/github/gh'
import { isRunBusy } from '~core/runs/session'
import { runAutomationTick, type EngineDeps } from '~core/automation/engine'
import { buildAutoFixMessage } from '~core/automation/fixprompt'
import { resolveLang } from '~core/agent/lang'

// The resident PR automation engine: the only server-side timed loop (a Nitro plugin like recover.ts,
// one instance per process). Every automationIntervalMs it runs one runAutomationTick: read DB +
// GitHub state, then dispatch work through the existing HTTP endpoints.
// All side effects go through internal $fetch (keeping each endpoint's existing guards: dedup /
// concurrency lock / push safety checks); the engine never touches GitHub/git directly.
export default defineNitroPlugin((nitroApp) => {
  const cfg = useRuntimeConfig()
  // Master switch (shuts the whole engine down). runtimeConfig is evaluated at build time and a
  // production .output deploy only honours NUXT_-prefixed vars; we additionally read
  // process.env.AUTOMATION_ENABLED at runtime so a bare env var can still kill it in a deployment.
  if ((cfg.automationEnabled as any) === false || process.env.AUTOMATION_ENABLED === 'false') return

  const d = getDb(cfg.dbPath as string)
  const now = () => new Date().toISOString()
  const intervalMs = Math.max(10_000, Number(cfg.automationIntervalMs) || 45_000)
  // The engine is timer-driven with no user request context, so there is no mr-locale cookie to read
  // → the central default decides the working language (otherwise every endpoint falls back to zh).
  const lang = resolveLang(cfg.automationLang as string)
  const cookieHeader = { cookie: `mr-locale=${lang}` }
  // The currently logged-in gh user: the default for the auto-fix author allowlist (empty filter =
  // only fix my own PRs, never touch other people's). Resolved on the first tick; stays null while gh
  // is not ready yet (= fix nothing).
  let currentUser: string | null = null

  const deps: EngineDeps = {
    now,
    isChatting: isRunBusy,
    get currentUser() { return currentUser },
    log: (msg) => console.log(`[automation] ${msg}`),
    listPulls: (repo, state, first) => listPulls(repo, state, first),

    // Create the review task + start reviewing automatically (reviews.post auto-enqueues when localPath exists)
    dispatchReview: async (projectId, prNumber) => {
      await $fetch('/api/reviews', { method: 'POST', headers: cookieHeader, body: { projectId, pulls: [{ number: prNumber }] } })
    },
    // Re-check what the author changed
    dispatchRecheck: async (reviewId) => {
      await $fetch(`/api/reviews/${reviewId}/recheck`, { method: 'POST', headers: cookieHeader })
    },
    // Auto-post comments: select every finding → call the post endpoint (dryRun=false really posts to GitHub).
    // If the post endpoint returns 4xx because there is "nothing to post" (e.g. the re-check filtered out every
    // finding), push the review out of draft (→ ready_to_post) to stop the bleeding; otherwise decide would pick
    // post again every round and loop forever on the same 400. Other errors (network/422) are propagated as before,
    // so the engine logs them and retries next round.
    dispatchPost: async (reviewId) => {
      // Tick everything for auto-post, but never overwrite a human's own decision provenance.
      d.update(schema.findings)
        .set({ checked: true, checkedBy: sql`CASE WHEN ${schema.findings.checked} = 1 AND ${schema.findings.checkedBy} IS NOT NULL THEN ${schema.findings.checkedBy} ELSE 'engine' END`, checkedAt: now() })
        .where(and(eq(schema.findings.reviewId, reviewId), or(isNull(schema.findings.verifyStatus), ne(schema.findings.verifyStatus, 'refuted')))).run() // never auto-post what the verify pass refuted
      try {
        await $fetch(`/api/reviews/${reviewId}/post`, { method: 'POST', headers: cookieHeader, body: { dryRun: false } })
        return { posted: true }
      } catch (e: any) {
        const code = e?.statusCode ?? e?.response?.status
        const msg = e?.data?.statusMessage || e?.statusMessage || e?.message || '发评论失败'
        // 409 = another poster/task currently holds this review (posting / a review is running) → do not touch the
        // status (that would stomp the holder's 'posting' claim), do not stop the bleeding, do not stop automation;
        // let the holder finish and look again next round.
        if (code === 409) return { posted: false }
        // Any other failure: push the review out of draft to stop the bleeding, so we do not hit the same error every
        // round (the post endpoint already reset the status to draft on failure; here we lift it to ready_to_post).
        d.update(schema.reviews).set({ status: 'ready_to_post', updatedAt: now() }).where(eq(schema.reviews.id, reviewId)).run()
        // 400 = nothing to post (the re-check filtered out every finding) → normal, not an error, stay silent; anything
        // else (translation failure/network/422) → report it to the timeline as an error.
        if (code === 400) return { posted: false }
        // 422 = the language check held the post (left for a human to preview); not a failure of the post itself.
        const note = code === 422 ? `语言检查拦下了自动发评论，已停下等你在预览里确认：${msg}` : msg
        console.log(`[automation] review ${reviewId} 发评论失败: ${note}`)
        return { posted: false, error: note }
      }
    },
    // Auto-fix: create/reuse the fix task → build the default instruction from the review findings → start a chat that edits the code (no commit)
    dispatchFix: async (projectId, prNumber, reviewId) => {
      const created = await $fetch<{ id: string }>('/api/runs', { method: 'POST', headers: cookieHeader, body: { workspaceType: 'pr_worktree', projectId, prNumber } })
      const runRow = d.select().from(schema.runs).where(eq(schema.runs.id, created.id)).get() as any
      const message = buildAutoFixMessage(d, schema, reviewId, runRow?.lang || lang)
      if (!message) return // no finding left to fix (decide should already have filtered this out) → do not start a chat
      // Unattended: the danger guard stays on and the session runs in its default mode.
      await $fetch(`/api/runs/${created.id}/messages`, { method: 'POST', headers: cookieHeader, body: { message, allowDanger: false } })
    },
    // Upload the fix (commit + push, reusing all of the push endpoint's safety checks)
    dispatchPush: async (fixId) => {
      await $fetch(`/api/runs/${fixId}/push`, { method: 'POST', headers: cookieHeader, body: { dryRun: false } })
    },
  }

  let running = false
  const tick = async () => {
    if (running) return // skip this round if the previous one is still running (better-sqlite3 is synchronous, do not overlap)
    running = true
    try {
      if (!currentUser) currentUser = await getCurrentUserLogin().catch(() => null) // resolve once and cache it, after gh is ready
      await runAutomationTick(d, schema, deps)
    } catch (e) {
      console.error('[automation] tick failed', e)
    } finally {
      running = false
    }
  }

  // The first round is delayed by intervalMs: give recover.ts time to wrap up interrupted tasks instead of racing it.
  const timer = setInterval(tick, intervalMs)
  // The timer must not keep the process alive (unref); clean it up via Nitro's close hook — which fires on dev hot
  // reload / graceful shutdown — so a hot reload does not stack up another setInterval and end up with several
  // engines dispatching duplicate work in parallel ('beforeExit' never fires while a timer is active, so it cannot
  // be used for this).
  if (typeof timer.unref === 'function') timer.unref()
  nitroApp.hooks.hook('close', () => clearInterval(timer))
  console.log(`[automation] 引擎已启动，轮询间隔 ${Math.round(intervalMs / 1000)}s · 语言 ${lang}`)
})
