import { query } from '@anthropic-ai/claude-agent-sdk'
import { buildHelperOptions } from './options'
import { claudeResultFailure } from '../agent/usage'

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
        const failure = claudeResultFailure(msg)
        if (failure) throw new Error(failure)
        if (typeof msg.result === 'string') result = msg.result
      }
    }
    return (result ?? text).trim()
  } finally {
    clearTimeout(timer)
  }
}
