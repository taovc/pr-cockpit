import { query } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { withContract } from './guard'
import { buildReviewOptions, type ReviewOptionsSpec } from '../host/options'
import { jsonSchemaFor, parseStructured } from './structured'
import { outputLangClause, resolveLang } from './lang'
import { REVIEW_SECTIONS } from './reviewSections'
import { usageFromClaudeResult } from './usage'
import type { ProviderUsage } from '../runs/types'

export const FindingSchema = z.object({
  severity: z.enum(['High', 'Medium', 'Low']),
  title: z.string(),
  location: z.string().default(''),
  problem: z.string().default(''),
  detail: z.string().default(''),
  fix: z.string().default(''),
  introducedByPr: z.boolean().default(true),
})
export const ReviewResultSchema = z.object({
  findings: z.array(FindingSchema).default([]),
  logic: z.string().default(''),
  quality: z.string().default(''),
  risk: z.string().default(''),
  conclusion: z.string().default(''),
  requirement: z.string().default(''),
  testPath: z.string().default(''),
})
export type ReviewResult = z.infer<typeof ReviewResultSchema>
const REVIEW_JSON_SCHEMA = jsonSchemaFor(ReviewResultSchema)

// Output language follows the UI locale (#16 "working language"); no longer hardcoded to Chinese
const outputSpec = (lang: string) => `When you are done, output **only a single JSON object** (no markdown code fences, no extra text), shaped like this:
{
  "findings": [
    { "severity": "High|Medium|Low", "title": "one-line title", "location": "path:line",
      "problem": "why this is a problem", "detail": "details (may include bullet points)", "fix": "the direction of the fix",
      "introducedByPr": true }
  ],
  "logic": "requirement / logic check",
  "quality": "code quality / reuse",
  "risk": "risk",
  "conclusion": "mergeable or not + what is blocking",
  "requirement": "what business need this PR serves (in business language)",
  "testPath": "shortest manual test path from the user's point of view + regression points"
}
Sort findings by severity, High→Medium→Low. ${outputLangClause(lang)}
Break requirement / testPath onto real line breaks, one step/point per line, each section (${REVIEW_SECTIONS.join(', ')}) starting on its own line — do not cram everything into one run-on block. Press Enter for those breaks.`

export function buildReviewPrompt(opts: { repo: string; prNumber: number; branch: string; defaultBranch: string; lang: string; instruction?: string | null }) {
  const { repo, prNumber, branch, defaultBranch } = opts
  const instruction = (opts.instruction || '').trim()
  return `You are inside a git worktree (the current directory is the repo, with PR #${prNumber}'s branch ${branch} checked out and ${defaultBranch} merged in).

Review PR #${prNumber} of repo ${repo}.
${instruction ? `
The reviewer asked for this pass specifically:

> ${instruction.replace(/\n/g, '\n> ')}

It narrows where you look; it does not lower the bar for what you report once you look. Anything the methodology
treats as a blocker is still a blocker even if it falls outside what was asked for.
` : ''}
Steps:
1. Look at the changes: \`git diff origin/${defaultBranch}...HEAD\`, \`git log origin/${defaultBranch}..HEAD --oneline\`
2. Read the relevant files as needed and grep for call sites (for any changed exported name, grep the whole repo for who uses it)
3. Read the PR description and past comments for context: \`gh pr view ${prNumber} --repo ${repo} --json title,body,comments,reviews\`
4. Review according to the methodology (see system prompt)

Discipline (mandatory):
- Read-only operations: git diff/log/show, grep, reading files, gh pr view.
- ❌ Absolutely forbidden: git add / git commit / git push / git checkout of a new branch / git reset — any write operation whatsoever is forbidden.

${outputSpec(opts.lang)}`
}

// Shared by the whole review family: read-only MCP allow list, memory directory pin and the stop handle (see core/host/options.ts).
export type ReviewHostOptions = Pick<ReviewOptionsSpec, 'mcp' | 'chrome' | 'projectDirName' | 'abort'>

export type ReviewAgentOptions = ReviewHostOptions & {
  cwd: string
  repo: string
  prNumber: number
  branch: string
  defaultBranch: string
  instruction?: string | null // what the reviewer typed before this pass started (one-shot: it steers this pass only)
  methodology: string
  model: string
  effort?: string
  codexServiceTier?: string | null
  lang?: string
  onTool?: (name: string, info: string) => void
}

// Run one review: the Agent SDK works inside the worktree with git tools and returns a structured result.
export async function runReviewAgent(opts: ReviewAgentOptions): Promise<{ result: ReviewResult; costUsd: number; raw: string; usage: ProviderUsage | null }> {
  const stream = query({
    prompt: buildReviewPrompt({ ...opts, lang: resolveLang(opts.lang) }),
    options: buildReviewOptions({ cwd: opts.cwd, model: opts.model, effort: opts.effort, methodology: withContract(opts.methodology), maxTurns: 60, mcp: opts.mcp, chrome: opts.chrome, projectDirName: opts.projectDirName, abort: opts.abort, outputSchema: REVIEW_JSON_SCHEMA }),
  })

  let text = ''
  let costUsd = 0
  let usage: ProviderUsage | null = null
  let structured: unknown = null
  for await (const msg of stream) {
    if (msg.type === 'assistant') {
      const content = (msg as any).message?.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') text += block.text
          else if (block.type === 'tool_use') {
            const info =
              typeof block.input?.command === 'string'
                ? block.input.command
                : block.input?.pattern || block.input?.file_path || ''
            opts.onTool?.(block.name, String(info).slice(0, 80))
          }
        }
      }
    } else if (msg.type === 'result') {
      const c = (msg as any).total_cost_usd
      if (typeof c === 'number') costUsd += c
      usage = usageFromClaudeResult(msg, opts.model) // tokens / per-model cost / duration for the run record
      structured = (msg as any).structured_output ?? null
    }
  }

  const parsed = parseStructured(ReviewResultSchema, structured, text)
  return { result: parsed, costUsd, raw: text, usage }
}
