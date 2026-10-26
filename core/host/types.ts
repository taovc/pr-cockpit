import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { ProviderUsage } from '../runs/types'

// The session host's normalized event stream. Every provider (Claude SDK today, Codex app-server later) maps its
// native messages onto these; the UI, the recorder and the pipelines only ever see RunEvents.
export type RunEvent =
  | { t: 'init'; sessionId: string; model: string; permissionMode: PermissionMode; slashCommands: string[]; skills: string[]; mcpServers: { name: string; status: string }[]; tools: string[]; claudeCodeVersion: string }
  | { t: 'text_delta'; text: string; parent: string | null } // live only, never persisted
  | { t: 'assistant_text'; text: string; uuid: string; parent: string | null }
  | { t: 'thinking'; text: string; parent: string | null }
  | { t: 'tool_use'; id: string; name: string; input: unknown; parent: string | null }
  | { t: 'tool_result'; id: string; output: string; isError: boolean; parent: string | null }
  | { t: 'tool_progress'; id: string; name: string; elapsedSeconds: number; parent: string | null } // live only
  | { t: 'task'; status: 'started' | 'completed' | 'failed' | 'stopped'; taskId: string; summary?: string; description?: string }
  | { t: 'compaction'; trigger: 'manual' | 'auto'; preTokens: number; postTokens?: number }
  | { t: 'context'; totalTokens: number; maxTokens: number; percentage: number }
  | { t: 'permission_request'; promptId: string; kind: PromptKind; toolName: string; input: unknown; title?: string; description?: string; suggestions?: unknown }
  | { t: 'permission_resolved'; promptId: string; status: 'allowed' | 'denied' | 'answered' | 'expired' | 'cancelled' }
  | { t: 'permission_denied'; toolName: string; message: string }
  | { t: 'mode'; permissionMode: PermissionMode }
  | { t: 'status'; status: 'busy' | 'idle' | 'compacting' | 'waiting_prompt' | 'closed' }
  | { t: 'local_command'; content: string }
  | { t: 'reset'; sessionId: string | null } // the CLI cleared the conversation (/clear): new transcript, cost baseline resets
  | { t: 'turn_done'; subtype: string; isError: boolean; resultText: string; costUsd: number | null; durationMs: number; numTurns: number; usage: ProviderUsage | null; userMessageUuid?: string } // userMessageUuid: the send this result answers (absent on the CLI's own meta turns and from older CLIs)
  | { t: 'note'; text: string }
  | { t: 'commands'; commands: Array<{ name: string; description: string; argumentHint: string; aliases?: string[] }> } // the CLI replaced its slash-command list mid-session // provider-side notices that are neither errors nor output (Codex warnings, plan updates, hooks)
  | { t: 'error'; message: string }

export type PromptKind = 'tool' | 'question' | 'plan'

// What the UI sends back for a pending permission_requests row.
export type PromptAnswer =
  | { behavior: 'allow'; always?: boolean; message?: string }
  | { behavior: 'deny'; message?: string }
  | { behavior: 'answer'; answers: Record<string, string | string[]>; message?: string } // AskUserQuestion

export type RunSpec = {
  runId: string
  kind: 'session' | 'probe' | 'review' | 'helper' // review/helper: one-shot unattended kinds (Codex host only; Claude reviews use buildReviewOptions)
  cwd: string
  model?: string
  effort?: string
  resume?: string | null // native claude session id / codex thread id to resume
  fork?: boolean // resume as a FORK: a new native session/thread that starts from the resumed transcript
  permissionMode?: PermissionMode
  allowDanger?: boolean // let dangerous Bash commands run without a prompt (live-read on every call)
  systemAppend?: string
  chrome?: boolean // pass --chrome so the Claude in Chrome MCP connects
  projectDirName?: string // CLAUDE_CODE_PROJECT_DIR_NAME (unifies memory across worktrees)
  // ── Codex-only knobs (ignored by the Claude host) ──
  codexServiceTier?: string | null
  ultracode?: boolean // raise the reasoning effort + prepend the deep-work instructions
  guardScope?: 'fix' | 'feature' | 'global' // post-execution git/GitHub mutation guard for unattended (bypass) turns
  allowNetwork?: boolean // review kind: let gh read PR metadata (writes are still declined before they run)
  outputSchema?: unknown // review kind: JSON Schema constraining the final message
  db?: any
  schema?: any
}

// What every provider host exposes to the pipelines and the /api/runs endpoints. Claude and Codex implement it with
// their own process model; callers pick one with hostFor(provider) / hostOf(runId) (core/host/index.ts).
export interface SessionHost {
  ensure(spec: RunSpec): Promise<unknown>
  send(runId: string, text: string, cb?: TurnCallbacks & { turnId?: string | null }): Promise<TurnResult>
  interrupt(runId: string): Promise<boolean>
  setMode(runId: string, mode: PermissionMode): Promise<boolean>
  setAllowDanger(runId: string, allow: boolean): void
  setModel(runId: string, model?: string | null, effort?: string | null): Promise<boolean> // applied to the live session; false when not live
  rewindFiles(runId: string, userMessageUuid: string, dryRun?: boolean): Promise<{ canRewind: boolean; error?: string; filesChanged?: string[]; insertions?: number; deletions?: number }>
  answerPrompt(runId: string, promptId: string, a: PromptAnswer): boolean
  pendingPrompts(runId: string): Array<{ id: string; kind: PromptKind; toolName: string; input: Record<string, unknown> }>
  status(runId: string): 'busy' | 'waiting_prompt' | 'idle' | 'closed'
  isBusy(runId: string): boolean
  info(runId: string): { sessionId: string | null; init: Extract<RunEvent, { t: 'init' }> | null; permissionMode: PermissionMode | null }
  close(runId: string, reason?: string): Promise<boolean>
  closeAll(): Promise<boolean>
  liveRunIds(): string[]
}

// Live-only conveniences the pipeline wants per turn.
export type TurnCallbacks = {
  onText?: (delta: string) => void
  onTool?: (name: string, info: string) => void
  onSessionId?: (sessionId: string) => void
  onUserUuid?: (uuid: string) => void // the SDK user-message uuid of this turn (rewind anchor; Claude only)
  onEvent?: (e: RunEvent) => void
}

export type TurnResult = { text: string; sessionId: string | null; usage: ProviderUsage | null; costUsd: number | null; subtype: string; isError: boolean; interrupted: boolean
  error?: string // API/runtime error text of a failed turn (the streamed text stays in `text`)
}

export function persistedEvent(e: RunEvent): boolean {
  return e.t !== 'text_delta' && e.t !== 'tool_progress'
}

// Short log line for an event (what the legacy log panel shows).
export function eventMessage(e: RunEvent): string | null {
  switch (e.t) {
    case 'tool_use': {
      const i = (e.input ?? {}) as Record<string, unknown>
      const v = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.description ?? i.prompt ?? ''
      return `${e.name} ${String(v).slice(0, 160)}`
    }
    case 'tool_result': return `↳ ${e.isError ? 'error' : 'ok'} ${e.output.slice(0, 160).replace(/\s+/g, ' ')}`
    case 'permission_request': return `permission? ${e.toolName}`
    case 'permission_resolved': return `permission ${e.status}`
    case 'permission_denied': return `denied ${e.toolName}: ${e.message.slice(0, 120)}`
    case 'compaction': return `compacted ${e.preTokens}→${e.postTokens ?? '?'} tokens (${e.trigger})`
    case 'context': return `context ${e.percentage}% (${e.totalTokens}/${e.maxTokens})`
    case 'task': return `subagent ${e.status}${e.summary ? `: ${e.summary.slice(0, 120)}` : ''}`
    case 'turn_done': return `turn ${e.subtype}${e.costUsd != null ? ` · $${e.costUsd.toFixed(3)}` : ''}`
    case 'error': return e.message
    case 'mode': return `mode ${e.permissionMode}`
    case 'init': return `session ${e.model} · ${e.permissionMode} · ${e.slashCommands.length} commands`
    case 'local_command': return e.content.slice(0, 160)
    case 'reset': return 'conversation cleared'
    case 'note': return e.text.slice(0, 160)
    case 'commands': return `commands updated (${e.commands.length})`
    default: return null
  }
}
