import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EXPECTED_CLAUDE_CODE_VERSION, fromVendored, resolveClaudeExecutable, sdkVersion } from '../core/agent/claude-bin'
import { claudeCliVersionOf, claudeResultFailure, usageFromClaudeResult } from '../core/agent/usage'
import { ClaudeRunError, consumeClaudeRun, failedJobUsage, settleClaudeRun, usageOfError } from '../core/agent/claudeRun'

// ── every Claude path runs the CLI bundled with the exactly pinned SDK ──
delete process.env.CLAUDE_CODE_EXECUTABLE
delete process.env.CLAUDE_CLI_PATH
const sdk = JSON.parse(readFileSync('node_modules/@anthropic-ai/claude-agent-sdk/package.json', 'utf8'))
assert.equal(sdk.claudeCodeVersion, EXPECTED_CLAUDE_CODE_VERSION, 'bump EXPECTED_CLAUDE_CODE_VERSION together with the SDK')
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
assert.equal(pkg.dependencies['@anthropic-ai/claude-agent-sdk'], sdk.version, 'the SDK is pinned to an exact version')

const platformPkg = `claude-agent-sdk-${process.platform}-${process.arch}`
assert.ok(resolveClaudeExecutable()?.includes(platformPkg), 'the bundled CLI wins over PATH')
assert.equal(sdkVersion(), sdk.version, 'the loaded SDK version is readable at runtime')
// Production has no resolvable platform package: the file scan must pick the version matching the loaded SDK.
assert.ok(fromVendored()?.includes(`@anthropic-ai+${platformPkg}@${sdk.version}/`), `vendored scan should pick ${sdk.version}`)

// ── what counts as "no answer" ──
const ok = { type: 'result', subtype: 'success', is_error: false, num_turns: 3, result: 'done' }
assert.equal(claudeResultFailure(ok), null)
assert.equal(claudeResultFailure({ type: 'assistant' }), null)
// 2.1.246 with an unsupported model: success, no error flag, zero turns, the API error as text.
assert.match(claudeResultFailure({ ...ok, num_turns: 0, result: 'API Error: 400 Claude Code 2.1.246 does not support this model' })!, /does not support/)
// 2.1.310 with an unknown model (observed live).
assert.match(claudeResultFailure({ ...ok, is_error: true, num_turns: 1, terminal_reason: 'api_error', api_error_status: 404, result: "There's an issue with the selected model" })!, /selected model/)
assert.equal(claudeResultFailure({ ...ok, terminal_reason: 'model_error', result: '' }), 'Claude run failed (model_error)')
assert.equal(claudeResultFailure({ ...ok, result: 'API Error: the handler swallows 500s' }), null, 'a normal answer may start with "API Error"')
assert.equal(claudeResultFailure({ ...ok, num_turns: 0, result: '10 findings, most severe first' }, { forked: true }), null, 'a forked slash command answers with zero turns of its own')
assert.match(claudeResultFailure({ ...ok, num_turns: 0, result: 'Not logged in · Please run /login' })!, /Not logged in/, 'without a fork, zero turns is still a failure whatever the text')
assert.equal(claudeResultFailure({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 60, terminal_reason: 'max_turns' }), null, 'cut-short runs are left to the parser')

// ── the CLI version comes from system/init ──
assert.equal(claudeCliVersionOf({ type: 'system', subtype: 'init', claude_code_version: '2.1.310' }), '2.1.310')
assert.equal(claudeCliVersionOf({ type: 'system', subtype: 'task_started' }), null)
assert.equal(usageFromClaudeResult(ok, 'opus', '2.1.310')?.cliVersion, '2.1.310')
assert.equal('cliVersion' in (usageFromClaudeResult(ok, 'opus') ?? {}), false)

// ── draining a run ──
async function* stream(msgs: any[], thenThrow?: Error) { for (const m of msgs) yield m; if (thenThrow) throw thenThrow }
const init = { type: 'system', subtype: 'init', claude_code_version: EXPECTED_CLAUDE_CODE_VERSION }
const tools: string[] = []
const good = await consumeClaudeRun(stream([
  init,
  { type: 'assistant', message: { content: [{ type: 'text', text: 'hello ' }, { type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } }] } },
  { ...ok, total_cost_usd: 0.5, structured_output: { x: 1 } },
]), { model: 'opus', onToolUse: (b) => tools.push(b.name) })
assert.equal(good.text, 'hello ')
assert.deepEqual(good.structured, { x: 1 })
assert.equal(good.costUsd, 0.5)
assert.equal(good.usage?.cliVersion, EXPECTED_CLAUDE_CODE_VERSION)
assert.deepEqual(tools, ['Read'])

// An API error result followed by the CLI's non-zero exit: the result's message wins and the usage survives.
const apiErr = { ...ok, is_error: true, num_turns: 1, terminal_reason: 'api_error', result: 'model not found', total_cost_usd: 0.01 }
const failed = await consumeClaudeRun(stream([init, apiErr], new Error('Claude Code process exited with code 1')), {}).catch((e) => e)
assert.ok(failed instanceof ClaudeRunError)
assert.equal(failed.message, 'model not found')
assert.equal(usageOfError(failed)?.cliVersion, EXPECTED_CLAUDE_CODE_VERSION, 'a failed run still reports which CLI ran it')
// A crash before any result is passed through unchanged (stop / abort keep their own error).
const crash = await consumeClaudeRun(stream([init], new Error('aborted')), {}).catch((e) => e)
assert.ok(!(crash instanceof ClaudeRunError))
assert.equal(crash.message, 'aborted')
assert.equal(usageOfError(new Error('x')), null)
// A job whose stage failed: that stage's usage is already in the stage list, so the error's copy is not added again.
assert.equal(failedJobUsage([usageOfError(failed)], failed)?.costUsd, usageOfError(failed)?.costUsd)
assert.equal(failedJobUsage([], failed)?.costUsd, usageOfError(failed)?.costUsd, 'no stage ran: the error carries the usage')

// A run cut short still counts when its text parses; otherwise the error says how it ended and keeps the usage.
const cut = await consumeClaudeRun(stream([init, { type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 60 }]), {})
assert.equal(settleClaudeRun(cut, () => 'parsed'), 'parsed')
const unparsable = (() => { try { settleClaudeRun(cut, () => { throw new Error('no JSON object') }) } catch (e) { return e } })()
assert.ok(unparsable instanceof ClaudeRunError)
assert.equal((unparsable as Error).message, 'Claude run ended with error_max_turns: no JSON object')
assert.ok(usageOfError(unparsable))

console.log('claude-cli-pin ok')
