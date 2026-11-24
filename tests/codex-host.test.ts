import assert from 'node:assert/strict'
import { resolve } from 'node:path'

// The Codex host against the scripted mock app-server (tests/helpers/mockCodexAppServer.mjs): turns, approvals through
// the shared permission bridge, the read-only auto-decider, user-input questions, interrupt, the post-execution git
// guard, stale-thread fallback and a mid-turn crash with respawn.
process.env.CODEX_EXECUTABLE = resolve('tests/helpers/mockCodexAppServer.mjs')

const { codexHost } = await import('../core/codex/codexHost')
const { runCodexReadonly } = await import('../core/codex/oneshot')
const { codexServerInfo, stopCodexServer } = await import('../core/codex/appServer')
const { CodexEventMapper } = await import('../core/codex/mapEvents')
const { sessionPolicy, reviewPolicy } = await import('../core/codex/policy')
type RunEvent = import('../core/host/types').RunEvent

const cwd = process.cwd()
const collect = () => { const events: RunEvent[] = []; return { events, onEvent: (e: RunEvent) => { events.push(e) } } }

try {
  // 1. plain turn: commentary + final answer, usage delta, thread id surfaces as the session id
  await codexHost.ensure({ runId: 's1', kind: 'session', cwd, permissionMode: 'default' })
  assert.equal(codexHost.status('s1'), 'idle')
  const c1 = collect()
  let streamed = ''
  const r1 = await codexHost.send('s1', 'say hello', { onEvent: c1.onEvent, onText: (t) => { streamed += t } })
  assert.equal(r1.isError, false)
  assert.equal(r1.text, 'thinking aloud\n\nhello')
  assert.equal(streamed, 'thinking aloudhello')
  assert.equal(r1.sessionId, 't-1')
  assert.equal(r1.usage?.models[0]?.inputTokens, 100)
  assert.equal(r1.usage?.models[0]?.outputTokens, 20)
  assert.equal(r1.usage?.costUsd, null) // no rate table in tests → unknown, never 0
  assert.ok(c1.events.some((e) => e.t === 'turn_done'))
  assert.ok(c1.events.some((e) => e.t === 'context'))

  // 2. approval round trip through the permission bridge (default mode → on-request)
  const c2 = collect()
  const p2 = codexHost.send('s1', 'run-command git status', { onEvent: c2.onEvent })
  await waitFor(() => codexHost.pendingPrompts('s1').length === 1)
  const pending = codexHost.pendingPrompts('s1')[0]!
  assert.equal(pending.kind, 'tool')
  assert.equal(pending.toolName, 'Bash')
  assert.equal(pending.input.command, 'git status')
  assert.equal(codexHost.status('s1'), 'waiting_prompt')
  assert.ok(codexHost.answerPrompt('s1', pending.id, { behavior: 'allow', always: true }))
  const r2 = await p2
  assert.equal(r2.text, 'ran: acceptWithExecpolicyAmendment') // "always" + a proposed amendment → execpolicy amendment
  assert.ok(c2.events.some((e) => e.t === 'tool_use' && e.name === 'Bash'))
  assert.ok(c2.events.some((e) => e.t === 'tool_result' && !e.isError))
  assert.ok(c2.events.some((e) => e.t === 'permission_resolved' && e.status === 'allowed'))

  // 3. deny
  const p3 = codexHost.send('s1', 'run-command rm -rf /')
  await waitFor(() => codexHost.pendingPrompts('s1').length === 1)
  codexHost.answerPrompt('s1', codexHost.pendingPrompts('s1')[0]!.id, { behavior: 'deny' })
  const r3 = await p3
  assert.equal(r3.text, 'ran: decline')

  // 4. user-input question → AskUserQuestion-shaped card, answered by question text
  const p4 = codexHost.send('s1', 'ask-question')
  await waitFor(() => codexHost.pendingPrompts('s1').length === 1)
  const q = codexHost.pendingPrompts('s1')[0]!
  assert.equal(q.kind, 'question')
  const questions = q.input.questions as Array<{ question: string; options: Array<{ label: string }> }>
  assert.equal(questions[0]!.question, 'Favourite colour?')
  assert.deepEqual(questions[0]!.options.map((o) => o.label), ['Red', 'Blue'])
  codexHost.answerPrompt('s1', q.id, { behavior: 'answer', answers: { 'Favourite colour?': 'Blue' } })
  const r4 = await p4
  assert.equal(r4.text, 'you said Blue')

  // 5. interrupt
  const p5 = codexHost.send('s1', 'slow')
  await new Promise((r) => setTimeout(r, 80))
  assert.ok(await codexHost.interrupt('s1'))
  const r5 = await p5
  assert.equal(r5.interrupted, true)
  assert.equal(r5.isError, false)

  // 6. failed turn
  const r6 = await codexHost.send('s1', 'fail')
  assert.equal(r6.isError, true)
  assert.match(r6.error || '', /mock failure/)

  // 7. bypass mode + guard scope: no approvals, but a git mutation is caught after execution and the turn errors
  await codexHost.ensure({ runId: 's1', kind: 'session', cwd, permissionMode: 'bypassPermissions', guardScope: 'fix' })
  const c7 = collect()
  const r7 = await codexHost.send('s1', 'run-command git commit -m x', { onEvent: c7.onEvent })
  assert.equal(r7.isError, true)
  assert.equal(r7.interrupted, false)
  assert.match(r7.error || '', /forbidden git\/GitHub mutation/)
  assert.ok(c7.events.some((e) => e.t === 'permission_denied'))
  // …and the same command with the danger switch on is left alone
  codexHost.setAllowDanger('s1', true)
  const r7b = await codexHost.send('s1', 'run-command git commit -m x')
  assert.equal(r7b.isError, false)
  assert.equal(r7b.text, 'ran: accept')
  // …but approving or merging a PR from a worktree session is caught even with the danger switch on
  const r7c = await codexHost.send('s1', 'run-command gh pr merge 1 --squash')
  assert.equal(r7c.isError, true)
  // with approvals on, the merge is declined before it runs, without a card
  codexHost.setAllowDanger('s1', false)
  await codexHost.ensure({ runId: 's1', kind: 'session', cwd, permissionMode: 'default', guardScope: 'feature' })
  const c7d = collect()
  const r7d = await codexHost.send('s1', 'run-command gh pr review 1 --approve', { onEvent: c7d.onEvent })
  assert.equal(r7d.text, 'ran: decline')
  assert.equal(codexHost.pendingPrompts('s1').length, 0)
  assert.ok(c7d.events.some((e) => e.t === 'permission_denied' && /done by the human in PR Cockpit/.test(e.message)))

  // 8. review one-shot: every command is decided before it runs — git status accepted, git push declined
  const tools: string[] = []
  const rv1 = await runCodexReadonly({ prompt: 'run-command git status', cwd, label: 'review', outputSchema: { type: 'object' }, onTool: (n, i) => tools.push(`${n} ${i}`) })
  assert.equal(rv1.raw, 'ran: accept')
  const rv2 = await runCodexReadonly({ prompt: 'run-command git push origin main', cwd, label: 'review', onTool: (n, i) => tools.push(`${n} ${i}`) })
  assert.equal(rv2.raw, 'ran: decline')
  assert.ok(tools.some((t) => t.startsWith('CodexBlocked')))
  const rv3 = await runCodexReadonly({ prompt: 'plain', cwd, label: 'review', outputSchema: { type: 'object' } })
  assert.equal(rv3.raw, '{"ok":true}') // only the final answer, never the commentary
  assert.equal(codexHost.liveRunIds().length, 1) // one-shot threads are closed afterwards

  // 9. stale thread id → fresh thread + a note
  const c9 = collect()
  await codexHost.ensure({ runId: 's9', kind: 'session', cwd, resume: 'stale-123' })
  const r9 = await codexHost.send('s9', 'hi', { onEvent: c9.onEvent })
  assert.equal(r9.isError, false)
  assert.notEqual(r9.sessionId, 'stale-123')
  const info9 = codexHost.info('s9')
  assert.ok(info9.sessionId && info9.sessionId.startsWith('t-'))

  // 10. crash mid-turn: the turn fails, the process respawns on the next ensure
  const pidBefore = codexServerInfo().pid
  const r10 = await codexHost.send('s9', 'crash')
  assert.equal(r10.isError, true)
  assert.match(r10.error || '', /exited/)
  assert.equal(codexHost.status('s9'), 'closed')
  await codexHost.ensure({ runId: 's11', kind: 'session', cwd })
  assert.notEqual(codexServerInfo().pid, pidBefore)
  const r11 = await codexHost.send('s11', 'hello again')
  assert.equal(r11.text, 'thinking aloud\n\nhello')

  // policy matrix (pure)
  assert.equal(sessionPolicy({ cwd, permissionMode: 'plan' }).sandbox.type, 'readOnly')
  assert.equal(sessionPolicy({ cwd, permissionMode: 'bypassPermissions' }).approval, 'never')
  assert.equal(sessionPolicy({ cwd, permissionMode: 'default', allowDanger: true }).sandbox.type, 'dangerFullAccess')
  const rp = reviewPolicy({ allowNetwork: true })
  assert.equal(rp.autoDecide!('gh pr view 1'), 'accept')
  assert.equal(rp.autoDecide!('gh pr comment 1 --body x'), 'decline')
  assert.equal(rp.autoDecide!('gh api repos/o/r/issues --method POST'), 'decline')

  // mapper (pure): a resumed message with no deltas still yields its text once
  const m = new CodexEventMapper()
  const ev = m.map('item/completed', { item: { type: 'agentMessage', id: 'x', text: 'abc', phase: 'final_answer' } }).events
  assert.deepEqual(ev.map((e) => e.t), ['text_delta', 'assistant_text'])
} finally {
  await codexHost.closeAll()
  stopCodexServer()
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition')
    await new Promise((r) => setTimeout(r, 10))
  }
}
