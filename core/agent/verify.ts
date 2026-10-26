import { z } from 'zod'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { buildReviewOptions, type ReviewOptionsSpec } from '../host/options'
import { withContract } from './guard'
import { jsonSchemaFor, parseStructured } from './structured'
import { claudeCliVersionOf, claudeResultFailure, usageFromClaudeResult } from './usage'
import { resolveLang, outputLangClause } from './lang'
import { runCodexReadonly } from '../codex/oneshot'
import type { ProviderUsage } from '../runs/types'
import type { ReviewProvider } from './runners'

// Verify-before-post: a second, independent read-only pass whose only job is to try to REFUTE each finding of the
// first pass (the "adversarial verify" step behind the <1% false-positive claim of Anthropic's code review). Verdicts
// are stored on the findings; refuted ones stay visible but unchecked, so the reviewer sees what was filtered.

export const VerdictSchema = z.object({
  fid: z.string(),
  verdict: z.enum(['confirmed', 'refuted', 'unsure']),
  reason: z.string().default(''),
})
export const VerifyResultSchema = z.object({ verdicts: z.array(VerdictSchema).default([]) })
export type VerifyResult = z.infer<typeof VerifyResultSchema>
export type VerifyVerdict = z.infer<typeof VerdictSchema>['verdict']

export type VerifyFindingInput = { fid: string; severity: string; title: string; location: string | null; problem: string | null; detail: string | null }

export type VerifyAgentOptions = Pick<ReviewOptionsSpec, 'mcp' | 'chrome' | 'projectDirName' | 'abort'> & {
  cwd: string
  repo: string
  prNumber: number
  branch: string
  defaultBranch: string
  findings: VerifyFindingInput[]
  provider?: ReviewProvider
  model: string
  effort?: string
  codexServiceTier?: string | null
  lang?: string
  methodology?: string // the review skill, so the verifier judges by the same rules
  onTool?: (name: string, info: string) => void
}

const VERIFY_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { fid: { type: 'string' }, verdict: { type: 'string', enum: ['confirmed', 'refuted', 'unsure'] }, reason: { type: 'string' } },
        required: ['fid', 'verdict', 'reason'],
      },
    },
  },
  required: ['verdicts'],
} as const

export const VERIFY_SYSTEM = `You are the second, independent reviewer of a pull request. A first reviewer produced findings; your ONLY job is to try to refute each one.
For every finding: open the code at its location on this branch, check whether the described problem really exists here, whether it is already handled elsewhere (validation upstream, a guard, a test, framework behaviour), whether the fix suggested would even apply, and whether the problem is pre-existing rather than introduced by the PR.
Verdicts:
- "confirmed": you found concrete evidence (cite file:line) that the problem exists as described.
- "refuted": you found concrete evidence that the finding is wrong, already handled, or not reachable.
- "unsure": you could not decide with evidence; say what is missing.
Be sceptical of plausible-sounding findings: a finding without a reproducible failure path is not confirmed. Never edit files, never run git/gh write commands.`

export function buildVerifyPrompt(opts: VerifyAgentOptions): string {
  const lang = resolveLang(opts.lang)
  const list = opts.findings.map((f) => `- ${f.fid} [${f.severity}] ${f.title}\n  location: ${f.location || '(none)'}\n  problem: ${(f.problem || '').slice(0, 1200)}${f.detail ? `\n  detail: ${f.detail.slice(0, 1200)}` : ''}`).join('\n')
  return `Repository ${opts.repo}, PR #${opts.prNumber}, branch \`${opts.branch}\` (base \`${opts.defaultBranch}\`). The current directory is the PR branch checked out; \`git diff origin/${opts.defaultBranch}...HEAD\` shows the change.

Findings to verify:
${list}

Investigate each finding in the code, then output **only a single JSON object** (no markdown fences, no extra text):
{ "verdicts": [ { "fid": "F1", "verdict": "confirmed|refuted|unsure", "reason": "one or two sentences with file:line evidence" } ] }
Include every fid exactly once. ${outputLangClause(lang)}`
}

export async function runVerifyAgent(opts: VerifyAgentOptions): Promise<{ result: VerifyResult; costUsd: number; usage: ProviderUsage | null }> {
  const methodology = `${VERIFY_SYSTEM}${opts.methodology ? `\n\nThe first reviewer followed this methodology — judge by the same rules:\n${opts.methodology}` : ''}`
  if (opts.provider === 'codex') {
    const { raw, usage } = await runCodexReadonly({
      prompt: `${withContract(methodology)}\n\n---\n\n${buildVerifyPrompt(opts)}`,
      cwd: opts.cwd, model: opts.model, effort: opts.effort, serviceTier: opts.codexServiceTier,
      outputSchema: VERIFY_JSON_SCHEMA, allowNetwork: false, mcp: opts.mcp, label: 'verify', onTool: opts.onTool,
      onStop: (stop) => { if (opts.abort?.signal.aborted) stop(); else opts.abort?.signal.addEventListener('abort', stop, { once: true }) },
    })
    return { result: VerifyResultSchema.parse(JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, ''))), costUsd: usage?.costUsd ?? 0, usage }
  }
  const stream = query({
    prompt: buildVerifyPrompt(opts),
    options: buildReviewOptions({ cwd: opts.cwd, model: opts.model, effort: opts.effort, methodology: withContract(methodology), maxTurns: 40, mcp: opts.mcp, chrome: opts.chrome, projectDirName: opts.projectDirName, abort: opts.abort, outputSchema: jsonSchemaFor(VerifyResultSchema) }),
  })
  let text = ''
  let costUsd = 0
  let usage: ProviderUsage | null = null
  let structured: unknown = null
  let cliVersion: string | null = null
  let failure: string | null = null
  for await (const msg of stream) {
    cliVersion = claudeCliVersionOf(msg) ?? cliVersion
    if (msg.type === 'assistant') {
      const content = (msg as any).message?.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') text += block.text
          else if (block.type === 'tool_use') opts.onTool?.(block.name, String(block.input?.command ?? block.input?.pattern ?? block.input?.file_path ?? '').slice(0, 80))
        }
      }
    } else if (msg.type === 'result') {
      const c = (msg as any).total_cost_usd
      if (typeof c === 'number') costUsd += c
      usage = usageFromClaudeResult(msg, opts.model, cliVersion)
      failure = claudeResultFailure(msg)
      structured = (msg as any).structured_output ?? null
    }
  }
  if (failure) throw new Error(failure)
  return { result: parseStructured(VerifyResultSchema, structured, text), costUsd, usage }
}

// Verdict per fid with 'unsure' for anything the verifier did not mention.
export function verdictMap(result: VerifyResult, fids: string[]): Map<string, { verdict: VerifyVerdict; reason: string }> {
  const out = new Map<string, { verdict: VerifyVerdict; reason: string }>()
  for (const v of result.verdicts) out.set(v.fid, { verdict: v.verdict, reason: v.reason })
  for (const fid of fids) if (!out.has(fid)) out.set(fid, { verdict: 'unsure', reason: '' })
  return out
}
