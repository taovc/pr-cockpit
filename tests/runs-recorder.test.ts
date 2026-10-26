import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { getDb, schema } from '../core/db/client'
import { createRun, ensureSessionRun, finishRun, recordRunUsage } from '../core/runs/store'
import { usageFromClaudeResult, usageFromCodexTurn, mergeUsage } from '../core/agent/usage'
import { estimateCost, findRate } from '../core/runs/pricing'

// In-memory run record round-trip: SDK result → ProviderUsage → runs / run_usage rows.
const d = getDb(':memory:')

// ── Claude result with per-model breakdown (main model + a subagent model) ──
const claudeResult = {
  type: 'result', subtype: 'success', session_id: 'sess-1', duration_ms: 4200, num_turns: 7, total_cost_usd: 0.42,
  modelUsage: {
    'claude-opus-5': { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 500, cacheCreationInputTokens: 50, costUSD: 0.4 },
    'claude-haiku-4-5': { inputTokens: 300, outputTokens: 40, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.02 },
  },
}
const u1 = usageFromClaudeResult(claudeResult)!
assert.equal(u1.models.length, 2)
assert.equal(u1.costUsd, 0.42)
assert.equal(u1.costSource, 'reported')
assert.equal(u1.sessionId, 'sess-1')
assert.equal(u1.durationMs, 4200)

const runId = createRun(d, schema, { kind: 'review', subkind: 'review', provider: 'claude', projectId: 'P', reviewId: 'R', model: 'opus', effort: 'high' })
recordRunUsage(d, schema, runId, u1)
let row = d.select().from(schema.runs).where(eq(schema.runs.id, runId)).get()!
assert.equal(row.inputTokens, 1300)
assert.equal(row.outputTokens, 240)
assert.equal(row.cacheReadTokens, 500)
assert.equal(row.cacheCreateTokens, 50)
assert.equal(row.numTurns, 7)
assert.equal(row.durationMs, 4200)
assert.ok(Math.abs((row.costUsd ?? 0) - 0.42) < 1e-9)
assert.equal(row.costSource, 'reported')
assert.equal(row.claudeSessionId, 'sess-1')
assert.equal(row.cliVersion, null, 'no version reported, none recorded')
recordRunUsage(d, schema, runId, { models: [], costUsd: null, costSource: null, cliVersion: '2.1.310' })
row = d.select().from(schema.runs).where(eq(schema.runs.id, runId)).get()!
assert.equal(row.cliVersion, '2.1.310', 'the CLI version lands on the run')
const usageRows = d.select().from(schema.runUsage).where(eq(schema.runUsage.runId, runId)).all()
assert.equal(usageRows.length, 2)
finishRun(d, schema, runId, { status: 'done' })
row = d.select().from(schema.runs).where(eq(schema.runs.id, runId)).get()!
assert.equal(row.status, 'done')
assert.ok(row.endedAt)
console.log('runs-recorder claude: ok')

// ── Fallback when modelUsage is absent (older CLI): usage + total_cost_usd, model from the caller ──
const legacy = usageFromClaudeResult({ type: 'result', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 }, total_cost_usd: 0.001 }, 'sonnet')!
assert.equal(legacy.models[0]!.model, 'sonnet')
assert.equal(legacy.models[0]!.inputTokens, 10)
assert.equal(legacy.costUsd, 0.001)
assert.equal(usageFromClaudeResult({ type: 'assistant' }), null)

// ── Codex: tokens only; USD estimated from a rate table or null — never 0 ──
const table = { asOf: '2026-08-01', rates: { 'gpt-5': { input: 1, cachedInput: 0.1, output: 10 }, 'gpt-5-codex': { input: 2, cachedInput: 0.2, output: 20 } } }
assert.equal(findRate('gpt-5-codex-mini', table)?.input, 2, 'longest prefix wins')
assert.equal(findRate('gpt-5', table)?.input, 1)
assert.equal(findRate('o3', table), null)
// 1000 in (of which 400 cached), 100 out at gpt-5 rates: (600*1 + 400*0.1 + 100*10) / 1e6
assert.ok(Math.abs(estimateCost('gpt-5', { inputTokens: 1000, cacheReadTokens: 400, outputTokens: 100 }, table)! - 0.00164) < 1e-12)
const codexTurn = { input_tokens: 1000, cached_input_tokens: 400, cache_write_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 30 }
const priced = usageFromCodexTurn(codexTurn, 'gpt-5', { threadId: 'thr-1', rates: table })!
assert.equal(priced.costSource, 'estimated')
assert.ok(priced.costUsd! > 0)
const unpriced = usageFromCodexTurn(codexTurn, 'o3-unknown', { rates: { asOf: null, rates: {} } })!
assert.equal(unpriced.costUsd, null, 'unknown model → null cost, not 0')
assert.equal(unpriced.models[0]!.inputTokens, 1000)

// ── Session runs: idempotent ensure + per-turn usage accumulation; unpriced turns leave the cost null ──
ensureSessionRun(d, schema, { id: 'FX1', kind: 'session', subkind: 'session', provider: 'codex', projectId: 'P', workspaceType: 'pr_worktree', prNumber: 7, model: 'o3-unknown' })
ensureSessionRun(d, schema, { id: 'FX1', kind: 'session', subkind: 'session', provider: 'codex', projectId: 'P', workspaceType: 'pr_worktree', prNumber: 7, model: 'o3-unknown' })
assert.equal(d.select().from(schema.runs).where(eq(schema.runs.id, 'FX1')).all().length, 1, 'ensureSessionRun is idempotent')
recordRunUsage(d, schema, 'FX1', unpriced, 'turn-a')
recordRunUsage(d, schema, 'FX1', unpriced, 'turn-b')
row = d.select().from(schema.runs).where(eq(schema.runs.id, 'FX1')).get()!
assert.equal(row.inputTokens, 2000)
assert.equal(row.costUsd, null, 'two unpriced turns → cost stays unknown')
assert.equal(row.codexThreadId, null)
recordRunUsage(d, schema, 'FX1', priced, 'turn-c')
row = d.select().from(schema.runs).where(eq(schema.runs.id, 'FX1')).get()!
assert.equal(row.costSource, 'estimated')
assert.equal(row.codexThreadId, 'thr-1')
assert.equal(row.numTurns, 3)
finishRun(d, schema, 'FX1', { status: 'idle' })
assert.equal(d.select().from(schema.runs).where(eq(schema.runs.id, 'FX1')).get()!.status, 'idle')

// ── mergeUsage: estimated + reported → estimated overall; null costs ignored ──
const merged = mergeUsage([priced, unpriced, u1])!
assert.equal(merged.costSource, 'estimated')
assert.ok(Math.abs(merged.costUsd! - (priced.costUsd! + 0.42)) < 1e-12)
assert.equal(merged.models.length, 4)

// ── recording never throws on a missing run ──
recordRunUsage(d, schema, 'does-not-exist', u1)
console.log('runs-recorder: all ok')
