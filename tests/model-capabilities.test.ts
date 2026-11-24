import assert from 'node:assert/strict'
import { toModelCap } from '../core/agent/capabilities'
import { buildProbeOptions } from '../core/host/options'

// The model picker shows what an alias resolves to; both fields come straight from the SDK's supportedModels().
assert.deepEqual(
  toModelCap({ value: 'opus', displayName: 'Opus', description: 'd', supportsEffort: true, supportedEffortLevels: ['low', 'max'], resolvedModel: 'claude-opus-5-5', supportsFastMode: true }),
  { value: 'opus', displayName: 'Opus', description: 'd', supportsEffort: true, effortLevels: ['low', 'max'], resolvedModel: 'claude-opus-5-5', supportsFastMode: true },
)
assert.deepEqual(toModelCap({ value: 'haiku' }), { value: 'haiku', displayName: 'haiku', description: '', supportsEffort: false, effortLevels: [] }, 'an older CLI without the fields: nothing invented')

// The catalog probe starts from the session-like probe options: settings are loaded (availableModels, model env overrides).
const probe = buildProbeOptions({ cwd: process.cwd(), abort: new AbortController() })
assert.equal('settingSources' in probe, false, 'no settingSources = load them like the CLI')

console.log('model-capabilities: ok')
