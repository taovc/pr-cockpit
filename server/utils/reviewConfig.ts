import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import type { ReviewProvider } from '~core/agent/runners'
import { loadMethodology } from '~core/methodology'
import { ensureSkillVersion } from '~core/skillVersions'

// Resolve a project's review config: methodology (active skill wins), provider, model, effort.
// Key constraint, "never mix": every stage runs on the same provider, and model is always "the real
// model of the current provider".
// - claude projects: model = project.model || ANTHROPIC_MODEL (used for first review / recheck /
//   feedback recheck / Skill / chat alike)
// - codex projects: model = project.model || CODEX_MODEL (empty = the Codex SDK default)
// translateModel / translateEffort (the mechanical rewriting when posting comments, and the one-shot
// title/commit-message helpers): the project's own model — the same one the review ran on, so a model picked in the
// project config is the model that writes what reaches GitHub — but at a low reasoning effort, because rewriting text
// is not reviewing. TRANSLATE_MODEL pins a specific fast model instead; it names a claude model, so a codex project
// ignores it and stays on its own model ("never mix").
export function resolveReviewConfig(d: any, project: any) {
  const cfg = useRuntimeConfig()
  const provider: ReviewProvider = project.provider === 'codex' ? 'codex' : 'claude'
  let methodology: string
  // Which skill (and which immutable version of it) this run will be attributed to; null = the built-in default methodology.
  let skillId: string | null = null
  let skillVersionId: string | null = null
  if (project.activeSkillId) {
    const skill = d.select().from(schema.skills).where(eq(schema.skills.id, project.activeSkillId)).get()
    methodology = skill?.content || loadMethodology(project)
    if (skill?.content) {
      skillId = skill.id
      try { skillVersionId = ensureSkillVersion(d, schema, skill) } catch { skillVersionId = skill.currentVersionId ?? null }
    }
  } else {
    methodology = loadMethodology(project)
  }
  const model =
    provider === 'codex'
      ? ((project.model || cfg.codexModel || '') as string)
      : ((project.model || cfg.anthropicModel) as string)
  const translateModel = provider === 'codex' ? model : ((cfg.translateModel as string) || model)
  const codexServiceTier = provider === 'codex' && project.codexServiceTier === 'fast' ? 'fast' : null
  return {
    methodology,
    skillId,
    skillVersionId,
    provider,
    model,
    translateModel,
    translateEffort: 'low',
    effort: (project.effort || '') as string,
    codexServiceTier,
  }
}
