import assert from 'node:assert/strict'
import { resolve } from 'node:path'

// One-shot helpers follow the project's provider: a Codex project's commit message and feature title come from Codex
// with the Codex model, never from the Claude helper (which would reject a Codex model name and fall back silently).
process.env.CODEX_EXECUTABLE = resolve('tests/helpers/mockCodexAppServer.mjs')

const { genCommitMessage } = await import('../core/fix/commitmsg')
const { genFeatureTitle } = await import('../core/agent/featureTitle')
const { runProviderHelperText } = await import('../core/host/helpers')
const { stopCodexServer } = await import('../core/codex/appServer')

const FALLBACK = 'fix: address review feedback'
const codex = { provider: 'codex' as const, model: 'gpt-5-codex', codexServiceTier: null }
try {
  const msg = await genCommitMessage(codex, 'diff --git a/x.ts b/x.ts\n+say hello', process.cwd())
  assert.notEqual(msg, FALLBACK, 'the Codex project got a generated message, not the silent fallback')
  assert.ok(msg.length > 0)
  const title = await genFeatureTitle({ ...codex, requirement: 'say hello', lang: 'en', cwd: process.cwd() })
  assert.ok(title.length > 0, 'the feature title comes from Codex too')
  assert.equal(await genCommitMessage(codex, '   ', process.cwd()), FALLBACK, 'an empty diff still short-circuits')
  // A Codex helper turn that never finishes is interrupted at the timeout instead of holding the push forever.
  const t0 = Date.now()
  await assert.rejects(runProviderHelperText(codex, { prompt: 'slow', cwd: process.cwd(), timeoutMs: 300 }), /timed out/)
  assert.ok(Date.now() - t0 < 5000, 'gave up at the timeout')
} finally {
  await stopCodexServer()
}

console.log('✓ helper provider routing')
