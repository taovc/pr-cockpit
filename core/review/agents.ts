import { query } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { buildReviewOptions } from '../host/options'
import { withContract } from '../agent/guard'
import { consumeClaudeRun, settleClaudeRun } from '../agent/claudeRun'
import { jsonSchemaFor, parseStructured } from '../agent/structured'
import { outputLangClause, resolveLang } from '../agent/lang'
import type { ProviderUsage } from '../runs/types'
import type { RawFinding } from './assemble'

// The project-context, check and tier agents: clean runs, everything they need is in the prompt.

type AgentBase = { cwd: string; model?: string; effort?: string; projectDirName?: string; abort?: AbortController; onTool?: (name: string, info: string) => void }
type Out<T> = { result: T; usage: ProviderUsage | null }

async function runAgent<T extends z.ZodType>(o: AgentBase & { system: string; prompt: string; schema: T; maxTurns: number; baseBranch?: string; baseRules?: boolean }): Promise<Out<z.infer<T>>> {
  const stream = query({
    prompt: o.prompt,
    options: buildReviewOptions({ cwd: o.cwd, model: o.model, effort: o.effort, methodology: withContract(o.system), maxTurns: o.maxTurns, clean: true, projectDirName: o.projectDirName, baseBranch: o.baseBranch, baseRules: o.baseRules, abort: o.abort, outputSchema: jsonSchemaFor(o.schema) }),
  })
  const out = await consumeClaudeRun(stream, {
    model: o.model,
    onToolUse: (b) => o.onTool?.(b.name, String(b.input?.command ?? b.input?.pattern ?? b.input?.file_path ?? '').slice(0, 80)),
  })
  return { result: settleClaudeRun(out, () => parseStructured(o.schema, out.structured, out.text)), usage: out.usage }
}

// ── project-context pass ──

export const ContextFindingSchema = z.object({
  file: z.string(),
  line: z.number().int().nullable().default(null),
  title: z.string(),
  consequence: z.string().default(''),
  lens: z.string().default(''),
  preExisting: z.boolean().default(false),
})
const ContextResultSchema = z.object({ findings: z.array(ContextFindingSchema).default([]) })

const CONTEXT_RULES = `Rules: every finding cites file and line and states one concrete consequence; no source reference, no finding. Do not filter by impact or by "pre-existing" — report them and mark preExisting. Project memory entries are leads: confirm them in the code before using them, and never quote memory or REVIEW.md text in a finding (they are private; findings may be posted publicly). Read other repositories only from origin/<branch> as the context file says. Never edit files or run git/gh write commands.`

const CONTEXT_SYSTEM = `You are the project-context reviewer of a pull request. A separate bug finder already looks for correctness bugs; you cover what it cannot know: this project's history, conventions and decisions.
Lenses:
- Same-class issues: the PR fixes or adds something; find the same kind of problem elsewhere in the files or flow it touches, including problems that existed before the PR.
- Duplication and drift: new code re-implementing an existing helper, composable, service or constant; code placed in the wrong layer or bypassing an established design.
- Written conventions: CLAUDE.md / AGENTS.md (in your system prompt), REVIEW.md and the other rules in the context file — e.g. comment rules, documentation numbering and indexes, "a bug fix needs a failing test first".
- Product decisions and business rules: behaviour that contradicts REVIEW.md, decision records or business-rule files.
- Cross-boundary: when the change is read or written by another repo, service or external system (API, callback, event, queue, shared table or field, generated data, file path, env or secret name), open the other side and check producer vs consumer, deploy order and environment differences.
- Any extra lens REVIEW.md defines for this kind of change.
${CONTEXT_RULES}`

// Stands in for the bug finder when it failed; the project lenses already ran.
const CORRECTNESS_SYSTEM = `You are the bug finder of a pull request this time. Look only for correctness bugs in the change: wrong logic, unhandled errors, races, wrong data or permissions, broken contracts with the code it calls or that calls it. Project conventions and history are covered by another pass.
${CONTEXT_RULES}`

export async function runContextPass(o: AgentBase & { contextPath: string; baseBranch: string; correctnessOnly: boolean }): Promise<Out<z.infer<typeof ContextResultSchema>>> {
  return runAgent({
    ...o, system: o.correctnessOnly ? CORRECTNESS_SYSTEM : CONTEXT_SYSTEM, schema: ContextResultSchema, maxTurns: 60, baseBranch: o.baseBranch,
    prompt: `Read the review context file first: ${o.contextPath}\nThen review the change through your lenses and return the findings through the structured output (English).`,
  })
}

// ── independent check ──

export const VerdictSchema = z.object({ id: z.string(), verdict: z.enum(['confirmed', 'refuted', 'unsure']), reason: z.string().default('') })
const CheckResultSchema = z.object({ verdicts: z.array(VerdictSchema).default([]) })
export type Verdict = z.infer<typeof VerdictSchema>

const CHECK_SYSTEM = `You check claims about code, one at a time, independently. For each claim open the code at its location on this branch and decide:
- "confirmed": the code shows the described behaviour or failure path (cite file:line).
- "refuted": the code shows the claim is wrong — the case is already handled, the path is unreachable, or the code was misread (cite file:line).
- "unsure": you cannot decide from the code; say what is missing.
Only correctness matters. "It existed before this PR", "low impact", "rare", "style", "out of scope" are NOT reasons to refute — those claims are confirmed if true. Never edit files or run git/gh write commands.`

export async function runCheck(o: AgentBase & { baseBranch: string; findings: RawFinding[] }): Promise<Out<z.infer<typeof CheckResultSchema>>> {
  const list = o.findings.map((f) => `- ${f.id} at ${f.file}${f.line ? `:${f.line}` : ''}\n  claim: ${f.title}${f.scenario ? `\n  failure scenario: ${f.scenario}` : ''}`).join('\n')
  return runAgent({
    ...o, system: CHECK_SYSTEM, schema: CheckResultSchema, maxTurns: 60, baseRules: false,
    prompt: `The current directory is the PR branch; \`git diff origin/${o.baseBranch}...HEAD\` shows the change.\n\nClaims:\n${list}\n\nReturn one verdict per id through the structured output (reasons in English).`,
  })
}

// ── tiers, severity, wording ──

export const TierItemSchema = z.object({
  ids: z.array(z.string()).min(1),
  tier: z.enum(['must', 'decide', 'later', 'edge']).nullable(),
  severity: z.enum(['High', 'Medium', 'Low']),
  evidence: z.enum(['inferred', 'ci']).default('inferred'),
  preExisting: z.boolean().default(false),
  location: z.string().default(''),
  title: z.string(),
  problem: z.string().default(''),
  detail: z.string().default(''),
  fix: z.string().default(''),
})
export const TierResultSchema = z.object({
  conclusion: z.string().default(''),
  notDone: z.string().default(''),
  reviewMdSuggestion: z.string().default(''),
  items: z.array(TierItemSchema).default([]),
})
export type TierResult = z.infer<typeof TierResultSchema>

const TIER_SYSTEM = `You turn checked review findings into the report the reviewer reads. Merge findings that describe the same problem (list all their ids on one item). Never drop a finding: every input id appears in exactly one item.
Tier by value to this PR (not by correctness — that was checked already):
- "must": user-visible failures; wrong data, amounts or permissions; cross-boundary contract mismatches or a deploy order that breaks; contradicting a product decision; duplication introduced by this PR; a small convention problem introduced by this PR (comments, doc numbering and indexes); a fix path without a test; and any problem of the same kind as what this PR fixes, in the files or flow it touches — even if it existed before.
- "later": pre-existing problems unrelated to this PR's goal, better-structure ideas, test gaps off the critical path.
- "edge": only rare environment conditions (browser-specific messages, unusual offline or DNS shapes, impossible inputs) and purely defensive hardening. A race or timing issue a user can trigger by normal use (acting twice quickly) is NOT an edge case.
- "decide": a product or trade-off decision the change embodies that the reviewer must make; the title is the question, the detail states the two options and the cost of each.
- null: only for findings whose check verdict is "refuted".
Severity (High/Medium/Low) is the impact if it ships, judged separately from the tier: a pre-existing Medium can still be "must".
Evidence: "ci" only when a CI check in the context file shows the failure; otherwise "inferred".
REVIEW.md rules and its not-report list override these defaults.
Writing: title = the problem in one short sentence (≤ 40 characters in Chinese, ≤ 12 words otherwise); problem = the consequence in one short sentence; detail = the failure scenario and evidence; fix = the direction of a fix in one or two sentences. location = path:line. No tables, no long paragraphs. Never cite the internal ids (E1, C2…) anywhere in the text; they belong only in the ids field. Never quote project memory or REVIEW.md text: findings may be posted publicly; describe the problem in terms of the code.
Also return: conclusion — can it merge, and what blocks it, in one sentence; notDone — the checks nobody ran (tests not executed, UI not opened, the other repo not read…), one sentence; reviewMdSuggestion — a rule or known false positive worth adding to REVIEW.md for next time, or empty.`

export async function runTier(o: AgentBase & { baseBranch: string; lang?: string; contextPath?: string | null; findings: Array<RawFinding & { verdict: string; verdictReason: string }> }): Promise<Out<TierResult>> {
  const list = o.findings.map((f) => `- ${f.id} (${f.source}${f.preExisting ? ', pre-existing' : ''}; check: ${f.verdict}${f.verdictReason ? ` — ${f.verdictReason}` : ''}) ${f.file}${f.line ? `:${f.line}` : ''}\n  ${f.title}${f.scenario ? `\n  scenario: ${f.scenario}` : ''}`).join('\n')
  return runAgent({
    ...o, system: TIER_SYSTEM, schema: TierResultSchema, maxTurns: 20, baseBranch: o.baseBranch,
    prompt: `${o.contextPath ? `The review context (requirement, CI checks, REVIEW.md, the reviewer's request) is in ${o.contextPath} — read it first.\n\n` : ''}Checked findings:\n${list || '(none)'}\n\nReturn the report through the structured output. ${outputLangClause(resolveLang(o.lang))}`,
  })
}
