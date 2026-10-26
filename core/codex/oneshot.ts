import { nanoid } from 'nanoid'
import { codexHost } from './codexHost'
import type { ProviderUsage } from '../runs/types'
import type { CodexServiceTier } from '../agent/codexAgent'

// One-shot Codex runs on the host: an ephemeral thread, one turn, closed afterwards. Same signatures the review
// family and the helpers used against the SDK runner, so the callers only changed their import.

// Read-only agent stage (review / guided review / recheck / skill generation): read-only sandbox, every command
// submitted for approval and decided by the policy before it runs, optional network for `gh` reads.
export async function runCodexReadonly(opts: {
  prompt: string
  cwd?: string
  model?: string
  effort?: string
  serviceTier?: CodexServiceTier | string | null
  outputSchema?: unknown
  allowNetwork?: boolean
  label: string
  onTool?: (name: string, info: string) => void
  onRawTool?: (input: unknown) => void // untruncated tool input; onTool's `info` is cut to 100 chars
  onStop?: (stop: () => void) => void
}): Promise<{ raw: string; usage: ProviderUsage | null }> {
  const runId = `codex-${opts.label.replace(/\s+/g, '-')}-${nanoid(8)}`
  await codexHost.ensure({
    runId, kind: 'review', cwd: opts.cwd ?? process.cwd(), model: opts.model, effort: opts.effort,
    codexServiceTier: opts.serviceTier ?? null, allowNetwork: !!opts.allowNetwork, outputSchema: opts.outputSchema, mcp: false,
  })
  let stopped = false
  opts.onStop?.(() => { stopped = true; void codexHost.interrupt(runId) })
  try {
    if (stopped) throw new Error(`Codex ${opts.label} 已被用户停止`)
    const r = await codexHost.send(runId, opts.prompt, {
      onTool: (name, info) => opts.onTool?.(name === 'Bash' ? 'CodexCommand' : name === 'ApplyPatch' ? 'CodexFileChange' : name.startsWith('mcp__') ? 'CodexMcp' : name === 'WebSearch' ? 'CodexWebSearch' : name, info),
      onEvent: (e) => { if (e.t === 'tool_use') opts.onRawTool?.(e.input); else if (e.t === 'permission_denied') opts.onTool?.('CodexBlocked', e.message.slice(0, 140)); else if (e.t === 'note') opts.onTool?.('CodexWarning', e.text.slice(0, 140)) },
    })
    if (r.interrupted || stopped) throw new Error(`Codex ${opts.label} 已被用户停止`)
    if (r.isError) throw new Error(`Codex ${opts.label} turn failed: ${r.error || r.text || 'unknown error'}`)
    if (!r.text.trim()) throw new Error(`Codex ${opts.label} returned no final response.`)
    return { raw: r.text, usage: r.usage }
  } finally {
    await codexHost.close(runId, 'one-shot done').catch(() => {})
  }
}

// One-shot text generation (commit messages, titles, comment rewrites): read-only, no network, nothing to approve.
export async function runCodexText(opts: {
  prompt: string
  cwd?: string
  model?: string
  effort?: string
  serviceTier?: CodexServiceTier | string | null
}): Promise<string> {
  const runId = `codex-helper-${nanoid(8)}`
  await codexHost.ensure({ runId, kind: 'helper', cwd: opts.cwd ?? process.cwd(), model: opts.model, effort: opts.effort, codexServiceTier: opts.serviceTier ?? null })
  try {
    const r = await codexHost.send(runId, opts.prompt)
    if (r.isError) throw new Error(`Codex helper turn failed: ${r.error || r.text || 'unknown error'}`)
    return (r.text || '').trim()
  } finally {
    await codexHost.close(runId, 'one-shot done').catch(() => {})
  }
}
