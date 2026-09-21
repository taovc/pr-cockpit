import { withContract } from './guard'
import { formatCodexProviderError, previewRawOutput, rawCodexErrorMessage } from './codexErrors'
import { runCodexReadonly } from '../codex/oneshot'
import {
  buildReviewPrompt,
  ReviewResultSchema,
  type ReviewAgentOptions,
  type ReviewResult,
} from './review'
import { buildRecheckPrompt, RECHECK_PROCEDURE, RecheckSchema, touchesHistory, type RecheckAgentOptions, type RecheckResult } from './recheck'
import { unescapeNewlines } from './structured'
import { resolveLang } from './lang'
import type { ReviewRunner } from './runners'
import type { ProviderUsage } from '../runs/types'

// ── Structured-output JSON Schemas (hand-written: strict structured output needs every property in `required`
// and `additionalProperties: false`, which the zod-derived schema the Claude side uses does not produce).
// They are exported so tests/codex-recheck-json.test.ts can check them against the zod schemas they mirror —
// the last drift here cost Codex the ability to send a corrected finding at all. ──
export const REVIEW_RESULT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['High', 'Medium', 'Low'] },
          title: { type: 'string' },
          location: { type: 'string' },
          problem: { type: 'string' },
          detail: { type: 'string' },
          fix: { type: 'string' },
          introducedByPr: { type: 'boolean' },
        },
        required: ['severity', 'title', 'location', 'problem', 'detail', 'fix', 'introducedByPr'],
      },
    },
    logic: { type: 'string' },
    quality: { type: 'string' },
    risk: { type: 'string' },
    conclusion: { type: 'string' },
    requirement: { type: 'string' },
    testPath: { type: 'string' },
  },
  required: ['findings', 'logic', 'quality', 'risk', 'conclusion', 'requirement', 'testPath'],
} as const

export const RECHECK_RESULT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    rechecks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fid: { type: 'string' },
          status: { type: 'string', enum: ['fixed', 'partial', 'unaddressed', 'replied', 'new'] },
          stance: { type: 'string', enum: ['kept', 'retracted', 'adjusted', 'discuss'] },
          stanceReason: { type: 'string' },
          // The corrected wording that comes with stance 'adjusted'. Without these the stance could be sent but the
          // rewrite could not, so the list kept showing — and posting — the wording the round had just disowned.
          // Nullable rather than absent: strict structured output has no optional properties, and an empty string is
          // not a severity. Nulls are dropped before the result is validated.
          severity: { type: ['string', 'null'], enum: ['High', 'Medium', 'Low', null] },
          title: { type: ['string', 'null'] },
          location: { type: ['string', 'null'] },
          problem: { type: ['string', 'null'] },
          detail: { type: ['string', 'null'] },
          fix: { type: ['string', 'null'] },
          text: { type: 'string' },
        },
        // Every hand-written schema here lists all properties in `required` (strict structured output rejects a
        // schema that does not). The Claude side makes stanceReason optional because a required-and-usually-empty
        // field destabilised its output; Codex keeps it required, with the prompt telling it to send an empty string.
        required: ['fid', 'status', 'stance', 'stanceReason', 'severity', 'title', 'location', 'problem', 'detail', 'fix', 'text'],
      },
    },
    newFindings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['High', 'Medium', 'Low'] },
          title: { type: 'string' },
          location: { type: 'string' },
          problem: { type: 'string' },
          detail: { type: 'string' },
          fix: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['severity', 'title', 'location', 'problem', 'detail', 'fix', 'text'],
      },
    },
    conclusion: { type: 'string' },
  },
  required: ['rechecks', 'newFindings', 'conclusion'],
} as const

export class CodexReviewError extends Error {
  override cause?: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'CodexReviewError'
    this.cause = cause
  }
}

export function normalizeCodexReviewError(error: unknown): CodexReviewError {
  if (error instanceof CodexReviewError) return error
  return new CodexReviewError(formatCodexProviderError('review', error), error)
}

function stripJsonFence(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
}

function parseJsonOrThrow(raw: string, label: string): unknown {
  const cleaned = stripJsonFence(raw)
  try {
    return JSON.parse(cleaned)
  } catch (error) {
    throw new CodexReviewError(`Codex ${label} returned invalid JSON: ${rawCodexErrorMessage(error)}. Raw output starts with: ${previewRawOutput(raw)}`, error)
  }
}

export function parseCodexReviewJson(raw: string): ReviewResult {
  const parsed = unescapeNewlines(parseJsonOrThrow(raw, 'review'))
  const result = ReviewResultSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ')
    throw new CodexReviewError(`Codex review JSON did not match ReviewResultSchema: ${issues}. Raw output starts with: ${previewRawOutput(raw)}`, result.error)
  }
  return result.data
}

// Strict structured output expresses "no value" as null; the result schema expresses it as an absent key.
function dropNulls<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => dropNulls(v)) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (v !== null) out[k] = dropNulls(v)
    return out as unknown as T
  }
  return value
}

export function parseCodexRecheckJson(raw: string): RecheckResult {
  const parsed = dropNulls(unescapeNewlines(parseJsonOrThrow(raw, 'recheck')))
  const result = RecheckSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ')
    throw new CodexReviewError(`Codex recheck JSON did not match RecheckSchema: ${issues}. Raw output starts with: ${previewRawOutput(raw)}`, result.error)
  }
  return result.data
}

function buildCodexReviewPrompt(opts: ReviewAgentOptions): string {
  return `${withContract(opts.methodology)}

---

${buildReviewPrompt({ ...opts, lang: resolveLang(opts.lang) })}`
}

// ── First review (codex) ──
export async function runCodexReviewAgent(opts: ReviewAgentOptions): Promise<{ result: ReviewResult; costUsd: number; raw: string; usage: ProviderUsage | null }> {
  try {
    const { raw, usage } = await runCodexReadonly({
    onStop: (stop) => { if (opts.abort?.signal.aborted) stop(); else opts.abort?.signal.addEventListener('abort', stop, { once: true }) },
      prompt: buildCodexReviewPrompt(opts),
      cwd: opts.cwd,
      model: opts.model,
      effort: opts.effort,
      serviceTier: opts.codexServiceTier,
      outputSchema: REVIEW_RESULT_JSON_SCHEMA,
      allowNetwork: true, // lets gh read PR metadata; write operations are blocked by the command guard
      mcp: opts.mcp,
      label: 'review',
      onTool: opts.onTool,
    })
    // costUsd stays a number for legacy consumers; the run record uses `usage` (null cost = unknown, never 0).
    return { result: parseCodexReviewJson(raw), costUsd: usage?.costUsd ?? 0, raw, usage }
  } catch (error) {
    throw normalizeCodexReviewError(error)
  }
}

// ── Recheck after the author's update (codex) ── needs gh to read PR comments → allow network
export async function runCodexRecheckAgent(opts: RecheckAgentOptions): Promise<{ result: RecheckResult; costUsd: number; usage: ProviderUsage | null; historyRead: boolean }> {
  let historyRead = false
  try {
    const { raw, usage } = await runCodexReadonly({
    onStop: (stop) => { if (opts.abort?.signal.aborted) stop(); else opts.abort?.signal.addEventListener('abort', stop, { once: true }) },
      prompt: `${withContract(opts.methodology, RECHECK_PROCEDURE)}\n\n---\n\n${buildRecheckPrompt(opts)}\n\n(This structured output carries every field on every recheck item: send "stanceReason" when the stance changed and an empty string "" when it did not, and send the corrected "severity"/"title"/"location"/"problem"/"detail"/"fix" with stance "adjusted", null on every other item.)`,
      cwd: opts.cwd,
      model: opts.model,
      effort: opts.effort,
      serviceTier: opts.codexServiceTier,
      outputSchema: RECHECK_RESULT_JSON_SCHEMA,
      allowNetwork: true,
      mcp: opts.mcp,
      label: 'recheck',
      onTool: opts.onTool,
      onRawTool: (input) => { if (touchesHistory(input, opts.historyPath)) historyRead = true },
    })
    return { result: parseCodexRecheckJson(raw), costUsd: usage?.costUsd ?? 0, usage, historyRead }
  } catch (error) {
    throw normalizeCodexReviewError(error)
  }
}

export const codexReviewRunner: ReviewRunner = {
  runReview: runCodexReviewAgent,
  runRecheck: runCodexRecheckAgent,
}
