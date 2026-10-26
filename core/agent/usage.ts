import type { ModelUsageSnapshot, ProviderUsage } from '../runs/types'
import { estimateCost, loadCodexRates, type RateTable } from '../runs/pricing'

// Turn the two providers' usage reports into the shared ProviderUsage shape.

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

// Claude Agent SDK / `claude -p` stream-json `result` message.
// - modelUsage (per model, includes subagents and internal calls) is the authoritative token/cost breakdown;
// - usage + total_cost_usd are the fallback when modelUsage is absent (older CLIs).
// Both are cumulative per query() lifetime; every entry point today runs one process per execution, so a
// result is this execution's delta. (The streaming-input host will difference consecutive results itself.)
export function usageFromClaudeResult(msg: any, fallbackModel?: string, cliVersion?: string | null): ProviderUsage | null {
  if (!msg || msg.type !== 'result') return null
  const models: ModelUsageSnapshot[] = []
  const mu = msg.modelUsage
  if (mu && typeof mu === 'object') {
    for (const [model, u] of Object.entries<any>(mu)) {
      models.push({
        model,
        inputTokens: num(u?.inputTokens),
        outputTokens: num(u?.outputTokens),
        cacheReadTokens: num(u?.cacheReadInputTokens),
        cacheCreateTokens: num(u?.cacheCreationInputTokens),
        costUsd: typeof u?.costUSD === 'number' ? u.costUSD : null,
        costSource: typeof u?.costUSD === 'number' ? 'reported' : null,
      })
    }
  } else if (msg.usage && typeof msg.usage === 'object') {
    const u = msg.usage
    models.push({
      model: fallbackModel || 'unknown',
      inputTokens: num(u.input_tokens),
      outputTokens: num(u.output_tokens),
      cacheReadTokens: num(u.cache_read_input_tokens),
      cacheCreateTokens: num(u.cache_creation_input_tokens),
      costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : null,
      costSource: typeof msg.total_cost_usd === 'number' ? 'reported' : null,
    })
  }
  const total = typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : null
  return {
    models,
    costUsd: total,
    costSource: total != null ? 'reported' : null,
    durationMs: num(msg.duration_ms) || undefined,
    numTurns: num(msg.num_turns) || undefined,
    sessionId: typeof msg.session_id === 'string' ? msg.session_id : null,
    ...(cliVersion ? { cliVersion } : {}),
  }
}

// The CLI version announced by the `system/init` message, or null for any other message.
export function claudeCliVersionOf(msg: any): string | null {
  return msg?.type === 'system' && msg.subtype === 'init' && typeof msg.claude_code_version === 'string' ? msg.claude_code_version : null
}

// Why a result message is not an answer, or null when it is. Runs cut short (max turns, retries) are left to the parser.
export function claudeResultFailure(msg: any): string | null {
  if (!msg || msg.type !== 'result') return null
  const text = typeof msg.result === 'string' ? msg.result.trim() : ''
  const errors = Array.isArray(msg.errors) ? msg.errors.join('\n') : ''
  if (msg.terminal_reason === 'api_error' || msg.terminal_reason === 'model_error' || (msg.subtype === 'success' && msg.is_error)) {
    return text || errors || `Claude run failed (${msg.terminal_reason ?? 'error'})`
  }
  if (msg.num_turns === 0) return text || errors || 'Claude run ended without a single turn'
  return null
}

// Codex SDK `turn.completed` usage (tokens only; USD estimated from the local rate table or null).
export function usageFromCodexTurn(
  u: { input_tokens?: number; cached_input_tokens?: number; cache_write_input_tokens?: number; output_tokens?: number; reasoning_output_tokens?: number } | null | undefined,
  model: string | null | undefined,
  o: { threadId?: string | null; durationMs?: number; rates?: RateTable } = {},
): ProviderUsage | null {
  if (!u) return null
  const m = model || 'codex-default'
  const tokens = {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: num(u.cached_input_tokens),
    cacheCreateTokens: num(u.cache_write_input_tokens),
  }
  const cost = estimateCost(m, tokens, o.rates ?? loadCodexRates())
  return {
    models: [{ model: m, ...tokens, costUsd: cost, costSource: cost != null ? 'estimated' : null }],
    costUsd: cost,
    costSource: cost != null ? 'estimated' : null,
    durationMs: o.durationMs,
    numTurns: 1,
    sessionId: o.threadId ?? null,
  }
}

// Sum several executions (e.g. a Codex chat that retried without a thread) into one report.
export function mergeUsage(parts: Array<ProviderUsage | null | undefined>): ProviderUsage | null {
  const list = parts.filter((p): p is ProviderUsage => !!p)
  if (!list.length) return null
  const costs = list.map((p) => p.costUsd).filter((c): c is number => c != null)
  return {
    models: list.flatMap((p) => p.models),
    costUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
    costSource: list.some((p) => p.costSource === 'estimated') ? 'estimated' : costs.length ? 'reported' : null,
    durationMs: list.reduce((a, p) => a + (p.durationMs ?? 0), 0) || undefined,
    numTurns: list.reduce((a, p) => a + (p.numTurns ?? 0), 0) || undefined,
    sessionId: list[list.length - 1]!.sessionId ?? null,
  }
}
