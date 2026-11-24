import { getCapabilities } from '~core/agent/capabilities'
import { getCodexSdkStatus } from '~core/agent/codexStatus'
import { getCodexModels } from '~core/agent/codexModels'
import { PROVIDER_CAPABILITY_STAGES } from '~core/agent/providerCapabilities'

// The CLI steps a level the model does not support down, so the fallback offers all five.
const FALLBACK_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

export default defineEventHandler(async (event) => {
  const force = getQuery(event).force === '1'
  // codex status + the models codex actually has available (read from `codex debug models`, not hardcoded)
  const [codex, codexModels] = await Promise.all([getCodexSdkStatus(force), getCodexModels(force)])
  // What "global default" means for a Claude project (ANTHROPIC_MODEL)
  const defaultModel = String(useRuntimeConfig().anthropicModel || 'sonnet')
  try {
    return {
      ...(await getCapabilities(force)),
      defaultModel,
      providers: {
        stages: PROVIDER_CAPABILITY_STAGES,
      },
      codex,
      codexModels,
    }
  } catch (e) {
    // Fall back to a baseline if we can't get them (the aliases always work)
    return {
      models: ['default', 'opus', 'sonnet', 'haiku', 'fable'].map((value) => ({
        value, displayName: value[0]!.toUpperCase() + value.slice(1), description: '', supportsEffort: true, effortLevels: FALLBACK_EFFORTS,
      })),
      defaultModel,
      providers: {
        stages: PROVIDER_CAPABILITY_STAGES,
      },
      codex,
      codexModels,
      error: (e as Error).message,
    }
  }
})
