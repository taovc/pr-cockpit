import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EXPECTED_CLAUDE_CODE_VERSION, fromVendored, resolvePinnedClaudeExecutable } from '../core/agent/claude-bin'
import { claudeCliVersionOf, claudeResultFailure, usageFromClaudeResult } from '../core/agent/usage'

// ── the review family runs the CLI bundled with the pinned SDK, never the auto-updating PATH one ──
delete process.env.CLAUDE_CODE_EXECUTABLE
delete process.env.CLAUDE_CLI_PATH
const sdk = JSON.parse(readFileSync('node_modules/@anthropic-ai/claude-agent-sdk/package.json', 'utf8'))
assert.equal(sdk.claudeCodeVersion, EXPECTED_CLAUDE_CODE_VERSION, 'bump EXPECTED_CLAUDE_CODE_VERSION together with the SDK')
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
assert.equal(String(pkg.dependencies['@anthropic-ai/claude-agent-sdk']).replace(/^[^\d]*/, ''), sdk.version)

const platformPkg = `claude-agent-sdk-${process.platform}-${process.arch}`
const pinned = resolvePinnedClaudeExecutable()
assert.ok(pinned?.includes(platformPkg), `pinned CLI should be the bundled one, got ${pinned}`)
// Production has no resolvable platform package; the file scan must find the same version there.
const vendored = fromVendored()
assert.ok(vendored?.includes(`@anthropic-ai+${platformPkg}@${sdk.version}`), `vendored scan should find ${sdk.version}, got ${vendored}`)

// ── a result that says "success" but is not an answer ──
const ok = { type: 'result', subtype: 'success', is_error: false, num_turns: 3, result: 'done' }
assert.equal(claudeResultFailure(ok), null)
assert.equal(claudeResultFailure({ type: 'assistant' }), null)
assert.match(
  claudeResultFailure({ type: 'result', subtype: 'success', is_error: false, num_turns: 0, result: 'API Error: 400 Claude Code 2.1.246 does not support this model' })!,
  /does not support this model/,
  'unsupported model: zero turns, error text in a success result',
)
assert.match(claudeResultFailure({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'API Error: 529 overloaded' })!, /529/)
assert.equal(claudeResultFailure({ type: 'result', subtype: 'success', is_error: false, num_turns: 0, result: '' }), 'Claude run ended without a single turn')
assert.equal(claudeResultFailure({ type: 'result', subtype: 'error_max_turns', is_error: false, num_turns: 60 }), 'Claude run ended with error_max_turns')
assert.equal(claudeResultFailure({ type: 'result', subtype: 'success', is_error: true, num_turns: 2, result: 'boom' }), 'boom')
assert.equal(claudeResultFailure({ ...ok, result: 'The API Error: section below is fine' }), null, 'only a leading API Error counts')

// ── the CLI version is taken from system/init and lands on the usage record ──
assert.equal(claudeCliVersionOf({ type: 'system', subtype: 'init', claude_code_version: '2.1.310' }), '2.1.310')
assert.equal(claudeCliVersionOf({ type: 'system', subtype: 'task_started' }), null)
assert.equal(usageFromClaudeResult(ok, 'opus', '2.1.310')?.cliVersion, '2.1.310')
assert.equal('cliVersion' in (usageFromClaudeResult(ok, 'opus') ?? {}), false)

console.log('claude-cli-pin ok')
