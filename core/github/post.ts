import { clearOwnPendingReview, ghBin } from './gh'
import { authorMoveOf, stanceOf } from '../recheckAxes'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProviderHelperText } from '../host/helpers'
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

// Posted text must be English. Only prose is checked: fences, code-like inline spans and our HTML marker are exempt.
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f\uff00-\uffef\u1100-\u11ff\uac00-\ud7af]/ // CJK, kana, hangul, CJK punctuation and fullwidth forms
// Code (quotes, brackets, operators, paths) or a short literal is exempt; a bare sentence wrapped in backticks is still prose.
const codeLike = (s: string) => /['"=(){}[\]<>/\\.:_;,]/.test(s) || (s.length <= 40 && !/[，。！？；：]/.test(s))

export function untranslatedLine(body: string): string | null {
  const prose = (body || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`\n]*)`/g, (_m, inner: string) => (codeLike(inner) ? '' : inner))
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

// Drop a ```markdown wrapper around the whole answer; fences that belong to the body (it starts or ends with a code
// block) are kept — a wrapper never has another fence inside it.
export function stripWrapperFence(t: string): string {
  const m = /^```(?:markdown|md)?[ \t]*\n([\s\S]*?)\n?```\s*$/i.exec((t || '').trim())
  return (m && !m[1]!.includes('```') ? m[1]! : t || '').trim()
}

// One corrective pass when the answer still carries the source language; if that pass fails, keep the first answer.
export function makePrintEnglish(print: (prompt: string) => Promise<string>): (prompt: string) => Promise<string> {
  return async (prompt) => {
    const out = stripWrapperFence(await print(prompt))
    if (!out) throw new Error('empty translation') // falls back to the source-language title otherwise, unflagged
    const leak = untranslatedLine(out)
    if (!leak) return out
    try {
      return stripWrapperFence(await print(`The English translation below still contains text in the source language. Rewrite it so that ALL prose — including the bold title line — is professional English. Only file paths, line numbers, identifiers and code may stay as they are. A literal value quoted from the code (a string, an identifier) stays as-is inside backticks; never put a sentence in backticks to keep it untranslated. Output ONLY the corrected text, nothing else.

STILL UNTRANSLATED: ${leak}

TEXT TO CORRECT:
${out}`)) || out
    } catch {
      return out
    }
  }
}

// Findings → English PR comment bodies, one-shot per finding in the project's own provider (never mixed).
function makePrint(provider: ReviewProvider, model: string, effort: string | undefined, cwd?: string, codexServiceTier?: string | null): (prompt: string) => Promise<string> {
  return (prompt) => runProviderHelperText({ provider, model, codexServiceTier }, { prompt, cwd: cwd || process.cwd(), effort, timeoutMs: 120_000 })
}

// The team's comment header is "**[Severity(, pre-existing)] title**"; the bracket comes from the finding, not the model.
export function teamLabel(f: { severity: string; introducedByPr: boolean }): string {
  return f.introducedByPr ? f.severity : `${f.severity}, pre-existing`
}
export function withTeamLabel(body: string, label: string): string {
  return body.replace(/^(\s*)\*\*\[[^\]\n]*\]/, `$1**[${label}]`)
}

// The rest of a team comment: 2–4 sentences, then the fix direction.
const TEAM_SHAPE = `Then a blank line and 2–4 plain sentences in total — compress the detail, do not carry every fact over; a short list or code block only when the finding cannot be understood without it, and it counts as one sentence. Then a blank line and one line starting with "Suggestion:" — one or two sentences on the direction of a fix.`

// Appended to every prompt branch: each one hands over source-language text.
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

  const printEnglish = makePrintEnglish(print)

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
    const label = teamLabel(f)
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
Output ONLY the markdown body: the bold line "**[${label}] <title in English>**". ${TEAM_SHAPE} The suggestion covers only what remains.
${TO_ENGLISH}${noteClause}

RE-REVIEW VERDICT (source language): ${verdict}
ORIGINAL FINDING (source language): ${JSON.stringify(one)}`
    } else if (plan.kind === 'reply') {
      // Author replied without changing code: post a response to that reply (here the note is what the reviewer wants to say back, not an instruction on how to write the comment)
      prompt = `Write ONE GitHub PR-review comment as professional English markdown. Context: you previously raised the finding below; the author REPLIED in the PR but did NOT change the code. Respond to the author's reply and move the discussion forward — concede, push back with reasoning, or ask for clarification — per the reviewer's response. Do NOT just restate the original finding.
Output ONLY the markdown body (you may open with the bold line "**[${label}] <title in English>**").
${TO_ENGLISH}

AUTHOR'S REPLY / RE-REVIEW VERDICT (source language): ${verdict}
REVIEWER'S RESPONSE TO THE AUTHOR (source language — weave its intent into the comment, do NOT quote verbatim): ${f.notes}
ORIGINAL FINDING for context (source language): ${JSON.stringify(one)}`
    } else {
      // normal: translate the original finding (original behavior)
      prompt = `Write ONE finding of a GitHub PR review as professional English markdown. Output ONLY the markdown body — no preamble, no outer code fences.
Format: the bold line "**[${label}] <title in English>**". ${TEAM_SHAPE} The sentences say what is wrong and its concrete consequence or failure scenario (from problem and detail); the suggestion comes from fix, or from the problem when fix is empty.
${TO_ENGLISH}${noteClause}

FINDING (source language):
${JSON.stringify(one)}`
    }
    tasks.push(
      printEnglish(prompt)
        .then((out) => {
          bodies[f.fid] = plan.action === 'fixed' ? out : withTeamLabel(out, label)
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
  // Items whose English is not trustworthy (translation threw, or still in the source language); fid 'notes' = the preface.
  warnings: { fid: string; kind: 'failed' | 'untranslated'; sample: string }[]
}

// Unattended publishes stop on a language warning; a human publishing after the preview may accept it.
export function languageHold(warnings: AssembledReview['warnings'] | undefined, accepted: boolean): string | null {
  // A failed preface is left out of the post, so nothing in the source language would go out because of it.
  const blocking = (warnings ?? []).filter((w) => !(w.fid === 'notes' && w.kind === 'failed'))
  if (accepted || !blocking.length) return null
  return `有 ${blocking.length} 条没转成英文，未发布；请在预览里确认后手动发布`
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
  // A failed finding falls back to its source-language title; a failed preface is left out.
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
