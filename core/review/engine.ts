import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { buildReviewOptions } from '../host/options'
import { withContract } from '../agent/guard'
import { ClaudeRunError, consumeClaudeRun, settleClaudeRun } from '../agent/claudeRun'
import { mergeUsage } from '../agent/usage'
import { jsonSchemaFor, parseStructured } from '../agent/structured'
import type { ProviderUsage } from '../runs/types'

// The finder: Claude Code's bundled /code-review in a clean, read-only process. /code-review hands the review to a
// subagent and relays its report as text; once every task it started has finished, a second query resuming the same
// session asks for the findings through the CLI-validated structured output, so the report's text format can change
// between CLI versions without breaking us.

export const ENGINE_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type EngineLevel = (typeof ENGINE_LEVELS)[number]
export const engineLevelOf = (v: unknown): EngineLevel => (ENGINE_LEVELS as readonly string[]).includes(String(v)) ? (v as EngineLevel) : 'high'

export const EngineFindingSchema = z.object({
  file: z.string(),
  line: z.number().int().nullable().default(null),
  summary: z.string(),
  failure_scenario: z.string().default(''),
})
export const EngineResultSchema = z.object({ findings: z.array(EngineFindingSchema).default([]) })
export type EngineFinding = z.infer<typeof EngineFindingSchema>

const ENGINE_TIMEOUT_MS = 15 * 60_000
const STRUCTURE_TURN = 'The /code-review run has finished. Return every finding from its report above through the structured output: file, line (null if none), summary, failure_scenario — the same findings, same order, nothing added or dropped, and do not review anything yourself. An empty list if the report found nothing.'
const TASK_DONE = new Set(['completed', 'failed', 'stopped', 'killed', 'cancelled'])

// Fires once: after the first turn's result, when every task the session started has finished.
export function taskGate(ready: () => void): { onMessage: (m: any) => void; onResult: () => void } {
  const running = new Set<string>()
  let resulted = false
  let fired = false
  const check = () => { if (resulted && !running.size && !fired) { fired = true; ready() } }
  return {
    onMessage: (m) => {
      if (m?.type !== 'system' || !m.task_id) return
      if (m.subtype === 'task_started') running.add(String(m.task_id))
      if (m.subtype === 'task_notification' && TASK_DONE.has(String(m.status))) { running.delete(String(m.task_id)); check() }
    },
    onResult: () => { resulted = true; check() },
  }
}

export function buildEngineAppend(instruction?: string | null): string {
  const ask = (instruction || '').trim()
  return withContract(`You are reviewing a pull request with the /code-review command.${ask ? `\n\nThe reviewer asked for this pass specifically (it narrows where you look, not the bar for reporting):\n> ${ask.replace(/\n/g, '\n> ')}` : ''}`)
}

export async function runEngine(opts: {
  cwd: string
  prNumber: number
  defaultBranch: string
  level: EngineLevel
  model?: string
  instruction?: string | null
  projectDirName?: string
  abort?: AbortController
  onTool?: (name: string, info: string) => void
}): Promise<{ findings: EngineFinding[]; usage: ProviderUsage | null; text: string; trace: string[] }> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), ENGINE_TIMEOUT_MS)
  const relay = () => abort.abort()
  opts.abort?.signal.addEventListener('abort', relay, { once: true })
  const t0 = Date.now()
  const trace: string[] = [] // system messages and results, kept in engine-report.md
  const note = (m: any) => {
    if (m?.type !== 'system' && m?.type !== 'result') return
    trace.push(`${Math.round((Date.now() - t0) / 1000)}s ${m.type}/${m.subtype ?? ''}${m.task_id ? ` task=${m.task_id}` : ''}${m.status ? ` status=${m.status}` : ''}${m.is_backgrounded != null ? ` bg=${m.is_backgrounded}` : ''}${m.type === 'result' ? ` turns=${m.num_turns} ${String(m.result ?? '').slice(0, 80).replace(/\n/g, ' ')}` : ''}`)
  }
  const onToolUse = (b: any) => opts.onTool?.(b.name, String(b.input?.command ?? b.input?.description ?? b.input?.pattern ?? b.input?.file_path ?? '').slice(0, 80))
  const base = { cwd: opts.cwd, model: opts.model, methodology: buildEngineAppend(opts.instruction), clean: true, baseBranch: opts.defaultBranch, projectDirName: opts.projectDirName, abort }
  try {
    // 1. The review itself, with no structured output: the subagent /code-review forks would otherwise grab the
    //    StructuredOutput tool and the main thread would end with nothing but "Command completed".
    let reviewed!: () => void
    const done = new Promise<void>((r) => { reviewed = r })
    const gate = taskGate(() => reviewed())
    const turns = (async function* () {
      yield { type: 'user', message: { role: 'user', content: `/code-review ${opts.level} ${opts.prNumber}` }, parent_tool_use_id: null } as SDKUserMessage
      await done // keep the session open until every task it started has finished
    })()
    const review = await consumeClaudeRun(query({ prompt: turns, options: buildReviewOptions({ ...base, maxTurns: 30 }) }), {
      model: opts.model, onToolUse, onMessage: (m) => { note(m); gate.onMessage(m) }, onResult: gate.onResult,
    })
    const sessionId = review.usage?.sessionId
    if (!sessionId) throw new ClaudeRunError('the engine session has no id to continue', review.usage)
    // 2. The same conversation, asked for its findings through the CLI-validated structured output.
    const out = await consumeClaudeRun(query({ prompt: STRUCTURE_TURN, options: buildReviewOptions({ ...base, maxTurns: 4, resume: sessionId, outputSchema: jsonSchemaFor(EngineResultSchema) }) }), {
      model: opts.model, onToolUse, onMessage: note,
    })
    const usage = mergeUsage([review.usage, out.usage])
    const result = settleClaudeRun({ ...out, usage }, () => {
      if (out.structured == null) throw new Error('the engine returned no structured findings')
      return parseStructured(EngineResultSchema, out.structured, out.text)
    })
    return { findings: result.findings, usage, text: review.text, trace }
  } finally {
    clearTimeout(timer)
    opts.abort?.signal.removeEventListener('abort', relay)
  }
}
