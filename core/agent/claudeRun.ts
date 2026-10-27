import type { ProviderUsage } from '../runs/types'
import { EXPECTED_CLAUDE_CODE_VERSION } from './claude-bin'
import { claudeCliVersionOf, claudeResultFailure, mergeUsage, usageFromClaudeResult } from './usage'

// A review-family run that ended without an answer. It carries the usage the CLI reported, so a failed run is still costed.
export class ClaudeRunError extends Error {
  constructor(message: string, readonly usage: ProviderUsage | null) { super(message) }
}

export const usageOfError = (e: unknown): ProviderUsage | null => (e instanceof ClaudeRunError ? e.usage : null)

// What a failed job spent: its stages' usage when any ran (a failed stage's usage is already among them), else the error's own.
export const failedJobUsage = (stages: Array<ProviderUsage | null>, e: unknown): ProviderUsage | null => (stages.length ? mergeUsage(stages) : usageOfError(e))

export type ClaudeRunOutput = { text: string; structured: unknown; usage: ProviderUsage | null; costUsd: number; subtype: string | null }

let warnedVersion: string | null = null

// Drain one review-family query: assistant text, tool calls, structured output, and usage stamped with the CLI version.
export async function consumeClaudeRun(stream: AsyncIterable<any>, opts: { model?: string; onToolUse?: (block: any) => void; onResult?: (msg: any) => void; onMessage?: (msg: any) => void }): Promise<ClaudeRunOutput> {
  const out: ClaudeRunOutput = { text: '', structured: null, usage: null, costUsd: 0, subtype: null }
  let cliVersion: string | null = null
  let failure: string | null = null
  let forked = false
  try {
    for await (const msg of stream) {
      cliVersion = claudeCliVersionOf(msg) ?? cliVersion
      if (msg.type === 'system' && msg.subtype === 'task_started') forked = true
      opts.onMessage?.(msg)
      if (msg.type === 'assistant') {
        const content = msg.message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') out.text += block.text
            else if (block.type === 'tool_use') opts.onToolUse?.(block)
          }
        }
      } else if (msg.type === 'result') {
        if (typeof msg.total_cost_usd === 'number') out.costUsd += msg.total_cost_usd
        out.usage = usageFromClaudeResult(msg, opts.model, cliVersion)
        out.subtype = typeof msg.subtype === 'string' ? msg.subtype : null
        out.structured = msg.structured_output ?? null
        failure = failure ?? claudeResultFailure(msg, { forked }) // a failed turn stays failed in a multi-turn run
        opts.onResult?.(msg)
      }
    }
  } catch (e) {
    // The CLI exits non-zero after an error result; that result already says what went wrong.
    if (!out.usage) throw e
  }
  if (cliVersion && cliVersion !== EXPECTED_CLAUDE_CODE_VERSION && warnedVersion !== cliVersion) {
    warnedVersion = cliVersion
    console.warn(`[claude] CLI ${cliVersion} answered, build pinned to ${EXPECTED_CLAUDE_CODE_VERSION}`)
  }
  if (failure) throw new ClaudeRunError(failure, out.usage)
  return out
}

// Parse the answer of a finished run. A run cut short (max turns, structured-output retries) still counts when its
// text parses; otherwise the error names how it ended and keeps the usage.
export function settleClaudeRun<T>(out: ClaudeRunOutput, parse: () => T): T {
  try {
    return parse()
  } catch (e) {
    const m = (e as Error).message
    throw new ClaudeRunError(out.subtype && out.subtype !== 'success' ? `Claude run ended with ${out.subtype}: ${m}` : m, out.usage)
  }
}
