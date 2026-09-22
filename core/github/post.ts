import { clearOwnPendingReview, ghBin } from './gh'
import { authorMoveOf, stanceOf } from '../recheckAxes'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runHelperText } from '../host/helpers'
import { runCodexText } from '../codex/oneshot'
import type { ReviewProvider } from '../agent/runners'

const pexec = promisify(execFile)

export type PostFinding = {
  fid: string
  severity: 'High' | 'Medium' | 'Low'
  title: string
  location: string | null
  problem: string | null
  detail: string | null
  fix: string | null
  notes: string | null
  introducedByPr: boolean
  // Verdict of the latest recheck round (null if never rechecked) → decides how this comment gets posted
  recheck: { status: string; stance?: string | null; text: string | null } | null
}

// Once a finding has been rechecked, the latest recheck status decides how it is posted:
//   fixed     → don't repost the original, add one line to the summary's "Confirmed fixed" list
//   partial   → post a comment, but only about what's still missing
//   replied   → author replied without changing code: post only if you left a new note (a response to the author's reply); skip otherwise
//   retracted → the AI already withdrew this one, don't post (our stance is checked before any author move)
//   anything else / no recheck → post the original finding as usual (the finding is the current verdict)
type Plan =
  | { action: 'comment'; kind: 'normal' | 'partial' | 'reply' }
  | { action: 'fixed' }
  | { action: 'skip'; reason: 'replied-no-note' | 'retracted' }

function planFinding(f: PostFinding): Plan {
  // Our stance decides first — withdrawing a finding outranks whatever the author did about it — and only then does
  // the author move decide the wording. Reading a single column for both questions is what let a finding the review
  // had explicitly retracted go out as a live comment.
  const stance = stanceOf(f.recheck)
  const move = authorMoveOf(f.recheck)
  const hasNote = !!(f.notes && f.notes.trim())
  if (stance === 'retracted') return { action: 'skip', reason: 'retracted' }
  if (stance === 'discuss') return hasNote ? { action: 'comment', kind: 'reply' } : { action: 'skip', reason: 'replied-no-note' }
  if (move === 'fixed') return { action: 'fixed' }
  if (move === 'partial') return { action: 'comment', kind: 'partial' }
  if (move === 'replied') return hasNote ? { action: 'comment', kind: 'reply' } : { action: 'skip', reason: 'replied-no-note' }
  return { action: 'comment', kind: 'normal' }
}

// Set of commentable line numbers on the new-file side (RIGHT) of the diff, per file
function rightLines(diff: string): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>()
  let cur: Set<number> | null = null
  let newLine = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      cur = new Set()
      map.set(line.slice(6), cur)
    } else if (line.startsWith('+++ ')) {
      cur = null
    } else if (line.startsWith('@@')) {
      const m = line.match(/\+(\d+)/)
      newLine = m ? Number(m[1]) : 0
    } else if (cur) {
      if (line.startsWith('+')) cur.add(newLine++)
      else if (line.startsWith('-') || line.startsWith('\\')) {
        /* old side / no-newline, don't advance the new line number */
      } else {
        cur.add(newLine++) // context
      }
    }
  }
  return map
}

function parseLoc(loc: string | null): { path: string; line: number } | null {
  if (!loc) return null
  const m = loc.match(/^(.+?):(\d+)/)
  if (!m) return null
  return { path: m[1]!, line: Number(m[2]) }
}

// Translate the Chinese findings into English PR comment bodies (content published to GitHub is in English). One-shot text generation.
// Routed by the project's provider: claude goes through `claude --print` (prompt fed via stdin, so the server never hangs waiting on stdin);
// codex goes through the Codex SDK's one-shot run(). **Never mixed**: a codex project's translations also come from codex.
async function claudePrint(model: string, prompt: string, cwd?: string): Promise<string> {
  return runHelperText({ prompt, cwd: cwd || process.cwd(), model: model || 'sonnet', timeoutMs: 120_000 })
}
function makePrint(provider: ReviewProvider, model: string, cwd?: string, codexServiceTier?: string | null): (prompt: string) => Promise<string> {
  if (provider === 'codex') return (prompt) => runCodexText({ prompt, model: model || undefined, cwd, serviceTier: codexServiceTier })
  return (prompt) => claudePrint(model, prompt, cwd)
}

// Each finding is translated independently in parallel (every call emits little output, a few seconds) → wall clock ≈ the slowest one, not the sum.
async function translate(
  provider: ReviewProvider,
  model: string,
  cwd: string | undefined,
  codexServiceTier: string | null | undefined,
  findings: PostFinding[],
  globalNotes: string,
): Promise<{ globalNotesEn: string; bodies: Record<string, string> }> {
  const print = makePrint(provider, model, cwd, codexServiceTier)
  const tasks: Promise<void>[] = []
  const bodies: Record<string, string> = {}
  let globalNotesEn = ''

  if (globalNotes.trim()) {
    tasks.push(
      print(`Translate this PR-review preface (any source language) into concise professional English. Output ONLY the English text, no preamble:\n\n${globalNotes}`)
        .then((t) => { globalNotesEn = t }),
    )
  }

  const strip = (t: string) => t.replace(/^```(?:markdown|md)?\s*/i, '').replace(/```\s*$/i, '').trim()

  for (const f of findings) {
    const plan = planFinding(f)
    if (plan.action === 'skip') continue // skipped ones aren't posted, so no translation needed

    const one = {
      severity: f.severity, title: f.title, problem: f.problem, detail: f.detail,
      fix: f.fix, preexisting: !f.introducedByPr,
    }
    const hasNote = !!(f.notes && f.notes.trim())
    // note = the reviewer's instruction for how to write THIS comment (adjust tone / keep or drop content / add context / soften wording…); weave it in, never paste it verbatim
    const noteClause = hasNote
      ? `\n\nThe reviewer left a NOTE on this finding. Treat it as an INSTRUCTION for how to write/adjust THIS comment — e.g. soften or sharpen tone, add or drop detail, add context, downgrade/reframe, merge wording. Follow it and weave its intent into the comment. **Do NOT output the note text verbatim, and do NOT add a separate "Reviewer note" line** — it is guidance for you, not text for the PR author.\nReviewer note (source language): ${f.notes}`
      : ''
    const verdict = f.recheck?.text || '' // latest recheck verdict (did the author change it / what did they reply)

    let prompt: string
    if (plan.action === 'fixed') {
      // Confirmed fixed: one sentence for the summary's "Confirmed fixed" list (plain text, no heading, no fence)
      prompt = `The author CONFIRMED-FIXED this PR-review finding. Write ONE short professional English sentence acknowledging it's resolved, naming the topic so the author knows which finding. Plain text only — no markdown heading, no bullet, no code fence.
FINDING TITLE (source language): ${f.title}
RE-REVIEW NOTE (source language): ${verdict}`
    } else if (plan.kind === 'partial') {
      // Partially fixed / fixed incorrectly: only say what's still missing
      prompt = `Write ONE finding of a GitHub PR review as professional English markdown. This finding was RE-REVIEWED: the author's latest changes only PARTIALLY addressed it (or addressed it incorrectly). Focus the comment on WHAT IS STILL MISSING OR WRONG — briefly acknowledge what was done, then state precisely what remains. Do NOT restate the whole original finding.
Output ONLY the markdown body — a bold line "**[<severity>] <title>**", then the remaining problem, then a fix section. Keep file paths, line numbers, identifiers and any code fences UNCHANGED.${noteClause}

RE-REVIEW VERDICT (source language): ${verdict}
ORIGINAL FINDING (source language): ${JSON.stringify(one)}`
    } else if (plan.kind === 'reply') {
      // Author replied without changing code: post a response to that reply (here the note is what the reviewer wants to say back, not an instruction on how to write the comment)
      prompt = `Write ONE GitHub PR-review comment as professional English markdown. Context: you previously raised the finding below; the author REPLIED in the PR but did NOT change the code. Respond to the author's reply and move the discussion forward — concede, push back with reasoning, or ask for clarification — per the reviewer's response. Do NOT just restate the original finding.
Output ONLY the markdown body (you may open with a bold "**[<severity>] <title>**" line). Keep file paths, line numbers, identifiers and any code fences UNCHANGED.

AUTHOR'S REPLY / RE-REVIEW VERDICT (source language): ${verdict}
REVIEWER'S RESPONSE TO THE AUTHOR (source language — weave its intent into the comment, do NOT quote verbatim): ${f.notes}
ORIGINAL FINDING for context (source language): ${JSON.stringify(one)}`
    } else {
      // normal: translate the original finding (original behavior)
      prompt = `Write ONE finding of a GitHub PR review as professional English markdown. Output ONLY the markdown body — no preamble, no outer code fences.
Format: a bold line "**[<severity>] <title>**", then the problem, then detail (keep any lists), then a fix section. If "preexisting" is true, note "(pre-existing, not introduced by this PR)". Keep file paths, line numbers, identifiers and any code fences UNCHANGED. Translate the content to professional English (source may be any language).${noteClause}

FINDING (source language):
${JSON.stringify(one)}`
    }
    tasks.push(print(prompt).then((t) => { bodies[f.fid] = strip(t) }))
  }

  // A single failed translation must not kill the whole post: failed findings fall back to their original title during assemble
  await Promise.allSettled(tasks)
  return { globalNotesEn, bodies }
}

export type AssembledReview = {
  body: string
  comments: { path: string; line: number; side: 'RIGHT'; body: string }[]
  mode: 'review' | 'comment' | 'mixed'
  // Checked items not posted because of their recheck status (replied without a note / retracted) → shown in the preview so the user doesn't think they were dropped
  skipped: { fid: string; title: string; reason: 'replied-no-note' | 'retracted' }[]
}

export async function assembleReview(opts: {
  provider?: ReviewProvider
  model: string
  codexServiceTier?: string | null
  cwd?: string // codex translation needs a workingDirectory (the project's local clone path); without one it falls back to skipGitRepoCheck
  findings: PostFinding[]
  globalNotes: string
  diff: string
}): Promise<AssembledReview> {
  const { globalNotesEn, bodies } = await translate(opts.provider === 'codex' ? 'codex' : 'claude', opts.model, opts.cwd, opts.codexServiceTier, opts.findings, opts.globalNotes)
  const right = rightLines(opts.diff)

  const comments: AssembledReview['comments'] = []
  const summaryFindings: PostFinding[] = []
  const confirmedFixed: string[] = [] // confirmed fixed → one line in the summary
  const skipped: AssembledReview['skipped'] = []
  for (const f of opts.findings) {
    const plan = planFinding(f)
    if (plan.action === 'skip') { skipped.push({ fid: f.fid, title: f.title, reason: plan.reason }); continue }
    if (plan.action === 'fixed') { confirmedFixed.push(bodies[f.fid] || f.title); continue }
    const loc = parseLoc(f.location)
    // Invisible metadata marker: GitHub doesn't render it, but the "fix PR" verification stage uses it to losslessly recover the structured finding (#16)
    const marker = `<!-- mr:fid=${f.fid} sev=${f.severity} -->\n`
    if (loc && right.get(loc.path)?.has(loc.line)) {
      comments.push({ path: loc.path, line: loc.line, side: 'RIGHT', body: marker + (bodies[f.fid] || f.title) })
    } else {
      summaryFindings.push(f)
    }
  }

  let body = ''
  if (globalNotesEn.trim()) body += `## Re-review notes\n\n${globalNotesEn.trim()}\n\n`
  if (summaryFindings.length) {
    body += `### Additional findings (not tied to changed lines)\n\n`
    for (const f of summaryFindings) {
      body += `<!-- mr:fid=${f.fid} sev=${f.severity} -->\n${bodies[f.fid] || f.title}\n\n`
      if (f.location) body += `\`${f.location}\`\n\n`
      body += `---\n\n`
    }
  }
  if (confirmedFixed.length) {
    body += `### Confirmed fixed\n\n`
    for (const line of confirmedFixed) body += `- ${line}\n`
    body += `\n`
  }
  if (!body.trim()) body = comments.length ? 'See inline comments.' : ''

  const mode: AssembledReview['mode'] =
    comments.length && (summaryFindings.length || confirmedFixed.length) ? 'mixed' : comments.length ? 'review' : 'comment'
  return { body, comments, mode, skipped }
}

// Actually submit a PR review (inline + summary). On 422 (line not part of the diff), merge everything into the body and resend once.
export async function postReview(opts: {
  repo: string
  prNumber: number
  headSha: string
  assembled: AssembledReview
}): Promise<{ url: string }> {
  const { repo, prNumber, headSha, assembled } = opts

  // Self-heal a leftover PENDING review of ours before submitting (shared with the approve button; both submissions
  // 422 on one). The calls inside carry timeouts: this runs inside the review's 'posting' claim window and a gh call
  // hanging forever would pin the row at 'posting' permanently (recover only runs at startup).
  await clearOwnPendingReview(repo, prNumber)

  // Write the payload to a temp file and pass --input <file> (async execFile has no stdin input support and would hang)
  const run = async (payload: object) => {
    const dir = await mkdtemp(join(tmpdir(), 'mr-post-'))
    const file = join(dir, 'payload.json')
    await writeFile(file, JSON.stringify(payload))
    try {
      const { stdout } = await pexec(
        ghBin(), // never the bare 'gh': a LaunchAgent / Electron PATH has no /opt/homebrew/bin → spawn gh ENOENT
        ['api', `repos/${repo}/pulls/${prNumber}/reviews`, '--method', 'POST', '--input', file],
        { maxBuffer: 1024 * 1024 * 16, timeout: 60_000 },
      )
      return JSON.parse(stdout)
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  const payload = {
    commit_id: headSha,
    event: 'COMMENT',
    body: assembled.body,
    comments: assembled.comments,
  }
  try {
    const res = await run(payload)
    return { url: res.html_url || res._links?.html?.href || '' }
  } catch (e: any) {
    const stderr = e?.stderr?.toString?.() ?? ''
    if (/422/.test(stderr) || /line must be part of the diff/i.test(stderr)) {
      // Fallback: merge all inline comments into the body and resend (a review is atomic, so the previous attempt posted nothing)
      const merged =
        assembled.body +
        '\n\n' +
        assembled.comments.map((c) => `**\`${c.path}:${c.line}\`**\n\n${c.body}`).join('\n\n---\n\n')
      const res = await run({ commit_id: headSha, event: 'COMMENT', body: merged, comments: [] })
      return { url: res.html_url || '' }
    }
    throw new Error(`发布 review 失败: ${stderr || e?.message}`)
  }
}
