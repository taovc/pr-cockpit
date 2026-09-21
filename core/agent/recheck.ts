import { query } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { withContract } from './guard'
import { buildReviewOptions } from '../host/options'
import type { ReviewHostOptions } from './review'
import { jsonSchemaFor, parseStructured } from './structured'
import { outputLangClause, resolveLang } from './lang'
import { usageFromClaudeResult } from './usage'
import { HISTORY_FILE, type RoundIntent } from './reviewHistory'
import type { ProviderUsage } from '../runs/types'

// The one re-review path. It used to be two: "recheck" asked whether the author fixed things, "guided" asked the agent
// to answer the reviewer's pushback. They were separate prompts, separate schemas and separate round counters writing
// into the same column — while the real situation is almost always both at once (the author pushed AND the reviewer
// wants the lens moved), which forced two runs and threw away the first one's conclusions.
//
// So a round now reports two independent things per finding: what the AUTHOR did, and what WE now think.

export const RecheckSchema = z.object({
  rechecks: z
    .array(
      z.object({
        fid: z.string(),
        // What the author did about it since the last round.
        status: z.enum(['fixed', 'partial', 'unaddressed', 'replied', 'new']),
        // What we now think of the finding itself, independently of the author.
        stance: z.enum(['kept', 'retracted', 'adjusted', 'discuss']).default('kept'),
        // Present only when the stance differs from the previous round's — the one thing a reviewer most wants to
        // read, and the only bookkeeping the schema asks for. Optional rather than required-and-usually-empty: a
        // required field the instructions tell you to leave blank is a field the model fights, and this schema is
        // delivered through a validator that retries five times and then fails the whole round.
        // Nothing here attests to having read the history — the tool calls record that on their own.
        stanceReason: z.string().optional(),
        // Send these ONLY with stance 'adjusted' — that stance means the finding itself was wrong as written, so the
        // corrected version has to come with it or the list keeps showing (and posting) the wording just disowned.
        severity: z.enum(['High', 'Medium', 'Low']).optional(),
        title: z.string().optional(),
        location: z.string().optional(),
        problem: z.string().optional(),
        detail: z.string().optional(),
        fix: z.string().optional(),
        text: z.string().default(''),
      }),
    )
    .default([]),
  // New problems/regressions the author introduced in the new commits → become new findings
  // (full fields, not routed through rechecks)
  newFindings: z
    .array(
      z.object({
        severity: z.enum(['High', 'Medium', 'Low']),
        title: z.string(),
        location: z.string().default(''),
        problem: z.string().default(''),
        detail: z.string().default(''),
        fix: z.string().default(''),
        text: z.string().default(''), // note on which commit/line introduced it
      }),
    )
    .default([]),
  // Overall verdict after the recheck (which blockers remain, is it mergeable now)
  // → overwrites the AI verdict from the first review
  conclusion: z.string().default(''),
})
export type RecheckResult = z.infer<typeof RecheckSchema>
const RECHECK_JSON_SCHEMA = jsonSchemaFor(RecheckSchema)

export type RecheckAgentOptions = ReviewHostOptions & {
  cwd: string
  repo: string
  prNumber: number
  defaultBranch: string
  requirement: string | null
  intent: RoundIntent
  findingIndex: string // one line per finding: identity + how each round went (see reviewHistory)
  historyPath: string // everything else, on disk, for the agent to pull from
  methodology: string
  model: string
  effort?: string
  codexServiceTier?: string | null
  lang?: string
  onTool?: (name: string, info: string) => void
}

// The middle layer of the system prompt: how PR Cockpit runs this round. It states what has been prepared and where,
// and nothing about what counts as a problem — that is the methodology's job, and this text sits above it precisely
// so it stops competing with it the way the old hardcoded step list did.
export const RECHECK_PROCEDURE = `# Re-review procedure

You are re-reviewing a pull request you have already reviewed at least once, inside a fresh read-only worktree. You
have no memory of the earlier rounds, so PR Cockpit has prepared them for you.

**What you are given directly**: this round's context block — the round number, whether the author pushed new commits,
the reviewer's instruction for this round, and a one-line index of every finding showing how each earlier round judged
it.

**What you must fetch yourself**: a \`${HISTORY_FILE}\` file whose absolute path is in the context block. It holds the
full text of every past verdict, the reviewer's earlier instructions, the PR conversation and the line-level comments
with the author's replies. Read it. The index tells you which findings have a past worth reading; for anything you are
about to contradict, re-open, or drop, read that finding's section first.

**How to work the round**:
1. Read the history file. Findings whose index line shows a stance you are about to reverse are the ones that matter most.
2. Look at what changed. When the context block gives a previous commit, diff from there — the rest you already judged.
3. Judge every existing finding on two separate axes, and do not let one answer the other:
   - what the AUTHOR did: fixed / partial / unaddressed / replied (comment only, no code change)
   - what YOU now think: kept / retracted / adjusted / discuss
   An author who fixed something you should never have raised is \`fixed\` + \`retracted\`. One who ignored something you
   now agree was noise is \`unaddressed\` + \`retracted\`. The reviewer needs both halves.
4. When your stance differs from the previous round's, say why in \`stanceReason\`. This is the reviewer's main signal
   that the review is converging rather than drifting; omit the field when the stance is unchanged.
   With \`adjusted\`, also send the corrected \`severity\`/\`title\`/\`location\`/\`problem\`/\`detail\`/\`fix\` — that stance
   means the finding was wrong as written, and the reviewer posts from the finding, not from your note about it.
5. Report anything the author's new commits broke as a new finding, not as a note on an old one.

**On the reviewer's instruction**: it governs this round only. Earlier instructions are in the history file as
evidence of where the reviewer keeps having to steer you — treat a correction they have made more than once as
something to stop needing. It narrows what you look at; it never lowers the bar for what you report once you look.`

export function buildRecheckPrompt(opts: RecheckAgentOptions): string {
  const { intent } = opts
  const changes = intent.sinceSha
    ? `The author's head at the previous round was ${intent.sinceSha}. Start from \`git diff ${intent.sinceSha}..HEAD\` and \`git log ${intent.sinceSha}..HEAD --oneline\`; go wider only where that is not enough.`
    : `No previous round recorded a commit; use \`git diff origin/${opts.defaultBranch}...HEAD\`.`

  return `Re-review PR #${opts.prNumber} of ${opts.repo}. This is round ${intent.round}.

## This round
- New commits from the author since the last round: ${intent.hasNewCommits ? 'yes' : 'no'}
- Reviewer's instruction for this round: ${intent.instruction ? `\n\n> ${intent.instruction.replace(/\n/g, '\n> ')}\n` : '(none — judge against the methodology as usual)'}
- Previous round finished at: ${intent.lastRoundAt ?? '(this is the first re-review)'}
- Full history file (read it): ${opts.historyPath}

${changes}

## What this PR was supposed to do
${opts.requirement?.trim() || '(not recorded)'}

## Findings so far
Format: \`fid [severity] title (location) · r<round>:<what the author did>/<what we thought> → … · marks\`

${opts.findingIndex}

Give a verdict for every one of them, plus a conclusion for the round: what is still blocking, and whether it can be
merged now. The conclusion replaces the one shown in the UI — write it for the current state, do not copy the old one.

Output **JSON only** (no code fences):
{
  "rechecks": [ { "fid": "F1", "status": "fixed", "stance": "kept", "text": "explanation, citing the specific commit/line" } ],
  // include "stanceReason" ONLY when the stance differs from the previous round's; omit it otherwise.
  // with "stance": "adjusted", also include the corrected severity/title/location/problem/detail/fix on that item.
  "newFindings": [ { "severity": "High|Medium|Low", "title": "one-line title", "location": "path:line",
    "problem": "why it is a problem", "detail": "details", "fix": "how to fix it", "text": "which commit/line introduced it" } ],
  "conclusion": "overall verdict: which blockers remain, whether it can be merged"
}

${outputLangClause(resolveLang(opts.lang))}
Quote code the way you would in prose — both providers validate the result against a schema, so escaping is not your problem.`
}

// A re-review reads more than a first pass does (history file, PR conversation, incremental diff), and the old ceiling
// of 40 was already failing outright on a third of real runs.
export const RECHECK_MAX_TURNS = 120

export async function runRecheckAgent(opts: RecheckAgentOptions): Promise<{ result: RecheckResult; costUsd: number; usage: ProviderUsage | null; historyRead: boolean }> {
  const prompt = buildRecheckPrompt(opts)
  const stream = query({
    prompt,
    options: buildReviewOptions({ cwd: opts.cwd, model: opts.model, effort: opts.effort, methodology: withContract(opts.methodology, RECHECK_PROCEDURE), maxTurns: RECHECK_MAX_TURNS, mcp: opts.mcp, chrome: opts.chrome, projectDirName: opts.projectDirName, abort: opts.abort, outputSchema: RECHECK_JSON_SCHEMA }),
  })
  let text = ''
  let costUsd = 0
  let usage: ProviderUsage | null = null
  let structured: unknown = null
  let historyRead = false
  for await (const msg of stream) {
    if (msg.type === 'assistant') {
      const content = (msg as any).message?.content
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type === 'text') text += b.text
          else if (b.type === 'tool_use') {
            if (touchesHistory(b.input, opts.historyPath)) historyRead = true
            opts.onTool?.(b.name, String(b.input?.command || b.input?.file_path || b.input?.pattern || '').slice(0, 80))
          }
        }
      }
    } else if (msg.type === 'result') {
      const c = (msg as any).total_cost_usd
      if (typeof c === 'number') costUsd += c
      usage = usageFromClaudeResult(msg, opts.model)
      structured = (msg as any).structured_output ?? null
    }
  }
  const result = parseStructured(RecheckSchema, structured, text)
  return { result, costUsd, usage, historyRead }
}

// Whether a tool call went at the prepared history. Matched on the full path only: the bare file name appears in the
// procedure text the agent was given, so accepting it would let a to-do item that merely quotes the name pass as
// having read the file. Checked against the whole input, because it gets opened with Read as often as with grep or sed.
export function touchesHistory(input: unknown, historyPath: string): boolean {
  let s = ''
  try { s = typeof input === 'string' ? input : JSON.stringify(input ?? '') } catch { return false }
  return s.includes(historyPath)
}
