import { runProviderHelperText } from '../host/helpers'
import { langName } from './lang'
import type { ReviewProvider } from './runners'

// A short title for a feature run from its raw requirement, in the working language; '' on failure (the list shows the description).
export async function genFeatureTitle(opts: {
  provider: ReviewProvider
  model: string
  codexServiceTier?: string | null
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
    const out = await runProviderHelperText(opts, { prompt, cwd: opts.cwd || process.cwd(), timeoutMs: 60_000 })
    return (out || '').trim().split('\n')[0]?.replace(/^["'`]+|["'`]+$/g, '').replace(/[。.]\s*$/, '').slice(0, 80).trim() || ''
  } catch {
    return ''
  }
}
