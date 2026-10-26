import { withContract } from './guard'
import { runCodexReadonly } from '../codex/oneshot'
import { normalizeCodexReviewError } from './codexReview'
import { SKILL_SYSTEM, buildSkillPrompt, cleanSkillContent, type SkillGenOptions } from './skillgen'
import type { ProviderUsage } from '../runs/types'

// Codex version of skill generation: read-only pass over the local project, producing methodology markdown.
// Codex has no systemPrompt field → fold the operating contract + SYSTEM into the start of the prompt.
export async function generateSkillCodex(opts: SkillGenOptions): Promise<{ content: string; costUsd: number; usage: ProviderUsage | null }> {
  try {
    const prompt = `${withContract(SKILL_SYSTEM)}\n\n---\n\n${buildSkillPrompt(opts)}`
    const { raw, usage } = await runCodexReadonly({
      prompt,
      cwd: opts.cwd,
      model: opts.model,
      effort: opts.effort,
      serviceTier: opts.codexServiceTier,
      label: 'skill generation',
      onTool: opts.onTool,
    })
    return { content: cleanSkillContent(raw), costUsd: usage?.costUsd ?? 0, usage }
  } catch (error) {
    throw normalizeCodexReviewError(error)
  }
}
