import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
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
  const env = cliEnv()
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

// Claude Code keys its per-project memory/transcript directory by the sanitised cwd. This names the project's main clone
// for worktree runs, but the CLI only honours it when CLAUDE_CONFIG_DIR is set, so today worktrees keep their own directory.
// Where the CLI keeps projects/ (transcripts, memory): CLAUDE_CONFIG_DIR when set, else ~/.claude.
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

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
  projectDirName?: string
  abort?: AbortController
  outputSchema?: Record<string, unknown> // JSON Schema the CLI validates the final message against (structured_output on the result)
  baseBranch?: string // project instructions are read from origin/<baseBranch>; without it, from the files in cwd
  clean?: boolean // load no configuration and no memory at all (the scope-review pipeline); everything it needs is in the prompt
  baseRules?: boolean // append the base branch's CLAUDE.md / AGENTS.md (default true)
  resume?: string // continue this session (a second query on the same conversation)
  keepTranscript?: boolean // write the session to disk (needed to resume it); review runs are one-shot and write none by default
}

// The identity of a parent Claude Code / desktop session the server may have been started from; the user's own CLI
// configuration (CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_*…) is kept.
const SESSION_ENV = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PREVIEW_\w+|CLAUDE_AGENT_SDK_\w+|AI_AGENT|CLAUDE_CODE_(ENTRYPOINT|SESSION_ID|SESSION_ATTENDED|CHILD_SESSION|HOST_SESSION_ID|MESSAGING_\w+|DESKTOP_APP_VERSION|EXECPATH|SDK_HAS_HOST_AUTH_REFRESH|ACCOUNT_UUID|ORGANIZATION_UUID|USER_EMAIL|OAUTH_SCOPES|TERMINAL_MCP_TOOLS|EMIT_\w+|EAGER_FLUSH|STARTUP_FAILURE_RESULTS|ENABLE_ASK_USER_QUESTION_TOOL|ENABLE_SDK_FILE_CHECKPOINTING|DISABLE_CRON|DISABLE_TERMINAL_TITLE|SIMPLE))$/

export function cliEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(base).filter(([k]) => !SESSION_ENV.test(k)))
}

// Review family: only the user's own configuration is loaded; the PR branch's CLAUDE.md and .claude/ are author-controlled.
export async function buildReviewOptions(spec: ReviewOptionsSpec): Promise<Options> {
  const bin = resolveClaudeExecutable()
  const env = cliEnv()
  if (spec.projectDirName) env.CLAUDE_CODE_PROJECT_DIR_NAME = spec.projectDirName // only honoured with CLAUDE_CONFIG_DIR set; clean runs load no memory either way
  const rules = spec.baseRules === false ? [] : await projectRules(spec.cwd, spec.baseBranch)
  // No MCP in a review. The PR branch's own .mcp.json is also listed as disabled, in case strictMcpConfig ever stops
  // covering it: the CLI would otherwise spawn those servers at init, unseen by the three read-only layers.
  const projectMcp = projectMcpServerNames(spec.cwd)
  return {
    cwd: spec.cwd,
    ...(spec.model ? { model: spec.model } : {}),
    ...(spec.effort ? { effort: spec.effort as Options['effort'] } : {}),
    systemPrompt: { type: 'preset', preset: 'claude_code', append: withProjectRules(spec.methodology, rules) },
    settingSources: spec.clean ? [] : ['user'],
    permissionMode: 'default',
    canUseTool: makeReviewCanUseTool(),
    hooks: { PreToolUse: [{ hooks: [makeReviewGuardHook()] }] },
    disallowedTools: REVIEW_DISALLOWED_TOOLS,
    settings: { permissions: { deny: REVIEW_DENY_RULES }, disableAllHooks: true, ...(spec.clean ? { autoMemoryEnabled: false } : {}), ...(projectMcp.length ? { disabledMcpjsonServers: projectMcp } : {}) } as Options['settings'],
    mcpServers: {},
    strictMcpConfig: true,
    maxTurns: spec.maxTurns,
    ...(spec.resume ? { resume: spec.resume } : {}),
    persistSession: !!spec.keepTranscript,
    ...(REVIEW_MAX_BUDGET_USD > 0 ? { maxBudgetUsd: REVIEW_MAX_BUDGET_USD } : {}),
    ...(spec.outputSchema ? { outputFormat: { type: 'json_schema', schema: spec.outputSchema } } : {}),
    env,
    ...(bin ? { pathToClaudeCodeExecutable: bin } : {}),
    ...(spec.abort ? { abortController: spec.abort } : {}),
  }
}

const RULE_FILES = ['CLAUDE.md', 'AGENTS.md']
const pexec = promisify(execFile)
const RULE_MAX = 60_000

// The project's instruction files as the base branch has them (or as they sit in cwd when no base branch is known).
export async function projectRules(cwd: string, baseBranch?: string): Promise<Array<{ name: string; text: string }>> {
  const out: Array<{ name: string; text: string }> = []
  for (const name of RULE_FILES) {
    let text = ''
    try {
      text = baseBranch
        ? (await pexec('git', ['-C', cwd, 'show', `origin/${baseBranch}:${name}`], { encoding: 'utf8', timeout: 10_000, maxBuffer: 8 * 1024 * 1024 })).stdout
        : existsSync(join(cwd, name)) ? readFileSync(join(cwd, name), 'utf8') : ''
    } catch { /* not on that branch */ }
    if (text.trim()) out.push({ name, text: text.slice(0, RULE_MAX) })
  }
  return out
}

export function withProjectRules(methodology: string, rules: Array<{ name: string; text: string }>): string {
  if (!rules.length) return methodology
  return `${methodology}\n\n---\n\nProject instructions from the base branch (the PR branch's own CLAUDE.md, AGENTS.md and .claude/ are not loaded):\n\n${rules.map((r) => `## ${r.name}\n\n${r.text.trim()}`).join('\n\n')}`
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
    env: cliEnv(),
    ...(bin ? { pathToClaudeCodeExecutable: bin } : {}),
    ...(spec.abort ? { abortController: spec.abort } : {}),
  }
}

// Configuration probe (agent-config screen): load everything like a session would, never persist, never run a turn.
export function buildProbeOptions(spec: { cwd: string; chrome?: boolean; projectDirName?: string; abort: AbortController }): Options {
  const bin = resolveClaudeExecutable()
  const env = cliEnv()
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
