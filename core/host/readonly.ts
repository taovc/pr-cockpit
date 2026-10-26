import type { CanUseTool, HookCallback } from '@anthropic-ai/claude-agent-sdk'
import { isDangerousBash } from '../agent/guard'
import { REVIEW_BASH_HELP, reviewBashVerdict } from '../agent/reviewBash'

// Read-only policy for the review family (review / guided / recheck / skillgen). Three independent layers, any one of
// which is enough on its own:
//   1. a PreToolUse hook (runs before permission rules, so a user "allow" rule cannot bypass it) — reviewGuardHook
//   2. inline `settings` deny rules + disableAllHooks (the user's own hooks are the only vector that could execute code
//      inside the review worktree) — REVIEW_DENY_RULES
//   3. disallowedTools + canUseTool + permissionMode 'default' — REVIEW_DISALLOWED_TOOLS / reviewCanUseTool
// Bash runs only allowlisted read commands (core/agent/reviewBash.ts), with the old blacklist kept as a second check.
// MCP is never connected in a review; an MCP tool call is always denied.

export const READONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'Skill', 'TodoWrite', 'Task', 'Agent', 'TaskOutput', 'TaskStop', 'StructuredOutput']) // StructuredOutput = how the CLI delivers outputFormat json_schema results

export const REVIEW_DISALLOWED_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'ExitPlanMode', 'EnterPlanMode']

export const REVIEW_DENY_RULES = [
  ...REVIEW_DISALLOWED_TOOLS,
  'Bash(git push:*)', 'Bash(git commit:*)', 'Bash(git add:*)', 'Bash(git reset:*)', 'Bash(git rebase:*)', 'Bash(git merge:*)',
  'Bash(git checkout:*)', 'Bash(git switch:*)', 'Bash(git restore:*)', 'Bash(git stash:*)', 'Bash(git clean:*)', 'Bash(git worktree:*)',
  'Bash(gh pr comment:*)', 'Bash(gh pr review:*)', 'Bash(gh pr merge:*)', 'Bash(gh pr close:*)', 'Bash(gh pr edit:*)', 'Bash(gh pr create:*)',
  'Bash(gh issue comment:*)', 'Bash(gh issue create:*)', 'Bash(gh issue close:*)', 'Bash(gh issue edit:*)',
  'Bash(rm:*)', 'Bash(sudo:*)', 'Bash(curl:*)', 'Bash(wget:*)',
]

export type Verdict = { ok: true } | { ok: false; reason: string }

// The single decision function behind layers 1 and 3.
export function reviewVerdict(toolName: string, input: unknown): Verdict {
  if (READONLY_TOOLS.has(toolName)) return { ok: true }
  if (toolName === 'Bash') {
    const cmd = String((input as any)?.command ?? '')
    const v = reviewBashVerdict(cmd)
    if (!v.ok) return { ok: false, reason: `blocked "${cmd.slice(0, 100)}" (${v.reason}). ${REVIEW_BASH_HELP}` }
    if (isDangerousBash(cmd)) return { ok: false, reason: `blocked "${cmd.slice(0, 100)}". ${REVIEW_BASH_HELP}` }
    return { ok: true }
  }
  if (toolName.startsWith('mcp__') || toolName === 'ListMcpResourcesTool' || toolName === 'ReadMcpResourceTool') return { ok: false, reason: `MCP is not available in reviews (tool ${toolName})` }
  return { ok: false, reason: `tool ${toolName} is not allowed` }
}

export function makeReviewCanUseTool(): CanUseTool {
  return async (toolName, input) => {
    const v = reviewVerdict(toolName, input)
    if (v.ok) return { behavior: 'allow', updatedInput: input }
    return { behavior: 'deny', message: `Denied by PR Cockpit security policy — ${v.reason}`, interrupt: false }
  }
}

// Layer 1: a hook decision beats every permission rule; anything not denied here still goes through layers 2 and 3.
export function makeReviewGuardHook(): HookCallback {
  return async (input) => {
    if ((input as any)?.hook_event_name !== 'PreToolUse') return {}
    const toolName = String((input as any).tool_name ?? '')
    const v = reviewVerdict(toolName, (input as any).tool_input)
    if (v.ok) return {}
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `PR Cockpit read-only guard — ${v.reason}` } }
  }
}
