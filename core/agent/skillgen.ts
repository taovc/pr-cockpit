import { query } from '@anthropic-ai/claude-agent-sdk'
import { withContract } from './guard'
import { buildReviewOptions } from '../host/options'
import type { ReviewHostOptions } from './review'
import { langName } from './lang'
import { consumeClaudeRun, settleClaudeRun } from './claudeRun'
import type { ProviderUsage } from '../runs/types'

export const SKILL_SYSTEM = `You are a senior architect and code review lead. Your task is to tailor a "code review methodology" (review skill) to one specific project, to be used later as the system prompt when an AI reviews that project's PRs.`
const SYSTEM = SKILL_SYSTEM

// PR Cockpit's operating boundary: the generated skill must only state "review criteria", never "operating procedures".
export const SKILL_BOUNDARY = `[PR Cockpit boundary · MUST be obeyed when generating the skill]
The methodology you produce will later be used as the criteria by a review agent that is **read-only, runs in an isolated worktree, never performs a git write, and only reviews without modifying**. Therefore:
- ✅ Only write "what to review and how to judge it": check items, severity judgements, architecture/convention concerns specific to this project.
- ❌ Never write any "operating procedure": no commit/push/any git write operation, no "create/skip a worktree", no "fix the bug / patch it along the way", no "post a comment / merge". Those are controlled centrally by the PR Cockpit engine; writing them into the skill only gets them ignored and blocked, and pollutes the methodology.`
const BOUNDARY = SKILL_BOUNDARY

export type SkillGenOptions = ReviewHostOptions & {
  cwd: string
  model: string
  effort?: string
  codexServiceTier?: string | null
  baseContent?: string | null
  instruction?: string | null // user-supplied instruction (steers the generation)
  lang?: string | null // output language (follows the UI locale); missing falls back to zh, same as the other core agents
  onTool?: (name: string, info: string) => void
}

// User-side prompt (without SYSTEM): Claude passes SYSTEM as systemPrompt; Codex has no systemPrompt field, so SYSTEM must be folded into the prompt.
export function buildSkillPrompt(opts: Pick<SkillGenOptions, 'baseContent' | 'instruction' | 'lang'>): string {
  const base = opts.baseContent?.trim()
  const task = base
    ? `Below is this project's "current" review methodology. Using your actual understanding of the repo, **improve** it: keep what is useful, fill the gaps, correct anything outdated/inaccurate, so it fits this project's real architecture and conventions.\n\n--- Current methodology ---\n${base}\n--- End ---`
    : `This project has no review methodology yet; generate one from scratch.`

  const userInstruction = opts.instruction?.trim()
    ? `\n[Reviewer's special requirements (highest priority, must be satisfied)]\n${opts.instruction.trim()}\n`
    : ''

  return `${task}
${userInstruction}
**First investigate the repo fully and deeply** (the current directory is the project root); do not just skim:
- Read through every doc: README, CLAUDE.md, AGENTS.md, docs/, memory-vault/, etc.
- Read package.json / the directory layout to work out the tech stack and layering; go into subdirectories to read the real code when needed
- grep out the key conventions: state management, permission model, API/tRPC layer, database/ORM, build-time branching (#if etc.), testing conventions, file organisation rules
- For conventions you are unsure about, read several real files to confirm instead of guessing

Investigate thoroughly (better to read and grep too much), think it through before writing. Then produce a **review methodology targeted at this project**:
- Write the entire methodology in ${langName(opts.lang)} — every heading, paragraph and checklist item in that language; keep proper nouns and code identifiers verbatim
- Cover: cross-cutting impact checks, dedicated checks for this project's own architecture/conventions (based on what you actually found — do not apply unrelated tech stacks), security/permissions, testing, risk points
- Concrete and actionable, referencing real directory/file/identifier conventions
- No vague generalities
${userInstruction ? '- Make sure the special requirements from the reviewer above are reflected' : ''}

Only read-only operations (read files, grep, ls). ❌ Do not perform any write operation.

${BOUNDARY}

Finally **output only the methodology body itself**: start with a markdown heading (such as \`# ...\`), no code fence wrapper, **no thinking process or narration whatsoever** (such as "Let me...", "Now I...", "这是方法学："), no prefix or suffix explanation. The very first character is the body heading.`
}

// Clean the output: strip code fences + leading narration (start from the first markdown heading).
export function cleanSkillContent(text: string): string {
  let content = text.trim().replace(/^```(?:markdown|md)?\s*/i, '').replace(/```\s*$/i, '').trim()
  const h = content.search(/^#{1,3}\s/m)
  if (h > 0) content = content.slice(h).trim()
  if (!content) throw new Error('生成结果为空')
  return content
}

// Let the agent read the local project and produce/improve a review methodology (markdown body).
export async function generateSkill(opts: SkillGenOptions): Promise<{ content: string; costUsd: number; usage: ProviderUsage | null }> {
  const prompt = buildSkillPrompt(opts)
  const stream = query({
    prompt,
    options: buildReviewOptions({ cwd: opts.cwd, model: opts.model, effort: opts.effort, methodology: withContract(SYSTEM), maxTurns: 80, mcp: opts.mcp, chrome: opts.chrome, projectDirName: opts.projectDirName, abort: opts.abort }),
  })
  const out = await consumeClaudeRun(stream, {
    model: opts.model,
    onToolUse: (b) => opts.onTool?.(b.name, String(b.input?.command || b.input?.pattern || b.input?.file_path || '').slice(0, 80)),
  })
  return { content: cleanSkillContent(out.text), costUsd: out.costUsd, usage: out.usage }
}
