// Shared shapes for agent-run observability (phase 0 of the session-host rework).
// A "run" is one agent execution we can attribute cost / tokens / model / skill version to.

export type RunKind = 'review' | 'session'
export type RunSubkind = 'review' | 'guided' | 'recheck' | 'skillgen' | 'session' | 'helper' | 'eval' | 'verify' | ReviewStage
// The scope-review pipeline's stages. Their rows only break a review down; the review's own row carries the total.
export const REVIEW_STAGES = ['engine', 'context', 'check', 'tier'] as const
export type ReviewStage = (typeof REVIEW_STAGES)[number]
export const STAGE_SUBKINDS_SQL = `(${REVIEW_STAGES.map((s) => `'${s}'`).join(', ')})`
export type RunStatus = 'queued' | 'running' | 'awaiting_input' | 'idle' | 'stopped' | 'done' | 'error'
export type CostSource = 'reported' | 'estimated'

// Token usage for one model inside one result / turn. `costUsd: null` means unknown — never store 0 as a placeholder.
export type ModelUsageSnapshot = {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreateTokens: number
  costUsd: number | null
  costSource: CostSource | null
}

// What a provider runner hands back after one execution (one query() / one Codex turn).
export type ProviderUsage = {
  models: ModelUsageSnapshot[]
  costUsd: number | null // total for this execution (Claude: total_cost_usd incl. subagents; Codex: estimated from a rate table or null)
  costSource: CostSource | null
  durationMs?: number
  numTurns?: number
  sessionId?: string | null // native session / thread id observed on the stream
  cliVersion?: string | null // Claude Code CLI version that ran it (from system/init)
}

export function emptyUsage(): ProviderUsage {
  return { models: [], costUsd: null, costSource: null }
}
