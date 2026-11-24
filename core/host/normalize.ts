import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { claudeCanonicalModels, usageFromClaudeResult } from '../agent/usage'
import type { ProviderUsage, ModelUsageSnapshot } from '../runs/types'
import type { RunEvent } from './types'

// Pure: one SDK message → zero or more RunEvents. No IO, fully unit-testable on fixtures.
export function normalize(msg: SDKMessage | any): RunEvent[] {
  if (!msg || typeof msg !== 'object') return []
  const out: RunEvent[] = []
  switch (msg.type) {
    case 'system': {
      if (msg.subtype === 'init') {
        out.push({
          t: 'init', sessionId: String(msg.session_id ?? ''), model: String(msg.model ?? ''), permissionMode: msg.permissionMode ?? 'default',
          slashCommands: Array.isArray(msg.slash_commands) ? msg.slash_commands : [], skills: Array.isArray(msg.skills) ? msg.skills : [],
          mcpServers: Array.isArray(msg.mcp_servers) ? msg.mcp_servers : [], tools: Array.isArray(msg.tools) ? msg.tools : [], claudeCodeVersion: String(msg.claude_code_version ?? ''),
        })
      } else if (msg.subtype === 'compact_boundary') {
        const m = msg.compact_metadata ?? {}
        out.push({ t: 'compaction', trigger: m.trigger === 'manual' ? 'manual' : 'auto', preTokens: Number(m.pre_tokens ?? 0), postTokens: typeof m.post_tokens === 'number' ? m.post_tokens : undefined })
      } else if (msg.subtype === 'status') {
        if (msg.status === 'compacting') out.push({ t: 'status', status: 'compacting' })
        if (msg.permissionMode) out.push({ t: 'mode', permissionMode: msg.permissionMode })
      } else if (msg.subtype === 'permission_denied') {
        out.push({ t: 'permission_denied', toolName: String(msg.tool_name ?? ''), message: String(msg.message ?? msg.decision_reason ?? '') })
      } else if (msg.subtype === 'task_notification') {
        out.push({ t: 'task', status: msg.status ?? 'completed', taskId: String(msg.task_id ?? ''), summary: msg.summary })
      } else if (msg.subtype === 'task_started') {
        out.push({ t: 'task', status: 'started', taskId: String(msg.task_id ?? ''), description: msg.description })
      } else if (msg.subtype === 'commands_changed') {
        out.push({ t: 'commands', commands: (Array.isArray(msg.commands) ? msg.commands : []).map((c: any) => ({ name: String(c.name ?? ''), description: String(c.description ?? ''), argumentHint: String(c.argumentHint ?? ''), aliases: Array.isArray(c.aliases) ? c.aliases : [] })) })
      } else if (msg.subtype === 'local_command_output') {
        out.push({ t: 'local_command', content: String(msg.content ?? '') })
      }
      break
    }
    case 'assistant': {
      const content = msg.message?.content
      const parent = msg.parent_tool_use_id ?? null
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === 'text' && b.text) out.push({ t: 'assistant_text', text: String(b.text), uuid: String(msg.uuid ?? ''), parent })
          else if (b?.type === 'thinking' && b.thinking) out.push({ t: 'thinking', text: String(b.thinking), parent })
          else if (b?.type === 'tool_use') out.push({ t: 'tool_use', id: String(b.id ?? ''), name: String(b.name ?? ''), input: b.input ?? {}, parent })
        }
      } else if (typeof content === 'string' && content) {
        out.push({ t: 'assistant_text', text: content, uuid: String(msg.uuid ?? ''), parent })
      }
      break
    }
    case 'user': {
      const content = msg.message?.content
      const parent = msg.parent_tool_use_id ?? null
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === 'tool_result') {
            out.push({ t: 'tool_result', id: String(b.tool_use_id ?? ''), output: toolResultText(b.content), isError: !!b.is_error, parent })
          }
        }
      }
      break
    }
    case 'stream_event': {
      const ev = msg.event
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
        out.push({ t: 'text_delta', text: String(ev.delta.text), parent: msg.parent_tool_use_id ?? null })
      }
      break
    }
    case 'conversation_reset': {
      out.push({ t: 'reset', sessionId: typeof msg.new_conversation_id === 'string' ? msg.new_conversation_id : typeof msg.session_id === 'string' ? msg.session_id : null })
      break
    }
    case 'tool_progress': {
      out.push({ t: 'tool_progress', id: String(msg.tool_use_id ?? ''), name: String(msg.tool_name ?? ''), elapsedSeconds: Number(msg.elapsed_time_seconds ?? 0), parent: msg.parent_tool_use_id ?? null })
      break
    }
    case 'result': {
      const usage = usageFromClaudeResult(msg, undefined, undefined, { rawKeys: true })
      const modelNames = claudeCanonicalModels(msg)
      out.push({
        t: 'turn_done', subtype: String(msg.subtype ?? 'success'), isError: !!msg.is_error, resultText: typeof msg.result === 'string' ? msg.result : (Array.isArray(msg.errors) ? msg.errors.map(String).join('\n') : ''),
        costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : null, durationMs: Number(msg.duration_ms ?? 0), numTurns: Number(msg.num_turns ?? 0), usage,
        ...(typeof msg.user_message_uuid === 'string' && msg.user_message_uuid ? { userMessageUuid: msg.user_message_uuid } : {}),
        ...(Object.keys(modelNames).length ? { modelNames } : {}),
      })
      break
    }
    default:
      break
  }
  return out
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((c: any) => (c?.type === 'text' ? String(c.text ?? '') : c?.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n')
  }
  if (content == null) return ''
  try { return JSON.stringify(content) } catch { return String(content) }
}

// In streaming-input mode the result's cost/usage are cumulative over the query() lifetime. Given the previous
// cumulative snapshot, return this turn's delta (null-safe; a reset to lower numbers = a new lifetime → take next as-is).
export function diffCumulativeUsage(prev: ProviderUsage | null, next: ProviderUsage | null): ProviderUsage | null {
  if (!next) return null
  if (!prev) return next
  const prevByModel = new Map(prev.models.map((m) => [m.model, m]))
  const models: ModelUsageSnapshot[] = next.models.map((m) => {
    const p = prevByModel.get(m.model)
    if (!p) return m
    const d = (a: number, b: number) => (a - b < 0 ? a : a - b)
    return {
      model: m.model,
      inputTokens: d(m.inputTokens, p.inputTokens), outputTokens: d(m.outputTokens, p.outputTokens),
      cacheReadTokens: d(m.cacheReadTokens, p.cacheReadTokens), cacheCreateTokens: d(m.cacheCreateTokens, p.cacheCreateTokens),
      costUsd: m.costUsd != null && p.costUsd != null ? (m.costUsd - p.costUsd < 0 ? m.costUsd : m.costUsd - p.costUsd) : m.costUsd,
      costSource: m.costSource,
    }
  })
  const cost = next.costUsd != null && prev.costUsd != null ? (next.costUsd - prev.costUsd < 0 ? next.costUsd : next.costUsd - prev.costUsd) : next.costUsd
  return { ...next, models, costUsd: cost, numTurns: next.numTurns, durationMs: next.durationMs }
}
