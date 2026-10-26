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

// What is published has to be English, and the model sometimes hands back a comment that is still in the source
// language — measured on the re-review branches, where the input is a long source-language verdict and the answer
// mirrored it title, prose and all. The prompt says "translate" everywhere now; this is the reader-side check, so a
// comment that slipped through gets one corrective pass and, failing that, a warning in the preview.
//
// Code is exempt: a review quotes code for a living, and a Chinese string literal or a path inside backticks is
// supposed to survive verbatim. So the check runs over the prose only — fenced blocks, inline code spans and our own
// HTML marker removed first.
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/
export function untranslatedLine(body: string): string | null {
  const prose = (body || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]*`/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
  return prose.split('\n').map((l) => l.trim()).find((l) => CJK.test(l)) ?? null
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
async function claudePrint(model: string, effort: string | undefined, prompt: string, cwd?: string): Promise<string> {
  return runHelperText({ prompt, cwd: cwd || process.cwd(), model: model || 'sonnet', effort, timeoutMs: 120_000 })
}
function makePrint(provider: ReviewProvider, model: string, effort: string | undefined, cwd?: string, codexServiceTier?: string | null): (prompt: string) => Promise<string> {
  if (provider === 'codex') return (prompt) => runCodexText({ prompt, model: model || undefined, effort, cwd, serviceTier: codexServiceTier })
  return (prompt) => claudePrint(model, effort, prompt, cwd)
}

// Every branch below hands the model source-language text and asks for English back — but only the "normal" branch
// ever said "translate". The re-review branches just said "write professional English markdown" while handing over a
// long source-language verdict, and the model mirrored its input: whole comments went out in the reviewer's own
// language, not just a stray title. So the instruction is stated once here and appended to all of them.
const TO_ENGLISH = `Translate everything into professional English — the input may be in any language, the output must not be. EVERY piece of prose is English, the bold title line included; a title that opens with an identifier is still prose, so carry the identifier over and translate the words around it. What stays verbatim is only identifiers, file paths, line numbers and anything inside backticks or code fences — never a whole sentence or title.`

// Each finding is translated independently in parallel (every call emits little output, a few seconds) → wall clock ≈ the slowest one, not the sum.
async function translate(
  provider: ReviewProvider,
  model: string,
  effort: string | undefined,
  cwd: string | undefined,
  codexServiceTier: string | null | undefined,
  findings: PostFinding[],
  globalNotes: string,
): Promise<{ globalNotesEn: string; bodies: Record<string, string>; untranslated: { fid: string; sample: string }[]; failed: string[] }> {
  const print = makePrint(provider, model, effort, cwd, codexServiceTier)
  const tasks: Promise<void>[] = []
  const bodies: Record<string, string> = {}
  const untranslated: { fid: string; sample: string }[] = []
  const failed: string[] = [] // a translation that threw: its finding would otherwise be posted in the source language
  let globalNotesEn = ''

  const strip = (t: string) => t.replace(/^```(?:markdown|md)?\s*/i, '').replace(/```\s*$/i, '').trim()

  // One corrective pass when the answer comes back still carrying the source language, naming the line it left behind.
  // Cheap next to re-running the whole post by hand, and it catches the case the prompt alone doesn't.
  const printEnglish = async (prompt: string): Promise<string> => {
    const out = strip(await print(prompt))
    const leak = untranslatedLine(out)
    if (!leak) return out
    return strip(await print(`The English translation below still contains text in the source language. Rewrite it so that ALL prose — including the bold title line — is professional English. Only file paths, line numbers, identifiers and text inside backticks or code fences may stay as they are; everything else must be English. If a piece of source-language text is a literal value quoted from the code, keep it as-is and wrap it in backticks. Output ONLY the corrected text, nothing else.

STILL UNTRANSLATED: ${leak}

TEXT TO CORRECT:
${out}`))
  }

  if (globalNotes.trim()) {
    tasks.push(
      printEnglish(`Translate this PR-review preface into concise professional English. Output ONLY the English text, no preamble.
${TO_ENGLISH}

PREFACE (source language):
${globalNotes}`)
        .then((t) => {
          globalNotesEn = t
          const leak = untranslatedLine(t)
          if (leak) untranslated.push({ fid: 'notes', sample: leak.slice(0, 120) })
        })
        .catch(() => { failed.push('notes') }),
    )
  }

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
${TO_ENGLISH}

FINDING TITLE (source language): ${f.title}
RE-REVIEW NOTE (source language): ${verdict}`
    } else if (plan.kind === 'partial') {
      // Partially fixed / fixed incorrectly: only say what's still missing
      prompt = `Write ONE finding of a GitHub PR review as professional English markdown. This finding was RE-REVIEWED: the author's latest changes only PARTIALLY addressed it (or addressed it incorrectly). Focus the comment on WHAT IS STILL MISSING OR WRONG — briefly acknowledge what was done, then state precisely what remains. Do NOT restate the whole original finding.
Output ONLY the markdown body — a bold line "**[<severity>] <translated title>**", then the remaining problem, then a fix section.
${TO_ENGLISH}${noteClause}

RE-REVIEW VERDICT (source language): ${verdict}
ORIGINAL FINDING (source language): ${JSON.stringify(one)}`
    } else if (plan.kind === 'reply') {
      // Author replied without changing code: post a response to that reply (here the note is what the reviewer wants to say back, not an instruction on how to write the comment)
      prompt = `Write ONE GitHub PR-review comment as professional English markdown. Context: you previously raised the finding below; the author REPLIED in the PR but did NOT change the code. Respond to the author's reply and move the discussion forward — concede, push back with reasoning, or ask for clarification — per the reviewer's response. Do NOT just restate the original finding.
Output ONLY the markdown body (you may open with a bold "**[<severity>] <translated title>**" line).
${TO_ENGLISH}

AUTHOR'S REPLY / RE-REVIEW VERDICT (source language): ${verdict}
REVIEWER'S RESPONSE TO THE AUTHOR (source language — weave its intent into the comment, do NOT quote verbatim): ${f.notes}
ORIGINAL FINDING for context (source language): ${JSON.stringify(one)}`
    } else {
      // normal: translate the original finding (original behavior)
      prompt = `Write ONE finding of a GitHub PR review as professional English markdown. Output ONLY the markdown body — no preamble, no outer code fences.
Format: a bold line "**[<severity>] <translated title>**", then the problem, then detail (keep any lists), then a fix section. If "preexisting" is true, note "(pre-existing, not introduced by this PR)".
${TO_ENGLISH}${noteClause}

FINDING (source language):
${JSON.stringify(one)}`
    }
    tasks.push(
      printEnglish(prompt)
        .then((out) => {
          bodies[f.fid] = out
          const leak = untranslatedLine(out)
          if (leak) untranslated.push({ fid: f.fid, sample: leak.slice(0, 120) })
        })
        .catch(() => { failed.push(f.fid) }),
    )
  }

  await Promise.allSettled(tasks)
  return { globalNotesEn, bodies, untranslated, failed }
}

export type AssembledReview = {
  body: string
  comments: { path: string; line: number; side: 'RIGHT'; body: string }[]
  mode: 'review' | 'comment' | 'mixed'
  // Checked items not posted because of their recheck status (replied without a note / retracted) → shown in the preview so the user doesn't think they were dropped
  skipped: { fid: string; title: string; reason: 'replied-no-note' | 'retracted' }[]
  // Findings whose English is not trustworthy: the translation threw, or it came back still carrying the source
  // language. Surfaced in the preview — what goes on a PR should not silently be in the reviewer's own language.
  warnings: { fid: string; kind: 'failed' | 'untranslated'; sample: string }[]
}

export async function assembleReview(opts: {
  provider?: ReviewProvider
  model: string
  effort?: string // mechanical rewriting: run the project's own model at a low reasoning effort, not at the review's
  codexServiceTier?: string | null
  cwd?: string // codex translation needs a workingDirectory (the project's local clone path); without one it falls back to skipGitRepoCheck
  findings: PostFinding[]
  globalNotes: string
  diff: string
}): Promise<AssembledReview> {
  const { globalNotesEn, bodies, untranslated, failed } = await translate(opts.provider === 'codex' ? 'codex' : 'claude', opts.model, opts.effort, opts.cwd, opts.codexServiceTier, opts.findings, opts.globalNotes)
  // `bodies[fid] || f.title` is the last resort, and f.title is in the review's own language: whenever it is reached,
  // or a translation came back still carrying its source language, say so instead of publishing it quietly.
  const warnings: AssembledReview['warnings'] = [
    ...failed.map((fid) => ({ fid, kind: 'failed' as const, sample: '' })),
    ...untranslated.map((u) => ({ fid: u.fid, kind: 'untranslated' as const, sample: u.sample })),
  ]
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
  return { body, comments, mode, skipped, warnings }
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
