import assert from 'node:assert/strict'
import { normalize, diffCumulativeUsage } from '../core/host/normalize'
import { renameUsageModels, usageFromClaudeResult } from '../core/agent/usage'
import { PushQueue } from '../core/host/queue'
import { eventMessage, persistedEvent } from '../core/host/types'

// SDK message fixtures → RunEvents (pure). Shapes follow @anthropic-ai/claude-agent-sdk sdk.d.ts.
const init = normalize({ type: 'system', subtype: 'init', session_id: 'S1', model: 'claude-sonnet-5', permissionMode: 'default', slash_commands: ['compact', 'grilling'], skills: ['grilling'], mcp_servers: [{ name: 'notion', status: 'connected' }], tools: ['Bash', 'Read'], claude_code_version: '2.1.246' })
assert.equal(init.length, 1)
assert.equal(init[0]!.t, 'init')
assert.deepEqual((init[0] as any).slashCommands, ['compact', 'grilling'])

const asst = normalize({ type: 'assistant', uuid: 'u1', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'hello' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] } })
assert.deepEqual(asst.map((e) => e.t), ['thinking', 'assistant_text', 'tool_use'])
assert.equal((asst[2] as any).name, 'Bash')
assert.equal(eventMessage(asst[2]!), 'Bash ls')

const sub = normalize({ type: 'assistant', uuid: 'u2', parent_tool_use_id: 'tu-parent', message: { content: [{ type: 'text', text: 'from subagent' }] } })
assert.equal((sub[0] as any).parent, 'tu-parent', 'subagent output keeps its parent tool_use id')

const res = normalize({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'file-a\nfile-b' }], is_error: false }] } })
assert.equal(res[0]!.t, 'tool_result')
assert.equal((res[0] as any).output, 'file-a\nfile-b')
assert.equal((res[0] as any).isError, false)

const delta = normalize({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'he' } } })
assert.equal(delta[0]!.t, 'text_delta')
assert.equal(persistedEvent(delta[0]!), false, 'text deltas are live-only')
assert.equal(normalize({ type: 'stream_event', event: { type: 'message_start' } }).length, 0)

const compact = normalize({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 150000, post_tokens: 20000 } })
assert.deepEqual(compact[0], { t: 'compaction', trigger: 'auto', preTokens: 150000, postTokens: 20000 })

const denied = normalize({ type: 'system', subtype: 'permission_denied', tool_name: 'Write', message: 'blocked by rule' })
assert.equal(denied[0]!.t, 'permission_denied')

const done = normalize({ type: 'result', subtype: 'success', is_error: false, result: 'final', total_cost_usd: 0.5, duration_ms: 1200, num_turns: 3, session_id: 'S1', modelUsage: { 'claude-sonnet-5': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.5 } } })
assert.equal(done[0]!.t, 'turn_done')
assert.equal((done[0] as any).resultText, 'final')
assert.equal((done[0] as any).usage.models[0].model, 'claude-sonnet-5')
assert.equal((done[0] as any).userMessageUuid, undefined, 'absent when the CLI does not echo one')
const donePlus = normalize({ type: 'result', subtype: 'success', is_error: false, result: 'final', total_cost_usd: 0.5, duration_ms: 1200, num_turns: 3, session_id: 'S1', user_message_uuid: 'send-1', modelUsage: {} })
assert.equal((donePlus[0] as any).userMessageUuid, 'send-1', 'the send this result answers is carried through')

// Cumulative → per-turn deltas (streaming-input mode reports running totals per query() lifetime)
const t1 = { models: [{ model: 'm', inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, cacheCreateTokens: 0, costUsd: 0.1, costSource: 'reported' as const }], costUsd: 0.1, costSource: 'reported' as const, numTurns: 1, durationMs: 1000 }
const t2 = { models: [{ model: 'm', inputTokens: 250, outputTokens: 40, cacheReadTokens: 5, cacheCreateTokens: 0, costUsd: 0.35, costSource: 'reported' as const }, { model: 'n', inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 0.01, costSource: 'reported' as const }], costUsd: 0.36, costSource: 'reported' as const, numTurns: 2, durationMs: 800 }
const d2 = diffCumulativeUsage(t1, t2)!
assert.ok(Math.abs(d2.costUsd! - 0.26) < 1e-9)
assert.equal(d2.models[0]!.inputTokens, 150)
assert.equal(d2.models[0]!.cacheReadTokens, 0)
assert.equal(d2.models[1]!.inputTokens, 10, 'a model seen for the first time is taken whole')
assert.equal(diffCumulativeUsage(null, t1), t1)
// a reset (new lifetime after /clear) must not go negative
const t3 = { ...t1, costUsd: 0.05, models: [{ ...t1.models[0]!, inputTokens: 20, costUsd: 0.05 }] }
const d3 = diffCumulativeUsage(t2, t3)!
assert.ok(Math.abs(d3.costUsd! - 0.05) < 1e-9)
assert.equal(d3.models[0]!.inputTokens, 20)

// canonicalModel can be absent on one result (e.g. right after a resume) and present on the next: the turn is
// differenced on the raw key, then recorded under the canonical id
const resultOf = (mu: Record<string, any>, cost: number) => normalize({ type: 'result', subtype: 'success', is_error: false, result: '', total_cost_usd: cost, duration_ms: 1, num_turns: 1, session_id: 'S1', modelUsage: mu })[0] as any
const r1 = resultOf({ 'claude-opus-5-5-20261001': { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 1 } }, 1)
const r2 = resultOf({ 'claude-opus-5-5-20261001': { inputTokens: 1200, outputTokens: 130, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 1.3, canonicalModel: 'claude-opus-5-5' } }, 1.3)
assert.equal(r1.modelNames, undefined)
assert.deepEqual(r2.modelNames, { 'claude-opus-5-5-20261001': 'claude-opus-5-5' })
const turn2 = renameUsageModels(diffCumulativeUsage(r1.usage, r2.usage), r2.modelNames ?? {})!
assert.equal(turn2.models.length, 1)
assert.equal(turn2.models[0]!.model, 'claude-opus-5-5')
assert.equal(turn2.models[0]!.inputTokens, 200, 'only this turn, not the whole lifetime again')
assert.ok(Math.abs(turn2.models[0]!.costUsd! - 0.3) < 1e-9)
const merged = renameUsageModels({ models: [{ ...t1.models[0]!, model: 'a' }, { ...t1.models[0]!, model: 'b' }], costUsd: 0.2, costSource: 'reported' }, { a: 'c', b: 'c' })!
assert.equal(merged.models.length, 1)
assert.equal(merged.models[0]!.inputTokens, 200)
assert.ok(Math.abs(merged.models[0]!.costUsd! - 0.2) < 1e-9)
// a one-shot run (the review family) still records the canonical id directly
assert.equal(usageFromClaudeResult({ type: 'result', modelUsage: { 'x[1m]': { inputTokens: 1, canonicalModel: 'claude-x' } } })!.models[0]!.model, 'claude-x')

// PushQueue: push before and after a waiting consumer; close ends iteration
const q = new PushQueue<number>()
q.push(1)
const it = q[Symbol.asyncIterator]()
assert.deepEqual(await it.next(), { value: 1, done: false })
const pending = it.next()
q.push(2)
assert.deepEqual(await pending, { value: 2, done: false })
q.close()
assert.equal((await it.next()).done, true)
console.log('host-normalize: all ok')
