import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import type { CanUseTool, HookCallback, PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import { classifyGithubCommand } from '../agent/commandGuard'
import { isDangerousCommand } from '../agent/dangerGuard'
import type { PromptAnswer, PromptKind, RunEvent, RunSpec } from './types'

// The permission bridge: the SDK asks (canUseTool) → we persist a pending permission_requests row, emit a
// permission_request event and PARK the promise. The UI answers over HTTP → the promise resolves with the
// PermissionResult the SDK expects. AskUserQuestion and ExitPlanMode travel the same path with their own kinds.

export type PendingPrompt = {
  id: string
  runId: string
  kind: PromptKind
  toolName: string
  input: Record<string, unknown>
  suggestions?: PermissionUpdate[]
  resolve: (r: PermissionResult) => void
  createdAt: number
}

export type PromptStore = {
  db?: any
  schema?: any
}

export function promptKindFor(toolName: string): PromptKind {
  if (toolName === 'AskUserQuestion') return 'question'
  if (toolName === 'ExitPlanMode') return 'plan'
  return 'tool'
}

// Translate the UI's answer into the SDK's PermissionResult.
export function toPermissionResult(p: Pick<PendingPrompt, 'kind' | 'input' | 'suggestions'>, a: PromptAnswer): PermissionResult {
  if (a.behavior === 'deny') return { behavior: 'deny', message: a.message?.trim() || 'Denied by the user in PR Cockpit', interrupt: false }
  if (a.behavior === 'answer') {
    // AskUserQuestion: the answers ride back inside updatedInput (keyed by the question text) as strings — a multi-select
    // picks several labels which the tool expects joined (the CLI joins with ', ').
    const answers: Record<string, string> = {}
    for (const [q, v] of Object.entries(a.answers)) answers[q] = Array.isArray(v) ? v.join(', ') : v
    return { behavior: 'allow', updatedInput: { ...p.input, answers } }
  }
  // Scope "always" to the live session: suggestions may target settings files, which the product must not edit on the user's behalf.
  const updatedPermissions = a.always && p.suggestions?.length ? p.suggestions.map(s => ({ ...s, destination: 'session' as const })) : undefined
  return { behavior: 'allow', updatedInput: p.input, ...(updatedPermissions ? { updatedPermissions } : {}), decisionClassification: a.always ? 'user_permanent' : 'user_temporary' }
}

// DB helpers (best effort — a failed write must never block the agent).
export function insertPromptRow(store: PromptStore, p: PendingPrompt, extra: { turnId?: string | null; title?: string; description?: string }): void {
  if (!store.db || !store.schema) return
  try {
    store.db.insert(store.schema.permissionRequests).values({
      id: p.id, runId: p.runId, turnId: extra.turnId ?? null, toolUseId: null, kind: p.kind, toolName: p.toolName,
      input: safeJson(p.input), suggestions: p.suggestions ? safeJson(p.suggestions) : null, title: extra.title ?? null, description: extra.description ?? null,
      status: 'pending', createdAt: new Date().toISOString(),
    }).run()
  } catch (e) { console.warn('[host] insertPromptRow failed', (e as Error).message) }
}

export function resolvePromptRow(store: PromptStore, id: string, status: 'allowed' | 'denied' | 'answered' | 'expired' | 'cancelled', answer?: PromptAnswer): void {
  if (!store.db || !store.schema) return
  try {
    store.db.update(store.schema.permissionRequests)
      .set({ status, answer: answer ? safeJson(answer) : null, always: !!(answer && answer.behavior === 'allow' && answer.always), resolvedAt: new Date().toISOString() })
      .where(eq(store.schema.permissionRequests.id, id)).run()
  } catch (e) { console.warn('[host] resolvePromptRow failed', (e as Error).message) }
}

// Bounded JSON for persistence: a Write/Edit tool input carries whole file contents — keep enough to show, not everything.
const MAX_JSON = 32_000
export function safeJson(v: unknown): string {
  try {
    const s = JSON.stringify(v)
    return s.length > MAX_JSON ? JSON.stringify({ _truncated: true, _length: s.length, preview: s.slice(0, MAX_JSON) }) : s
  } catch { return String(v) }
}

// Build the canUseTool callback for one live run. `ctx` gives the host's mutable state and emit hook.
export function makePromptBridge(ctx: {
  runId: string
  store: PromptStore
  prompts: Map<string, PendingPrompt>
  currentTurnId: () => string | null
  emit: (e: RunEvent) => void
  onWaiting: (waiting: boolean) => void
  onParked?: (promptId: string) => void // a prompt is now waiting (the host arms its TTL)
  onSettled?: (promptId: string) => void // answered / cancelled / expired
}): CanUseTool {
  return async (toolName, input, o) => {
    const id = nanoid()
    const kind = promptKindFor(toolName)
    const p: PendingPrompt = { id, runId: ctx.runId, kind, toolName, input: input ?? {}, suggestions: o.suggestions, resolve: () => {}, createdAt: Date.now() }
    insertPromptRow(ctx.store, p, { turnId: ctx.currentTurnId(), title: o.title, description: o.description })
    ctx.emit({ t: 'permission_request', promptId: id, kind, toolName, input: p.input, title: o.title, description: o.description, suggestions: o.suggestions })
    ctx.onWaiting(true)
    return new Promise<PermissionResult>((resolve) => {
      p.resolve = (r) => {
        ctx.prompts.delete(id)
        ctx.onSettled?.(id)
        if (!ctx.prompts.size) ctx.onWaiting(false)
        resolve(r)
      }
      ctx.prompts.set(id, p)
      ctx.onParked?.(id)
      // The SDK aborts the request when the turn is interrupted or the query closes → mark cancelled, don't leave a zombie row.
      o.signal?.addEventListener('abort', () => {
        if (!ctx.prompts.has(id)) return
        resolvePromptRow(ctx.store, id, 'cancelled')
        ctx.emit({ t: 'permission_resolved', promptId: id, status: 'cancelled' })
        p.resolve({ behavior: 'deny', message: 'cancelled', interrupt: false })
      }, { once: true })
    })
  }
}

// Answer a parked prompt. Returns false when nothing is waiting under that id (already answered / expired / other process).
export function answerPending(prompts: Map<string, PendingPrompt>, store: PromptStore, emit: (e: RunEvent) => void, promptId: string, a: PromptAnswer): boolean {
  const p = prompts.get(promptId)
  if (!p) return false
  const status = a.behavior === 'deny' ? 'denied' : a.behavior === 'answer' ? 'answered' : 'allowed'
  resolvePromptRow(store, promptId, status, a)
  emit({ t: 'permission_resolved', promptId, status })
  p.resolve(toPermissionResult(p, a))
  return true
}

// PreToolUse hook: dangerous Bash commands (push / rm -rf / sudo / gh pr create / GitHub writes …) become a permission
// card in EVERY permission mode (hooks run before the mode decides), unless the run's allowDanger switch is on.
// Approving or merging a PR is denied outright in worktree sessions (fix / feature scope), whatever the switch says.
// Both are read live so a toggle mid-session takes effect on the next command.
export function makeDangerHook(isAllowed: () => boolean, scopeOf: () => RunSpec['guardScope'] = () => undefined): HookCallback {
  return async (input) => {
    if ((input as any).hook_event_name !== 'PreToolUse' || (input as any).tool_name !== 'Bash') return {}
    const cmd = String(((input as any).tool_input as any)?.command ?? '')
    const gh = classifyGithubCommand(cmd)
    const scope = scopeOf()
    if (gh === 'approve-merge' && (scope === 'fix' || scope === 'feature')) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `Denied by PR Cockpit policy: approving or merging a pull request is done by the human in PR Cockpit, never from a worktree session. Blocked command: ${cmd.slice(0, 120)}`,
        },
      }
    }
    if ((!gh && !isDangerousCommand(cmd)) || isAllowed()) return {}
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: `PR Cockpit danger guard: "${cmd.slice(0, 120)}" can push, delete or escalate — confirm explicitly (or turn on "allow dangerous commands").`,
      },
    }
  }
}
