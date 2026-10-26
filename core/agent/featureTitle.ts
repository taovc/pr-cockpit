import { runHelperText } from '../host/helpers'
import { runCodexText } from '../codex/oneshot'
import { langName } from './lang'
import type { ReviewProvider } from './runners'

// Generate a short "having understood the requirement" title from the raw requirement (which may contain an issue link + the issue body fetched by the backend); used as the feature list/drawer title.
// One sentence from a cheap/fast model, following the project's provider (never mixed, same as assembleReview's translate):
//   - claude → `claude --print`, model = rc.translateModel (the project's own model unless TRANSLATE_MODEL pins one)
//   - codex  → runCodexText (read-only sandbox, no network), model = the codex main model
// model is passed in from resolveReviewConfig.translateModel (config-driven, no hardcoded model name) → swapping/renaming a model only touches the project config or env.
// Returns an empty string on failure/timeout (the caller falls back to the truncated raw description). The title uses the working language (a UI label for the user, not the public PR title).
export async function genFeatureTitle(opts: {
  provider: ReviewProvider
  model: string
  requirement: string
  lang: string
  cwd?: string
}): Promise<string> {
  const clipped = (opts.requirement || '').trim().slice(0, 4000)
  if (!clipped) return ''
  const prompt = `Read this feature request and write ONE short title (max ~10 words) capturing WHAT is being built, in ${langName(opts.lang)}. If it's just an issue link or vague, infer the actual intent. Output ONLY the title on a single line — no quotes, no "Title:" prefix, no trailing punctuation.

Feature request:
${clipped}`
  try {
    const out = opts.provider === 'codex'
      ? await runCodexText({ prompt, model: opts.model || undefined, cwd: opts.cwd })
      : await runHelperText({ prompt, cwd: opts.cwd || process.cwd(), model: opts.model || 'sonnet', effort: 'low', timeoutMs: 60_000 })
    return (out || '').trim().split('\n')[0]?.replace(/^["'`]+|["'`]+$/g, '').replace(/[。.]\s*$/, '').slice(0, 80).trim() || ''
  } catch {
    return ''
  }
}
