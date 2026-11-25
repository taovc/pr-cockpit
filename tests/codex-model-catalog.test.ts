import assert from 'node:assert/strict'
import { codexUltracodeEffort, findCodexModel, modelsFromAppServer, parseCodexModels } from '../core/agent/codexModels'

const models = parseCodexModels(JSON.stringify({
  models: [
    {
      slug: 'gpt-5.5',
      display_name: 'GPT-5.5',
      description: 'Previous model',
      visibility: 'list',
      priority: 7,
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'xhigh' }],
    },
    {
      slug: 'gpt-5.6-terra',
      display_name: 'GPT-5.6-Terra',
      description: 'Current balanced model',
      visibility: 'list',
      priority: 2,
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }, { effort: 'ultra' }],
    },
    {
      slug: 'gpt-5.6-luna',
      display_name: 'GPT-5.6-Luna',
      visibility: 'list',
      priority: 3,
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }],
    },
    {
      slug: 'hidden-model',
      display_name: 'Hidden',
      visibility: 'hide',
      priority: 0,
      supported_reasoning_levels: [{ effort: 'ultra' }],
    },
  ],
}))

assert.deepEqual(models.map((model) => model.value), ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'])
assert.deepEqual(models[0]?.effortLevels, ['low', 'max', 'ultra'])
assert.equal(codexUltracodeEffort(models, 'gpt-5.6-terra'), 'ultra')
assert.equal(codexUltracodeEffort(models, 'gpt-5.6-luna'), 'xhigh')
assert.equal(codexUltracodeEffort(models, 'missing-model'), 'xhigh')
assert.equal(codexUltracodeEffort(models), 'ultra')

const solModels = parseCodexModels(JSON.stringify({
  models: [{
    slug: 'gpt-5.6-sol',
    display_name: 'GPT-5.6-Sol',
    visibility: 'list',
    priority: 1,
    supported_reasoning_levels: [{ effort: 'ultra' }],
  }],
}))
assert.equal(codexUltracodeEffort(solModels, 'gpt-5.6-sol'), 'ultra')
assert.equal(codexUltracodeEffort(solModels, 'gpt-5.6'), 'xhigh') // no hardcoded alias any more
assert.deepEqual(parseCodexModels('not-json'), [])

// app-server `model/list` (0.171 shape): one hidden model carrying an upgrade, one id ≠ model alias.
const listData = [
  {
    id: 'gpt-6.2-sol', model: 'gpt-6.2-sol', upgrade: null, upgradeInfo: null, displayName: 'GPT-6.2-Sol', description: 'Frontier',
    hidden: false, isDefault: true, defaultReasoningEffort: 'low',
    supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }, { reasoningEffort: 'ultra', description: '' }],
    serviceTiers: [{ id: 'fast' }], additionalSpeedTiers: [],
  },
  {
    id: 'gpt-6', model: 'gpt-6-astra', upgrade: null, upgradeInfo: null, displayName: 'GPT-6-Astra', description: '',
    hidden: false, isDefault: false, defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }, { reasoningEffort: 'ultra', description: '' }],
    serviceTiers: [], additionalSpeedTiers: [],
  },
  {
    id: 'gpt-5.5', model: 'gpt-5.5', upgrade: 'gpt-6.2-sol',
    upgradeInfo: { model: 'gpt-6.2-sol', upgradeCopy: 'Try the new model', modelLink: 'https://example.test/m', migrationMarkdown: null, retirementAt: 1_800_000_000 },
    displayName: 'GPT-5.5', description: 'Previous', hidden: true, isDefault: false, defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }, { reasoningEffort: 'xhigh', description: '' }],
    serviceTiers: [], additionalSpeedTiers: [],
  },
  {
    id: 'gpt-5.4', model: 'gpt-5.4', upgrade: 'gpt-5.5', upgradeInfo: null, displayName: 'GPT-5.4', description: '',
    hidden: true, isDefault: false, defaultReasoningEffort: 'high', supportedReasoningEfforts: [], serviceTiers: [], additionalSpeedTiers: [],
  },
]
const visible = modelsFromAppServer(listData)
assert.deepEqual(visible.map((m) => m.value), ['gpt-6.2-sol', 'gpt-6-astra'])
assert.equal(visible[0]?.defaultEffort, 'low')
assert.equal(visible[0]?.supportsFast, true)
assert.equal(visible[0]?.hidden, false)
assert.equal(visible[0]?.upgrade, null)
assert.equal(visible[1]?.id, 'gpt-6')

const catalog = modelsFromAppServer(listData, { includeHidden: true })
assert.deepEqual(catalog.map((m) => m.value), ['gpt-6.2-sol', 'gpt-6-astra', 'gpt-5.5', 'gpt-5.4'])
const retired = catalog.find((m) => m.value === 'gpt-5.5')
assert.equal(retired?.hidden, true)
assert.deepEqual(retired?.effortLevels, ['low', 'xhigh'])
assert.equal(retired?.defaultEffort, 'medium')
assert.deepEqual(retired?.upgrade, { model: 'gpt-6.2-sol', copy: 'Try the new model', link: 'https://example.test/m', retirementAt: 1_800_000_000 })
// A bare `upgrade` slug without upgradeInfo still surfaces.
assert.deepEqual(catalog.find((m) => m.value === 'gpt-5.4')?.upgrade, { model: 'gpt-5.5', copy: null, link: null, retirementAt: null })
assert.equal(catalog.find((m) => m.value === 'gpt-5.4')?.supportsEffort, false)

// The id/model correspondence replaces the old alias table.
assert.equal(findCodexModel(catalog, 'gpt-6')?.value, 'gpt-6-astra')
assert.equal(findCodexModel(catalog, 'gpt-6-astra')?.value, 'gpt-6-astra')
assert.equal(findCodexModel(catalog, 'gpt-4'), undefined)
assert.equal(codexUltracodeEffort(catalog, 'gpt-6'), 'ultra')
assert.equal(codexUltracodeEffort(catalog, 'gpt-5.5'), 'xhigh') // hidden models still resolve
assert.equal(codexUltracodeEffort(catalog), 'ultra') // empty = first visible model
assert.deepEqual(modelsFromAppServer(null), [])
console.log('✓ codex model catalog')
