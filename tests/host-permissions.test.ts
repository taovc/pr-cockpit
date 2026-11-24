import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { getDb, schema } from '../core/db/client'
import { classifyGithubCommand, classifyMcpToolCall } from '../core/agent/commandGuard'
import { answerPending, makeDangerHook, makePromptBridge, toPermissionResult, type PendingPrompt } from '../core/host/permissions'
import { createRun } from '../core/runs/store'
import type { RunEvent } from '../core/host/types'

const d = getDb(':memory:')
const runId = createRun(d, schema, { kind: 'session', subkind: 'session', provider: 'claude' })

// ── Danger hook: dangerous Bash → 'ask' (a permission card in every mode); allowed → pass-through; non-Bash ignored ──
let allow = false
const hook = makeDangerHook(() => allow)
const pre = (cmd: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd }, session_id: 's', transcript_path: '', cwd: '/' }) as any
const opts = { signal: new AbortController().signal }
assert.deepEqual(await hook(pre('ls -la'), 'tu', opts), {})
const pushed = await hook(pre('git -C /repo push origin main'), 'tu', opts) as any
assert.equal(pushed.hookSpecificOutput.permissionDecision, 'ask')
assert.equal((await hook(pre('sudo rm -rf /'), 'tu', opts) as any).hookSpecificOutput.permissionDecision, 'ask')
assert.equal((await hook(pre('gh --repo o/r pr create'), 'tu', opts) as any).hookSpecificOutput.permissionDecision, 'ask')
allow = true
assert.deepEqual(await hook(pre('git push'), 'tu', opts), {}, 'allowDanger is read live')
assert.deepEqual(await hook({ ...pre('git push'), tool_name: 'Write' }, 'tu', opts), {})
console.log('danger hook: ok')

// ── GitHub command classifier shared by the Claude hook and the Codex guards ──
const gh = classifyGithubCommand
for (const c of ['gh pr view 1', 'gh pr diff 1', 'gh pr checks 1', 'gh pr list', 'gh api repos/o/r/pulls/1', 'gh api -X GET repos/o/r/pulls',
  'gh api --method GET search/issues -f q=x', 'gh pr create --base dev', 'git merge origin/dev', 'grep -rn "gh pr merge" core', 'echo gh pr merge 1', 'ls -la']) {
  assert.equal(gh(c), null, c)
}
for (const c of ['gh pr merge 1', 'gh -R o/r pr merge 1 --admin --squash', 'gh --repo o/r pr merge 1', 'gh --repo=o/r pr merge --auto',
  'gh pr review 1 --approve', 'gh pr review 1 -a', 'gh pr review 1 -a -b ok', 'gh api repos/o/r/pulls/1/reviews -f event=APPROVE',
  "gh api repos/o/r/pulls/1/reviews -f 'event=APPROVE'", 'gh api -X PUT repos/o/r/pulls/1/merge', 'gh api --method=PUT /repos/o/r/pulls/1/merge -f merge_method=squash',
  'FOO=1 gh pr merge 1', 'cd x && gh pr merge 1', '/opt/homebrew/bin/gh pr merge 1', 'command gh pr merge 1', 'env GH_TOKEN=x gh pr merge 1',
  'gh pr view 1; gh pr merge 1', 'false || gh pr merge 1', 'echo y | gh pr merge 1', "/bin/zsh -lc 'git status && gh pr merge 1'", "bash -c 'gh pr merge 1'",
  'x=$(gh pr merge 1)', 'gh api graphql -f query=\'mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }\'',
  // substitutions keep the outer endpoint whole
  'gh api repos/o/r/pulls/$(gh pr view --json number -q .number)/reviews -f event=APPROVE', 'gh api repos/o/r/pulls/`cat n`/reviews -f event=APPROVE',
  'gh api -X PUT repos/o/r/pulls/$(gh pr view --json number -q .number)/merge',
  // keywords, wrappers and flags before the subcommand
  '{ gh pr merge 1; }', 'if true; then gh pr merge 1; fi', 'for i in 1; do gh pr merge $i; done', 'echo 1 | xargs gh pr merge', 'timeout 30 gh pr merge 1',
  'env -u X gh pr merge 1', 'sudo -E gh pr merge 1', 'eval "gh pr merge 1"', '$(which gh) pr merge 1', 'gh pr -R o/r merge 1', 'awk \'BEGIN{system("gh pr merge 1")}\'',
  // payloads that cannot be read, the repo merges endpoint, review submissions without a visible non-approving event
  `echo '{"event":"APPROVE"}' | gh api repos/o/r/pulls/1/reviews --input -`, 'gh api repos/o/r/pulls/1/reviews --input body.json', 'gh api repos/o/r/merges -f base=main -f head=feat',
  'gh api repos/o/r/pulls/1/reviews -f body=x', 'gh api repos/o/r/pulls/1/reviews/9/events -F event=$EV', 'gh api graphql -F query=@m.graphql', 'gh api graphql --input q.json',
  "gh api graphql -f query='mutation { submitPullRequestReview(input: {pullRequestReviewId: \"x\", event: APPROVE}) { clientMutationId } }'"]) {
  assert.equal(gh(c), 'approve-merge', c)
}
for (const c of ['gh pr comment 1 -b x', 'gh pr review 1 --comment -b x', 'gh pr review 1 --request-changes -b x', 'gh pr edit 1 --title t', 'gh pr close 1',
  'gh pr reopen 1', 'gh pr ready 1', 'gh pr lock 1', 'gh issue comment 1 -b x', 'gh issue edit 1', 'gh issue close 1', 'gh issue reopen 1', 'gh issue lock 1',
  'gh issue delete 1', 'gh issue transfer 1 o/r2', 'gh release create v1', 'gh release edit v1', 'gh release delete v1', 'gh release upload v1 a.zip',
  'gh label create bug', 'gh label edit bug', 'gh label delete bug', 'gh secret set X', 'gh secret delete X', 'gh variable set X', 'gh variable delete X',
  'gh workflow run ci.yml', 'gh repo edit', 'gh repo archive', 'gh repo rename x', 'gh repo delete o/r', 'gh api repos/o/r/issues/1/comments -f body=x',
  'gh api --method PATCH repos/o/r/pulls/1', 'gh api -X POST repos/o/r/issues', 'gh api -XDELETE repos/o/r/issues/1/labels', 'gh api repos/o/r/issues -F title=x',
  'gh api repos/o/r/issues --field title=x', 'gh api repos/o/r/issues --raw-field title=x', 'gh api repos/o/r/issues --input body.json',
  'gh api repos/o/r/pulls/1/reviews -f event=COMMENT', 'gh -R o/r issue comment 1 -b x', 'cd x && gh pr comment 1 -b y',
  'gh api repos/o/r/pulls/1/reviews/9/events -f event=REQUEST_CHANGES -f body=x', 'gh api -X PUT repos/o/r/pulls/1/reviews/9 -f body=x',
  'sudo -u me gh issue close 1', 'nice -n 5 gh pr comment 1 -b x', 'gh issue -R o/r comment 1 -b x',
  "gh api graphql -f query='mutation { addComment(input: {subjectId: \"x\", body: \"y\"}) { clientMutationId } }'",
  "gh api graphql -f query='mutation { addPullRequestReview(input: {pullRequestId: \"x\", event: COMMENT, body: \"y\"}) { clientMutationId } }'"]) {
  assert.equal(gh(c), 'github-write', c)
}
// Read-only GraphQL (no mutation, query on the command line) stays a read even with -f / -F.
for (const c of ["gh api graphql -f query='{ repository(owner:\"o\",name:\"r\"){ pullRequest(number:1){ reviewThreads(first:50){nodes{isResolved}} } } }'",
  "gh api graphql -F owner=o -f query='query($owner:String!){ repository(owner:$owner,name:\"r\"){ id } }'", 'gh pr view 1 --json mergeable', 'gh pr list --search "merge conflict"']) {
  assert.equal(gh(c), null, c)
}
// MCP tools reach GitHub without a shell
assert.equal(classifyMcpToolCall('mcp__github__merge_pull_request', {}), 'approve-merge')
assert.equal(classifyMcpToolCall('mcp__plugin_engineering_github__create_pull_request_review', { event: 'APPROVE' }), 'approve-merge')
assert.equal(classifyMcpToolCall('mcp__github__pull_request_review_write', { method: 'submit_pending', event: 'APPROVE' }), 'approve-merge')
assert.equal(classifyMcpToolCall('mcp__github__enable_auto_merge', {}), 'approve-merge')
assert.equal(classifyMcpToolCall('mcp__github__update_pull_request', { autoMerge: true }), 'approve-merge')
assert.equal(classifyMcpToolCall('mcp__github__pull_request_review_write', { method: 'create', event: 'COMMENT' }), null)
assert.equal(classifyMcpToolCall('mcp__github__list_pull_requests', {}), null)
assert.equal(classifyMcpToolCall('mcp__x__emergencyStop', {}), null)
console.log('github command classifier: ok')

// ── Hook decision per workspace kind × allowDanger ──
const decide = async (cmd: string, scope: 'fix' | 'feature' | 'global' | undefined, allowDanger: boolean) => {
  const r = await makeDangerHook(() => allowDanger, () => scope)(pre(cmd), 'tu', opts) as any
  return r.hookSpecificOutput?.permissionDecision ?? 'pass'
}
for (const scope of ['fix', 'feature'] as const) {
  for (const danger of [false, true]) {
    assert.equal(await decide('gh -R o/r pr merge 1 --admin --squash', scope, danger), 'deny', `${scope} merge danger=${danger}`)
    assert.equal(await decide('gh pr review 1 --approve', scope, danger), 'deny', `${scope} approve danger=${danger}`)
    assert.equal(await decide('gh api repos/o/r/pulls/1/reviews -f event=APPROVE', scope, danger), 'deny')
  }
  assert.equal(await decide('gh pr comment 1 -b x', scope, false), 'ask')
  assert.equal(await decide('gh pr comment 1 -b x', scope, true), 'pass')
  assert.equal(await decide('gh api repos/o/r/issues/1/comments -f body=x', scope, false), 'ask')
  assert.equal(await decide('gh pr create --base dev', scope, false), 'ask')
  assert.equal(await decide('gh pr create --base dev', scope, true), 'pass')
  assert.equal(await decide('gh pr view 1', scope, false), 'pass')
}
for (const scope of ['global', undefined] as const) {
  assert.equal(await decide('gh pr merge 1', scope, false), 'ask', `${scope} merge asks`)
  assert.equal(await decide('gh pr merge 1', scope, true), 'pass', `${scope} merge allowed with allowDanger`)
  assert.equal(await decide('gh pr review 1 -a', scope, false), 'ask')
  assert.equal(await decide('gh issue close 1', scope, false), 'ask')
  assert.equal(await decide('gh issue close 1', scope, true), 'pass')
  assert.equal(await decide('gh api repos/o/r/pulls/1', scope, false), 'pass')
}
const denied = await makeDangerHook(() => true, () => 'fix')(pre('gh pr merge 1'), 'tu', opts) as any
assert.match(denied.hookSpecificOutput.permissionDecisionReason, /done by the human in PR Cockpit/)
// MCP tools go through the same rule (options.ts registers the hook for mcp__.* as well)
const mcpCall = (name: string, input: unknown) => ({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: input, session_id: 's', transcript_path: '', cwd: '/' }) as any
const decideMcp = async (name: string, input: unknown, scope: 'fix' | 'feature' | 'global', allowDanger: boolean) => {
  const r = await makeDangerHook(() => allowDanger, () => scope)(mcpCall(name, input), 'tu', opts) as any
  return r.hookSpecificOutput?.permissionDecision ?? 'pass'
}
for (const danger of [false, true]) {
  assert.equal(await decideMcp('mcp__github__merge_pull_request', { pullNumber: 1 }, 'fix', danger), 'deny')
  assert.equal(await decideMcp('mcp__github__create_pull_request_review', { event: 'APPROVE' }, 'feature', danger), 'deny')
}
assert.equal(await decideMcp('mcp__github__merge_pull_request', {}, 'global', false), 'ask')
assert.equal(await decideMcp('mcp__github__merge_pull_request', {}, 'global', true), 'pass')
assert.equal(await decideMcp('mcp__github__get_pull_request', { pullNumber: 1 }, 'fix', false), 'pass')
const { buildOptions } = await import('../core/host/options')
const sessionOpts = buildOptions({ runId: 'r', kind: 'session', cwd: '/' } as any, { canUseTool: (async () => ({ behavior: 'allow' })) as any, dangerHook: makeDangerHook(() => false), abort: new AbortController() })
assert.deepEqual(sessionOpts.hooks!.PreToolUse!.map((m) => m.matcher), ['Bash', 'mcp__.*'])
console.log('github write hook decisions: ok')

// ── Answer → PermissionResult mapping ──
const base: Pick<PendingPrompt, 'kind' | 'input' | 'suggestions'> = { kind: 'tool', input: { command: 'touch x' }, suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch:*' }], behavior: 'allow', destination: 'localSettings' }] as any }
assert.deepEqual(toPermissionResult(base, { behavior: 'deny' }), { behavior: 'deny', message: 'Denied by the user in PR Cockpit', interrupt: false })
const once = toPermissionResult(base, { behavior: 'allow' }) as any
assert.equal(once.behavior, 'allow'); assert.equal(once.updatedPermissions, undefined); assert.equal(once.decisionClassification, 'user_temporary')
const always = toPermissionResult(base, { behavior: 'allow', always: true }) as any
assert.equal(always.updatedPermissions.length, 1); assert.equal(always.decisionClassification, 'user_permanent')
const q = toPermissionResult({ kind: 'question', input: { questions: [{ question: 'A or B?' }] } }, { behavior: 'answer', answers: { 'A or B?': 'A' } }) as any
assert.deepEqual(q.updatedInput.answers, { 'A or B?': 'A' })
assert.ok(Array.isArray(q.updatedInput.questions), 'original input is preserved alongside the answers')
console.log('permission result mapping: ok')

// ── Bridge round trip against the in-memory DB: park → row pending → answer → resolved + row updated ──
const events: RunEvent[] = []
const prompts = new Map<string, PendingPrompt>()
let waiting: boolean | null = null
const bridge = makePromptBridge({ runId, store: { db: d, schema }, prompts, currentTurnId: () => 'turn-1', emit: (e) => events.push(e), onWaiting: (w) => { waiting = w } })
const ac = new AbortController()
const p = bridge('Bash', { command: 'touch x' }, { signal: ac.signal, suggestions: base.suggestions, title: 'Claude wants to run touch x' } as any)
await new Promise((r) => setTimeout(r, 5))
assert.equal(prompts.size, 1)
assert.equal(waiting, true)
const req = events.find((e) => e.t === 'permission_request') as any
assert.equal(req.kind, 'tool'); assert.equal(req.title, 'Claude wants to run touch x')
let row = d.select().from(schema.permissionRequests).where(eq(schema.permissionRequests.id, req.promptId)).get()!
assert.equal(row.status, 'pending'); assert.equal(row.turnId, 'turn-1'); assert.equal(JSON.parse(row.input!).command, 'touch x')
assert.equal(answerPending(prompts, { db: d, schema }, (e) => events.push(e), 'nope', { behavior: 'allow' }), false, 'unknown prompt id → false')
assert.equal(answerPending(prompts, { db: d, schema }, (e) => events.push(e), req.promptId, { behavior: 'allow', always: true }), true)
const result = await p as any
assert.equal(result.behavior, 'allow'); assert.equal(result.updatedPermissions.length, 1)
row = d.select().from(schema.permissionRequests).where(eq(schema.permissionRequests.id, req.promptId)).get()!
assert.equal(row.status, 'allowed'); assert.equal(row.always, true); assert.ok(row.resolvedAt)
assert.equal(prompts.size, 0); assert.equal(waiting, false)
assert.ok(events.some((e) => e.t === 'permission_resolved' && (e as any).status === 'allowed'))

// AskUserQuestion kind + abort (interrupt / close) → cancelled, promise settles as deny
const p2 = bridge('AskUserQuestion', { questions: [{ question: 'Q?' }] }, { signal: ac.signal } as any)
await new Promise((r) => setTimeout(r, 5))
const req2 = events.filter((e) => e.t === 'permission_request').pop() as any
assert.equal(req2.kind, 'question')
ac.abort()
const r2 = await p2 as any
assert.equal(r2.behavior, 'deny')
row = d.select().from(schema.permissionRequests).where(eq(schema.permissionRequests.id, req2.promptId)).get()!
assert.equal(row.status, 'cancelled')
assert.equal(prompts.size, 0)
console.log('host-permissions: all ok')
