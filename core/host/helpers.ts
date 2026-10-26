import { query } from '@anthropic-ai/claude-agent-sdk'
import { buildHelperOptions } from './options'
import { runCodexText } from '../codex/oneshot'
import type { ReviewProvider } from '../agent/runners'

// One-shot text generation through the SDK (replaces `claude --print`): explicit cwd, no user configuration, no tools.
export async function runHelperText(opts: { prompt: string; cwd: string; model?: string; effort?: string; timeoutMs?: number }): Promise<string> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), opts.timeoutMs ?? 120_000)
  try {
    const q = query({ prompt: opts.prompt, options: buildHelperOptions({ cwd: opts.cwd, model: opts.model, effort: opts.effort, abort }) })
    let text = ''
    let result: string | null = null
    for await (const msg of q as AsyncIterable<any>) {
      if (msg.type === 'assistant') {
        const content = msg.message?.content
        if (Array.isArray(content)) for (const b of content) if (b.type === 'text' && typeof b.text === 'string') text += b.text
      } else if (msg.type === 'result') {
        if (msg.is_error) throw new Error(typeof msg.result === 'string' ? msg.result : (Array.isArray(msg.errors) ? msg.errors.join('\n') : 'claude helper failed'))
        if (typeof msg.result === 'string') result = msg.result
      }
    }
    return (result ?? text).trim()
  } finally {
    clearTimeout(timer)
  }
}

// One-shot text in the project's own provider (never mixed), at low effort.
export type HelperTarget = { provider: ReviewProvider; model: string; codexServiceTier?: string | null }
export function runProviderHelperText(t: HelperTarget, opts: { prompt: string; cwd: string; timeoutMs?: number }): Promise<string> {
  if (t.provider === 'codex') return runCodexText({ prompt: opts.prompt, model: t.model || undefined, effort: 'low', cwd: opts.cwd, serviceTier: t.codexServiceTier })
  return runHelperText({ prompt: opts.prompt, cwd: opts.cwd, model: t.model || 'sonnet', effort: 'low', timeoutMs: opts.timeoutMs })
}
