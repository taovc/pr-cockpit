#!/usr/bin/env node
// Scripted stand-in for `codex app-server` (JSON-RPC over stdio) for tests/codex-host.test.ts. The turn text drives
// the scenario: "run-command <cmd>" (approval round trip unless approvalPolicy is never), "mcp-call <server> <tool> [json]"
// (an MCP tool call item, no approval), "ask-question"
// (requestUserInput), "slow" (waits for turn/interrupt), "fail" (failed turn), "crash" (process dies mid-turn),
// anything else = a commentary message followed by a final answer.
import { createInterface } from 'node:readline'

const out = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const notify = (method, params) => out({ jsonrpc: '2.0', method, params })
let reqId = 0
const pendingServerReqs = new Map()
function serverRequest(method, params) {
  const id = reqId++
  const promise = new Promise((resolve) => pendingServerReqs.set(id, resolve))
  out({ jsonrpc: '2.0', id, method, params })
  return { id, promise }
}
let threadN = 0
let turnN = 0
let itemN = 0
let flakyLeft = null
const threads = new Map()
let usageTotal = { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function bumpUsage(threadId, turnId, inTok, outTok) {
  const last = { totalTokens: inTok + outTok, inputTokens: inTok, cachedInputTokens: Math.floor(inTok / 2), cacheWriteInputTokens: 0, outputTokens: outTok, reasoningOutputTokens: 0 }
  usageTotal = { totalTokens: usageTotal.totalTokens + last.totalTokens, inputTokens: usageTotal.inputTokens + inTok, cachedInputTokens: usageTotal.cachedInputTokens + last.cachedInputTokens, cacheWriteInputTokens: 0, outputTokens: usageTotal.outputTokens + outTok, reasoningOutputTokens: 0 }
  notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: usageTotal, last, modelContextWindow: 200000 } })
}

async function runTurn(threadId, turnId, text, params) {
  const th = threads.get(threadId)
  notify('turn/started', { threadId, turn: { id: turnId, items: [], itemsView: 'notLoaded', status: 'inProgress', error: null } })
  const say = (t, phase) => {
    const id = `msg-${++itemN}`
    notify('item/started', { threadId, turnId, item: { type: 'agentMessage', id, text: '', phase } })
    for (const ch of t.match(/.{1,3}/gs) ?? []) notify('item/agentMessage/delta', { threadId, turnId, itemId: id, delta: ch })
    notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id, text: t, phase } })
  }
  let status = 'completed'
  let error = null
  const cmd = /run-command (.+)$/m.exec(text)
  const mcp = /mcp-call (\S+) (\S+)(?: (.+))?$/m.exec(text)
  if (/crash/.test(text)) { await sleep(50); process.exit(3) }
  if (/slow/.test(text)) {
    for (let i = 0; i < 200 && !th.interrupted; i++) await sleep(25)
    status = th.interrupted ? 'interrupted' : 'completed'
  } else if (cmd) {
    const command = cmd[1].trim()
    const id = `cmd-${++itemN}`
    notify('item/started', { threadId, turnId, item: { type: 'commandExecution', id, command, cwd: th.cwd, status: 'inProgress' } })
    let decision = 'accept'
    if (params.approvalPolicy !== 'never') {
      const { id: rid, promise } = serverRequest('item/commandExecution/requestApproval', { threadId, turnId, itemId: id, startedAtMs: Date.now(), command, cwd: th.cwd, reason: null, proposedExecpolicyAmendment: ['git', 'status'] })
      const r = await promise
      decision = typeof r?.decision === 'string' ? r.decision : Object.keys(r?.decision ?? {})[0] ?? 'decline'
      notify('serverRequest/resolved', { threadId, requestId: rid })
    }
    const declined = decision === 'decline' || decision === 'cancel' || decision === 'denied'
    if (!declined) notify('item/commandExecution/outputDelta', { threadId, turnId, itemId: id, delta: 'ok\n' })
    notify('item/completed', { threadId, turnId, item: { type: 'commandExecution', id, command, cwd: th.cwd, status: declined ? 'declined' : 'completed', aggregatedOutput: declined ? null : 'ok\n', exitCode: declined ? null : 0 } })
    await sleep(30)
    if (th.interrupted) status = 'interrupted'
    else say(`ran: ${decision}`, 'final_answer')
  } else if (mcp) {
    const id = `mcp-${++itemN}`
    const item = { type: 'mcpToolCall', id, server: mcp[1], tool: mcp[2], arguments: mcp[3] ? JSON.parse(mcp[3]) : {} }
    notify('item/started', { threadId, turnId, item: { ...item, status: 'inProgress' } })
    await sleep(30)
    notify('item/completed', { threadId, turnId, item: { ...item, status: 'completed', result: { content: [] } } })
    await sleep(30)
    if (th.interrupted) status = 'interrupted'
    else say('mcp done', 'final_answer')
  } else if (/ask-question/.test(text)) {
    const { id: rid, promise } = serverRequest('item/tool/requestUserInput', { threadId, turnId, itemId: `q-${++itemN}`, questions: [{ id: 'q1', header: 'Colour', question: 'Favourite colour?', isOther: false, isSecret: false, options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }] }], isBlocking: true, autoResolutionMs: null })
    const r = await promise
    notify('serverRequest/resolved', { threadId, requestId: rid })
    say(`you said ${(r?.answers?.q1?.answers ?? []).join(',') || 'nothing'}`, 'final_answer')
  } else if (/fail/.test(text)) {
    status = 'failed'
    error = { message: 'mock failure', codexErrorInfo: 'other', additionalDetails: null }
  } else {
    say('thinking aloud', 'commentary')
    say(params.outputSchema ? '{"ok":true}' : 'hello', 'final_answer')
  }
  bumpUsage(threadId, turnId, 100, 20)
  notify('thread/status/changed', { threadId, status: { type: 'idle' } })
  notify('turn/completed', { threadId, turn: { id: turnId, items: [], itemsView: 'summary', status, error } })
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  const m = JSON.parse(line)
  if (m.id != null && m.method === undefined) {
    const r = pendingServerReqs.get(m.id)
    if (r) { pendingServerReqs.delete(m.id); r(m.error ? null : m.result) }
    return
  }
  if (!m.method) return
  const reply = (result) => { if (m.id != null) out({ jsonrpc: '2.0', id: m.id, result }) }
  const fail = (code, message) => out({ jsonrpc: '2.0', id: m.id, error: { code, message } })
  const p = m.params ?? {}
  switch (m.method) {
    case 'initialize': return reply({ userAgent: 'mock/9.9.9 (test)', codexHome: '/tmp/mock-codex', platformFamily: 'unix', platformOs: 'test' })
    case 'initialized': return
    case 'getAuthStatus': return reply({ authMethod: 'chatgpt', authToken: null, requiresOpenaiAuth: true })
    case 'model/list': return reply({ data: [{ id: 'mock-1', model: 'mock-1', hidden: false, displayName: 'Mock 1', description: '', defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'ultra' }] }], nextCursor: null })
    case 'thread/start': {
      const id = `t-${++threadN}`
      threads.set(id, { cwd: p.cwd, approvalPolicy: p.approvalPolicy, model: p.model ?? 'mock-1', interrupted: false, instructions: p.developerInstructions ?? '' })
      reply({ thread: { id, sessionId: id, ephemeral: !!p.ephemeral, cwd: p.cwd }, model: p.model ?? 'mock-1' })
      return notify('thread/started', { thread: { id } })
    }
    case 'thread/resume': {
      if (String(p.threadId).startsWith('stale')) return fail(-32000, `no rollout found for thread ${p.threadId}`)
      const id = p.threadId
      threads.set(id, { cwd: p.cwd, approvalPolicy: p.approvalPolicy, model: p.model ?? 'mock-1', interrupted: false })
      return reply({ thread: { id, sessionId: id, cwd: p.cwd }, model: p.model ?? 'mock-1' })
    }
    case 'turn/start': {
      const th = threads.get(p.threadId)
      if (!th) return fail(-32602, 'unknown thread')
      th.interrupted = false
      const turnId = `turn-${++turnN}`
      reply({ turn: { id: turnId, status: 'inProgress' } })
      const text = (p.input ?? []).map((i) => i.text ?? '').join('\n')
      void runTurn(p.threadId, turnId, text, p)
      return
    }
    case 'turn/interrupt': { const th = threads.get(p.threadId); if (th) th.interrupted = true; return reply({}) }
    case 'thread/compact/start': reply({}); return notify('thread/compacted', { threadId: p.threadId, turnId: null })
    case 'flaky': { flakyLeft = flakyLeft ?? Number(p.failures ?? 2); if (flakyLeft > 0) { flakyLeft--; return fail(-32001, 'overloaded') } flakyLeft = null; return reply({ ok: true, attempts: Number(p.failures ?? 2) + 1 }) }
    case 'echo': return reply({ echo: p })
    case 'bad': return fail(-32000, 'bad request')
    case 'skills/list': return reply({ data: [{ cwd: p.cwds?.[0] ?? '', skills: [{ name: 'mock-skill', description: '', path: '/tmp/mock-skill', scope: 'user', enabled: true }], errors: [] }] })
    case 'config/read': return reply({ config: { model: 'mock-1', approval_policy: 'on-request', sandbox_mode: 'workspace-write' }, origins: { model: { layer: { type: 'user' } } }, layers: null })
    case 'mcpServerStatus/list': return reply({ data: [{ name: 'mock-mcp', authStatus: 'unsupported', tools: { a: {} } }], nextCursor: null })
    default: return m.id != null ? fail(-32601, `unknown method ${m.method}`) : undefined
  }
})
process.stdin.on('end', () => process.exit(0))
