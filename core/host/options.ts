import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CanUseTool, HookCallback, Options } from '@anthropic-ai/claude-agent-sdk'
import { resolveClaudeExecutable } from '../agent/claude-bin'
import type { RunSpec } from './types'
import { makeReviewCanUseTool, makeReviewGuardHook, REVIEW_DENY_RULES, REVIEW_DISALLOWED_TOOLS } from './readonly'

// The single place SDK options are assembled. Sessions load the user's configuration exactly like the CLI
// (settingSources omitted = user+project+local → settings.json, CLAUDE.md, rules, skills, commands, hooks, MCP,
// plugins) and keep Claude Code's own system prompt, appending ours. Safety lives in permissions (mode +
// canUseTool bridge + danger hook), not in isolation.
export function buildOptions(spec: RunSpec, hooks: { canUseTool: CanUseTool; dangerHook: HookCallback; abort: AbortController; stderr?: (d: string) => void }): Options {
  const bin = resolveClaudeExecutable()
  const env: Record<string, string | undefined> = { ...process.env }
  if (spec.projectDirName) env.CLAUDE_CODE_PROJECT_DIR_NAME = spec.projectDirName
  const opts: Options = {
    cwd: spec.cwd,
    ...(spec.model ? { model: spec.model } : {}),
    ...(spec.effort ? { effort: spec.effort as Options['effort'] } : {}),
    permissionMode: spec.permissionMode ?? 'default',
    // Required up front so the user can switch to bypassPermissions later in the session without restarting it.
    allowDangerouslySkipPermissions: true,
    systemPrompt: spec.systemAppend ? { type: 'preset', preset: 'claude_code', append: spec.systemAppend } : { type: 'preset', preset: 'claude_code' },
    ...(spec.resume ? { resume: spec.resume, ...(spec.fork ? { forkSession: true } : {}) } : {}),
    includePartialMessages: true, // text deltas for live streaming
    // Current models return thinking blocks with no text unless the session asks for summaries, which left the
    // chat's thinking cards permanently empty (and therefore never rendered).
    thinking: { type: 'adaptive', display: 'summarized' },
    canUseTool: hooks.canUseTool,
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [hooks.dangerHook] }] },
    toolConfig: { askUserQuestion: { previewFormat: 'html' } },
    ...(spec.kind === 'session' ? { enableFileCheckpointing: true } : {}), // per-message file snapshots → "rewind to here" in the UI
    env,
    ...(spec.chrome ? { extraArgs: { chrome: null } } : {}),
    ...(bin ? { pathToClaudeCodeExecutable: bin } : {}),
    abortController: hooks.abort,
    ...(hooks.stderr ? { stderr: hooks.stderr } : {}),
    ...(spec.kind === 'probe' ? { persistSession: false } : {}),
  }
  return opts
}

// Claude Code keys its per-project memory/transcript directory by the sanitised cwd. Reviews and PR sessions run in
// worktrees, so we pin the directory to the project's main clone to keep one memory per project instead of one per worktree.
export function projectDirNameFor(localPath: string | null | undefined): string | undefined {
  if (!localPath) return undefined
  return localPath.replace(/[^a-zA-Z0-9]/g, '-')
}

// Optional USD cap per review-family execution (REVIEW_MAX_BUDGET_USD, e.g. 5). 0/unset = no cap; the CLI ends the turn with
// error_max_budget_usd when it is hit, which the pipeline reports as a failed review.
const REVIEW_MAX_BUDGET_USD = Number(process.env.REVIEW_MAX_BUDGET_USD || 0)

export type ReviewOptionsSpec = {
  cwd: string
  model?: string
  effort?: string
  methodology: string // already wrapped by withContract()
  maxTurns: number
  mcp?: boolean // let the review connect and call the user's MCP servers (agent-config switch; off = none connected)
  chrome?: boolean // with mcp: also start Claude in Chrome (--chrome), like sessions do
  projectDirName?: string
  abort?: AbortController
  outputSchema?: Record<string, unknown> // JSON Schema the CLI validates the final message against (structured_output on the result)
}

// Review family: the user's configuration is loaded like the CLI, but the run is read-only by three independent layers
// (see core/host/readonly.ts) and the operating contract is appended to Claude Code's own system prompt.
export function buildReviewOptions(spec: ReviewOptionsSpec): Options {
  const bin = resolveClaudeExecutable()
  const env: Record<string, string | undefined> = { ...process.env }
  if (spec.projectDirName) env.CLAUDE_CODE_PROJECT_DIR_NAME = spec.projectDirName
  const mcp = !!spec.mcp
  // The review cwd is the PR branch worktree — attacker-controlled content. With MCP on the CLI would auto-approve and SPAWN
  // servers from the branch's own .mcp.json before any tool call (verified against the bundled CLI), which none of the three
  // read-only layers can see. A rejection beats every approval, so list them as disabled.
  const projectMcp = mcp ? projectMcpServerNames(spec.cwd) : []
  return {
    cwd: spec.cwd,
    ...(spec.model ? { model: spec.model } : {}),
    ...(spec.effort ? { effort: spec.effort as Options['effort'] } : {}),
    systemPrompt: { type: 'preset', preset: 'claude_code', append: spec.methodology },
    permissionMode: 'default',
    canUseTool: makeReviewCanUseTool(mcp),
    hooks: { PreToolUse: [{ hooks: [makeReviewGuardHook(mcp)] }] },
    disallowedTools: REVIEW_DISALLOWED_TOOLS,
    settings: { permissions: { deny: REVIEW_DENY_RULES }, disableAllHooks: true, ...(projectMcp.length ? { disabledMcpjsonServers: projectMcp } : {}) },
    // MCP off → do not even connect the configured servers (faster start, nothing to leak to); on → the CLI connects
    // them like a session does, optionally with Claude in Chrome.
    ...(mcp ? {} : { mcpServers: {}, strictMcpConfig: true }),
    ...(mcp && spec.chrome ? { extraArgs: { chrome: null } } : {}),
    maxTurns: spec.maxTurns,
    ...(REVIEW_MAX_BUDGET_USD > 0 ? { maxBudgetUsd: REVIEW_MAX_BUDGET_USD } : {}),
    ...(spec.outputSchema ? { outputFormat: { type: 'json_schema', schema: spec.outputSchema } } : {}),
    env,
    ...(bin ? { pathToClaudeCodeExecutable: bin } : {}),
    ...(spec.abort ? { abortController: spec.abort } : {}),
  }
}

export function projectMcpServerNames(cwd: string): string[] {
  const file = join(cwd, '.mcp.json')
  if (!existsSync(file)) return []
  try { const v = JSON.parse(readFileSync(file, 'utf8')); const servers = v?.mcpServers ?? v; return servers && typeof servers === 'object' ? Object.keys(servers) : [] } catch { return ['*'] } // unreadable → refuse anything it could declare
}

// One-shot text helpers (commit message, title, comment rewrite, JSON repair): no user configuration, no tools, one turn,
// nothing persisted, and an explicit cwd so nothing runs in the server's own directory by accident.
export function buildHelperOptions(spec: { cwd: string; model?: string; effort?: string; abort?: AbortController }): Options {
  const bin = resolveClaudeExecutable()
  return {
    cwd: spec.cwd,
    ...(spec.model ? { model: spec.model } : {}),
    ...(spec.effort ? { effort: spec.effort as Options['effort'] } : {}),
    settingSources: [],
    mcpServers: {},
    strictMcpConfig: true,
    tools: [],
    maxTurns: 1,
    persistSession: false,
    permissionMode: 'dontAsk',
    ...(bin ? { pathToClaudeCodeExecutable: bin } : {}),
    ...(spec.abort ? { abortController: spec.abort } : {}),
  }
}

// Configuration probe (agent-config screen): load everything like a session would, never persist, never run a turn.
export function buildProbeOptions(spec: { cwd: string; chrome?: boolean; projectDirName?: string; abort: AbortController }): Options {
  const bin = resolveClaudeExecutable()
  const env: Record<string, string | undefined> = { ...process.env }
  if (spec.projectDirName) env.CLAUDE_CODE_PROJECT_DIR_NAME = spec.projectDirName
  return {
    cwd: spec.cwd,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    permissionMode: 'default',
    persistSession: false,
    env,
    ...(spec.chrome ? { extraArgs: { chrome: null } } : {}),
    ...(bin ? { pathToClaudeCodeExecutable: bin } : {}),
    abortController: spec.abort,
  }
}
