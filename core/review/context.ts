import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fetchIssueBody, fetchPrReviewSources, type PrReviewSources } from '../github/gh'
import { reviewHistoryDir } from '../agent/reviewHistory'
import { claudeConfigDir } from '../host/options'

// What the review agents need about a PR, collected by code before any agent starts and written to one file.

const pexec = promisify(execFile)

export type RuleFile = { path: string; text: string; sha: string; from: 'base-branch' | 'file' }
export type OtherRepo = { repo: string; path: string; defaultBranch: string; fetched: boolean }
export type ReviewContext = {
  reviewMd: RuleFile[]
  searched: string[]
  requirement: { source: 'closing-issue' | 'referenced-issue' | 'pr-body' | 'commits' | 'none'; text: string }
  checks: PrReviewSources['checks']
  memoryIndex: { dir: string; text: string } | null
  otherRepos: OtherRepo[]
  unavailable?: string // why the requirement and CI could not be fetched
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

// REVIEW.md from the project's clone up to the home directory, nearest first. The clone's own copy is read from the base
// branch so a PR cannot rewrite the rules it is reviewed by; the ones above the clone are plain files.
export async function findReviewMd(localPath: string, defaultBranch: string, home = homedir()): Promise<{ files: RuleFile[]; searched: string[] }> {
  const files: RuleFile[] = []
  const searched: string[] = []
  const root = resolve(localPath)
  const top = resolve(home)
  let dir = root
  for (;;) {
    const path = join(dir, 'REVIEW.md')
    if (dir === root) {
      searched.push(`origin/${defaultBranch}:REVIEW.md in ${root}`)
      try {
        const { stdout: text } = await pexec('git', ['-C', root, 'show', `origin/${defaultBranch}:REVIEW.md`], { encoding: 'utf8', timeout: 10_000, maxBuffer: 8 * 1024 * 1024 })
        if (text.trim()) files.push({ path, text, sha: sha(text), from: 'base-branch' })
      } catch { /* not on the base branch */ }
    } else {
      searched.push(path)
      if (existsSync(path)) {
        const text = readFileSync(path, 'utf8')
        if (text.trim()) files.push({ path, text, sha: sha(text), from: 'file' })
      }
    }
    if (dir === top || dir === dirname(dir) || !dir.startsWith(top)) break
    dir = dirname(dir)
  }
  return { files, searched }
}

// Same-repo issues the PR body points at: "#123" or a full issue URL of this repo.
export function referencedIssues(body: string, repo: string): number[] {
  const out = new Set<number>()
  const url = new RegExp(`github\\.com/${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/issues/(\\d+)`, 'gi')
  for (const m of body.matchAll(url)) out.add(Number(m[1]))
  for (const m of body.matchAll(/(?:^|[\s(])#(\d+)\b/g)) out.add(Number(m[1]))
  return [...out].filter((n) => n > 0).slice(0, 3)
}

async function requirementOf(repo: string, prNumber: number, src: PrReviewSources): Promise<ReviewContext['requirement']> {
  const issues = async (list: Array<{ repo: string; number: number }>) => (await Promise.all(list.slice(0, 3).map((x) => fetchIssueBody(x.repo, 'issue', x.number).then((i) => `${x.repo === repo ? '' : x.repo}#${x.number} ${i.title}\n\n${i.body}`).catch(() => '')))).filter(Boolean)
  const closing = await issues(src.closingIssues)
  if (closing.length) return { source: 'closing-issue', text: closing.join('\n\n---\n\n') }
  const refs = await issues(referencedIssues(src.body, repo).filter((n) => n !== prNumber).map((number) => ({ repo, number })))
  if (refs.length) return { source: 'referenced-issue', text: refs.join('\n\n---\n\n') }
  if (src.body.trim()) return { source: 'pr-body', text: src.body }
  if (src.commits.length) return { source: 'commits', text: src.commits.join('\n\n---\n\n') }
  return { source: 'none', text: '' }
}

export function memoryIndexFor(projectDirName: string | undefined, configDir = claudeConfigDir()): ReviewContext['memoryIndex'] {
  if (!projectDirName) return null
  const dir = join(configDir, 'projects', projectDirName, 'memory')
  const file = join(dir, 'MEMORY.md')
  if (!existsSync(file)) return null
  return { dir, text: readFileSync(file, 'utf8').slice(0, 12_000) }
}

// Other registered projects the rules mention (by clone path or owner/name); their remotes are fetched so the agent reads
// origin/<branch>, never a stale local checkout.
export async function otherReposFor(rules: RuleFile[], projects: Array<{ repo: string; localPath: string | null; defaultBranch: string }>, selfRepo: string): Promise<OtherRepo[]> {
  const text = rules.map((r) => r.text).join('\n')
  const named = (p: { repo: string; localPath: string | null }) => {
    const path = p.localPath!.replace(/\/+$/, '')
    const base = path.split('/').pop() ?? ''
    const word = base.length >= 4 && new RegExp(`(^|[^\\w./-])${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w./-])`).test(text) // a whole word, not part of a path
    return (path.length > 1 && text.includes(path)) || text.includes(p.repo) || word
  }
  const hits = projects.filter((p) => p.repo !== selfRepo && p.localPath && named(p))
  return Promise.all(hits.map(async (p) => {
    const fetched = await pexec('git', ['-C', p.localPath!, 'fetch', '--quiet', 'origin'], { timeout: 60_000 }).then(() => true, () => false)
    return { repo: p.repo, path: p.localPath!, defaultBranch: p.defaultBranch, fetched }
  }))
}

export async function gatherReviewContext(o: {
  repo: string
  prNumber: number
  localPath: string
  defaultBranch: string
  projectDirName?: string
  projects: Array<{ repo: string; localPath: string | null; defaultBranch: string }>
}): Promise<ReviewContext & { prTitle: string }> {
  const { files, searched } = await findReviewMd(o.localPath, o.defaultBranch)
  let src: PrReviewSources = { title: '', body: '', closingIssues: [], commits: [], checks: [] }
  let unavailable: string | undefined
  try { src = await fetchPrReviewSources(o.repo, o.prNumber) } catch (e) { unavailable = (e as Error).message }
  const [requirement, otherRepos] = await Promise.all([requirementOf(o.repo, o.prNumber, src), otherReposFor(files, o.projects, o.repo)])
  return { prTitle: src.title, reviewMd: files, searched, requirement, checks: src.checks, memoryIndex: memoryIndexFor(o.projectDirName), otherRepos, ...(unavailable ? { unavailable } : {}) }
}

export function buildContextDoc(c: ReviewContext & { repo: string; prNumber: number; prTitle: string; defaultBranch: string; instruction?: string | null }): string {
  const lines: string[] = [`# Review context for ${c.repo}#${c.prNumber}: ${c.prTitle}`, '']
  lines.push(`Read the change with \`git diff origin/${c.defaultBranch}...HEAD\` in the current directory (the PR branch).`, '')
  if (c.instruction?.trim()) lines.push('## What the reviewer asked for this pass', '', c.instruction.trim(), '')
  if (c.unavailable) lines.push('## Not available', '', `The requirement sources and CI checks could not be fetched (${c.unavailable}). Read the PR with \`gh pr view\` if you need them, and say what you could not check.`, '')
  const quote = (t: string) => t.trim().split('\n').map((l) => `> ${l}`).join('\n') // its own headings must not read as sections of this file
  lines.push(`## Requirement (source: ${c.requirement.source})`, '', c.requirement.text.trim() ? quote(c.requirement.text) : '(none found: no closing or referenced issue, empty PR body, no commit message)', '')
  lines.push('## CI checks', '')
  lines.push(...(c.checks.length ? c.checks.map((k) => `- ${k.name}: ${k.result}`) : ['(no checks reported for this PR)']), '')
  lines.push('## REVIEW.md (project review rules)', '')
  if (c.reviewMd.length) for (const r of c.reviewMd) lines.push(`### ${r.path}${r.from === 'base-branch' ? ' (as on the base branch)' : ''}`, '', r.text.trim(), '')
  else lines.push(`None. Searched: ${c.searched.join('; ')}.`, '')
  lines.push('## Project memory (leads only — confirm everything in the code; never quote it in a finding, it is private)', '')
  if (c.memoryIndex) lines.push(`Index of ${c.memoryIndex.dir} (open an entry with the Read tool when its title is relevant):`, '', c.memoryIndex.text.trim(), '')
  else lines.push('(no project memory)', '')
  if (c.otherRepos.length) {
    lines.push('## Other repositories named by the rules', '')
    for (const r of c.otherRepos) lines.push(`- ${r.repo} at ${r.path}: read with \`git -C ${r.path} show origin/${r.defaultBranch}:<path>\`${r.fetched ? '' : ' (fetch failed: the remote copy may be stale, say so)'}`)
    lines.push('')
  }
  return lines.join('\n')
}

export function contextDocPath(root: string, reviewId: string): string {
  return join(reviewHistoryDir(root, reviewId), 'review-context.md')
}

export function writeContextDoc(root: string, reviewId: string, doc: string): string {
  const path = contextDocPath(root, reviewId)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, doc, 'utf8')
  return path
}
