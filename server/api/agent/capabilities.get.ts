import { getCapabilities } from '~core/agent/capabilities'
import { getCodexSdkStatus } from '~core/agent/codexStatus'
import { getCodexModelCatalog } from '~core/agent/codexModels'
import { PROVIDER_CAPABILITY_STAGES } from '~core/agent/providerCapabilities'

export default defineEventHandler(async (event) => {
  const force = getQuery(event).force === '1'
  // codex status + the models codex actually has available (read from `codex debug models`, not hardcoded)
  const [codex, codexCatalog] = await Promise.all([getCodexSdkStatus(force), getCodexModelCatalog(force)])
  const codexModels = codexCatalog.filter((m) => !m.hidden)
  // Hidden models only resolve a project still saved on one; the picker never lists them.
  const codexHiddenModels = codexCatalog.filter((m) => m.hidden)
  try {
    return {
      ...(await getCapabilities(force)),
      providers: {
        stages: PROVIDER_CAPABILITY_STAGES,
      },
      codex,
      codexModels,
      codexHiddenModels,
    }
  } catch (e) {
    // Fall back to a baseline if we can't get them (the aliases always work)
    return {
      models: [
        { value: 'sonnet', displayName: 'Sonnet', description: '', supportsEffort: true, effortLevels: ['low', 'medium', 'high', 'max'] },
        { value: 'opus', displayName: 'Opus', description: '', supportsEffort: true, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
        { value: 'haiku', displayName: 'Haiku', description: '', supportsEffort: false, effortLevels: [] },
      ],
      providers: {
        stages: PROVIDER_CAPABILITY_STAGES,
      },
      codex,
      codexModels,
      codexHiddenModels,
      error: (e as Error).message,
    }
  }
})
