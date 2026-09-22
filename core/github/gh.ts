import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import os from 'node:os'

const pexec = promisify(execFile)

// The gh binary: PATH first, then the usual install directories — a LaunchAgent / Electron process often starts with a
// minimal PATH that lacks /opt/homebrew/bin (same fallback the claude and codex binaries get).
let _gh: string | null = null
export function ghBin(): string {
  if (_gh) return _gh
  const dirs = (process.env.PATH || '').split(delimiter).concat(['/opt/homebrew/bin', '/usr/local/bin', join(os.homedir(), '.local', 'bin')])
  for (const d of dirs) {
    if (!d) continue
    const p = join(d, process.platform === 'win32' ? 'gh.exe' : 'gh')
    if (existsSync(p)) return (_gh = p)
  }
  return (_gh = 'gh')
}

export class GhError extends Error {
  constructor(
    message: string,
    readonly stderr?: string,
  ) {
    super(message)
    this.name = 'GhError'
  }
}

// Single entry point for the locally logged-in gh CLI (inherits the user's GitHub auth).
// timeoutMs: optional, for calls that run inside a review's 'posting' claim window (e.g. fetchPrDiff) — a gh call hanging forever would pin the row permanently.
// No timeout by default (long paginated pulls with --paginate/--slurp shouldn't be cut off).
async function gh(args: string[], timeoutMs?: number): Promise<string> {
  try {
    const { stdout } = await pexec(ghBin(), args, { maxBuffer: 1024 * 1024 * 32, ...(timeoutMs ? { timeout: timeoutMs } : {}) })
    return stdout
  } catch (e: any) {
    const stderr = e?.stderr?.toString?.() ?? ''
    if (e?.code === 'ENOENT') {
      throw new GhError('未找到 gh CLI，请先安装并 `gh auth login`', stderr)
    }
    throw new GhError(`gh ${args.join(' ')} 失败: ${stderr || e?.message}`, stderr)
  }
}

export type PrMeta = {
  number: number
  title: string
  url: string
  branch: string
  headSha: string
  state: 'open' | 'merged' | 'closed' | 'draft' | 'unknown'
  additions: number
  deletions: number
  changedFiles: number
  isDraft: boolean
  body: string
  author: string
  baseBranch: string // the PR's target branch (base); merged in when resolving conflicts
}

const PR_FIELDS = [
  'number',
  'title',
  'url',
  'headRefName',
  'headRefOid',
  'baseRefName',
  'state',
  'additions',
  'deletions',
  'changedFiles',
  'isDraft',
  'body',
  'author',
].join(',')

function normState(raw: string, isDraft: boolean): PrMeta['state'] {
  const s = (raw || '').toUpperCase()
  if (s === 'MERGED') return 'merged'
  if (s === 'CLOSED') return 'closed'
  if (s === 'OPEN') return isDraft ? 'draft' : 'open'
  return 'unknown'
}

export async function fetchPrMeta(repo: string, prNumber: number): Promise<PrMeta> {
  const out = await gh(['pr', 'view', String(prNumber), '--repo', repo, '--json', PR_FIELDS])
  const j = JSON.parse(out)
  return {
    number: j.number,
    title: j.title ?? '',
    url: j.url ?? '',
    branch: j.headRefName ?? '',
    headSha: j.headRefOid ?? '',
    state: normState(j.state, !!j.isDraft),
    additions: j.additions ?? 0,
    deletions: j.deletions ?? 0,
    changedFiles: j.changedFiles ?? 0,
    isDraft: !!j.isDraft,
    body: j.body ?? '',
    author: j.author?.login ?? '',
    baseBranch: j.baseRefName ?? '',
  }
}

// State + head only (lightweight, used by the refresh button)
export async function fetchPrState(
  repo: string,
  prNumber: number,
): Promise<{ state: PrMeta['state']; headSha: string; reviewDecision: string; author: string }> {
  const out = await gh([
    'pr',
    'view',
    String(prNumber),
    '--repo',
    repo,
    '--json',
    'state,isDraft,headRefOid,reviewDecision,author',
  ])
  const j = JSON.parse(out)
  return { state: normState(j.state, !!j.isDraft), headSha: j.headRefOid ?? '', reviewDecision: j.reviewDecision ?? '', author: j.author?.login ?? '' }
}

// Look up the PR already created for a branch. In feature development, once the agent commits/pushes/opens a PR itself,
// the backend uses this to sync state (status=opened + prUrl/prNumber) — it catches the PR whether it was opened by the "open PR" button or casually from the chat.
export async function findPrByBranch(repo: string, branch: string): Promise<{ url: string; number: number } | null> {
  try {
    const out = await gh(['pr', 'list', '--repo', repo, '--head', branch, '--state', 'all', '--json', 'url,number', '--limit', '1'])
    const first = (JSON.parse(out.trim() || '[]') as Array<{ url?: string; number?: number }>)[0]
    if (first?.url) return { url: String(first.url), number: Number(first.number) || 0 }
  } catch { /* no PR created / gh failed → treat as not opened yet */ }
  return null
}

// Fetch an issue's / PR's title + body (when a feature task is given an issue/PR link, the body is fed to the read-only agent;
// the agent has no network access and can't download images, so the backend fetches both the body and its images first and hands them over).
export async function fetchIssueBody(repo: string, kind: 'issue' | 'pr', number: number): Promise<{ title: string; body: string }> {
  const out = await gh([kind === 'pr' ? 'pr' : 'issue', 'view', String(number), '--repo', repo, '--json', 'title,body'])
  const j = JSON.parse(out)
  return { title: j.title ?? '', body: j.body ?? '' }
}

// The current gh login token (for the backend image proxy: images in private-repo comments need the token to be fetched)
let _ghToken: string | null = null
export async function ghToken(): Promise<string> {
  if (_ghToken != null) return _ghToken
  try { _ghToken = (await gh(['auth', 'token'])).trim() } catch { _ghToken = '' }
  return _ghToken
}

// Whether the PR merges cleanly into its target branch (auto-review adds a "resolve merge conflicts" item based on this).
// GitHub computes mergeable asynchronously: right after a push it can briefly be UNKNOWN → report it as "unknown" rather than raising a false alarm.
export async function fetchPrMergeable(repo: string, prNumber: number): Promise<'mergeable' | 'conflicting' | 'unknown'> {
  try {
    const out = await gh(['pr', 'view', String(prNumber), '--repo', repo, '--json', 'mergeable'])
    const m = String(JSON.parse(out)?.mergeable || '').toUpperCase()
    if (m === 'CONFLICTING') return 'conflicting'
    if (m === 'MERGEABLE') return 'mergeable'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

// Total number of reviews currently submitted on the PR (baseline for "review updated": recorded on push, a higher count later = a reviewer reviewed again)
export async function fetchReviewsCount(repo: string, prNumber: number): Promise<number> {
  const [owner, name] = repo.split('/')
  const q = `query($owner:String!,$name:String!,$pr:Int!){ repository(owner:$owner,name:$name){ pullRequest(number:$pr){ reviews{ totalCount } } } }`
  const out = await gh(['api', 'graphql', '-f', `query=${q}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `pr=${prNumber}`])
  return JSON.parse(out)?.data?.repository?.pullRequest?.reviews?.totalCount ?? 0
}

export type PrDetail = {
  number: number
  title: string
  body: string
  author: string
  createdAt: string
  state: PrMeta['state']
  reviewDecision: string // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | '' (GitHub's aggregate)
  branch: string
  headSha: string
  additions: number
  deletions: number
  changedFiles: number
  url: string
  files: { path: string; additions: number; deletions: number }[]
  commits: { oid: string; headline: string; date: string; author: string }[]
}

const DETAIL_FIELDS = [
  'number', 'title', 'body', 'author', 'createdAt', 'state', 'isDraft', 'reviewDecision', 'headRefName', 'headRefOid',
  'additions', 'deletions', 'changedFiles', 'url', 'files', 'commits',
].join(',')

// GitHub keeps at most one PENDING review per person per PR, and a leftover one makes the next submission fail with
// 422. Any PENDING in the response is necessarily ours (other people's pending reviews are not returned), so posting a
// review clears it first. Best effort: a failure here is not fatal, the submission that follows reports what matters.
// Only the review-posting path (core/github/post.ts) may call this. A review a person is still writing on github.com is
// PENDING too and indistinguishable from ours, so approvePr reports the clash instead — silently deleting someone's
// unsubmitted line comments is not a self-heal.
export async function clearOwnPendingReview(repo: string, prNumber: number): Promise<void> {
  try {
    const out = await gh(['api', `repos/${repo}/pulls/${prNumber}/reviews`, '--paginate', '--slurp'], 30_000)
    for (const r of (JSON.parse(out) as any[][]).flat()) {
      if (r?.state === 'PENDING') await gh(['api', `repos/${repo}/pulls/${prNumber}/reviews/${r.id}`, '--method', 'DELETE'], 30_000).catch(() => {})
    }
  } catch {
    /* see above */
  }
}

// GitHub's wording when a pending review of yours blocks a new submission; the caller turns it into a sentence.
export function isPendingReviewClash(detail: string): boolean {
  return /one pending review per pull request/i.test(detail)
}

// Approve a PR as the logged-in gh user. No body: the drawer's button is an approval, not a comment — the review
// comment has its own path (core/github/post.ts). GitHub approves whatever is at the head when this lands, which is
// what clicking Approve on github.com does too.
export async function approvePr(repo: string, prNumber: number): Promise<{ url: string }> {
  const out = await gh(['api', `repos/${repo}/pulls/${prNumber}/reviews`, '--method', 'POST', '-f', 'event=APPROVE'], 60_000)
  const res = JSON.parse(out)
  return { url: res?.html_url || res?._links?.html?.href || '' }
}

export async function fetchPrDetail(repo: string, prNumber: number): Promise<PrDetail> {
  const out = await gh(['pr', 'view', String(prNumber), '--repo', repo, '--json', DETAIL_FIELDS])
  const j = JSON.parse(out)
  return {
    number: j.number,
    title: j.title ?? '',
    body: j.body ?? '',
    author: j.author?.login ?? j.author?.name ?? 'unknown',
    createdAt: j.createdAt ?? '',
    state: normState(j.state, !!j.isDraft),
    reviewDecision: String(j.reviewDecision ?? ''),
    branch: j.headRefName ?? '',
    headSha: j.headRefOid ?? '',
    additions: j.additions ?? 0,
    deletions: j.deletions ?? 0,
    changedFiles: j.changedFiles ?? 0,
    url: j.url ?? '',
    files: (j.files ?? []).map((f: any) => ({
      path: f.path,
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
    })),
    commits: (j.commits ?? []).map((c: any) => ({
      oid: (c.oid ?? '').slice(0, 7),
      headline: c.messageHeadline ?? '',
      date: c.authoredDate ?? c.committedDate ?? '',
      author: c.authors?.[0]?.login ?? c.authors?.[0]?.name ?? '',
    })),
  }
}

export type TimelineNode = {
  kind: 'comment' | 'review' | 'commit' | 'event'
  actor: string
  isBot: boolean
  at: string
  body?: string
  state?: string // review: approved/changes_requested/commented/dismissed
  sha?: string
  message?: string
  verb?: string // event type
  detail?: string // extra event info (label name / rename / cross-reference, etc.)
}

// PR timeline: comments / reviews / commits / labels / deployments, matching the line GitHub shows on the main page.
export async function fetchTimeline(repo: string, prNumber: number): Promise<TimelineNode[]> {
  const out = await gh([
    'api',
    '-H',
    'Accept: application/vnd.github+json',
    `repos/${repo}/issues/${prNumber}/timeline?per_page=100`,
  ])
  const arr = JSON.parse(out) as any[]
  const actorOf = (e: any) =>
    e.user?.login || e.actor?.login || e.author?.name || e.author?.login || ''
  const botOf = (e: any) => {
    const login = e.user?.login || e.actor?.login || ''
    return e.user?.type === 'Bot' || /\[bot\]$/i.test(login)
  }

  const nodes: TimelineNode[] = []
  for (const e of arr) {
    switch (e.event) {
      case 'commented':
        nodes.push({ kind: 'comment', actor: actorOf(e), isBot: botOf(e), at: e.created_at, body: e.body ?? '' })
        break
      case 'reviewed':
        nodes.push({ kind: 'review', actor: actorOf(e), isBot: botOf(e), at: e.submitted_at, body: e.body ?? '', state: e.state })
        break
      case 'committed':
        nodes.push({
          kind: 'commit',
          actor: e.author?.name ?? e.committer?.name ?? '',
          isBot: false,
          at: e.author?.date ?? e.committer?.date ?? '',
          sha: (e.sha ?? '').slice(0, 7),
          message: (e.message ?? '').split('\n')[0],
        })
        break
      case 'labeled':
      case 'unlabeled':
        nodes.push({ kind: 'event', actor: actorOf(e), isBot: botOf(e), at: e.created_at, verb: e.event, detail: e.label?.name })
        break
      case 'renamed':
        nodes.push({ kind: 'event', actor: actorOf(e), isBot: botOf(e), at: e.created_at, verb: 'renamed', detail: `${e.rename?.from} → ${e.rename?.to}` })
        break
      case 'cross-referenced':
        nodes.push({ kind: 'event', actor: e.actor?.login ?? '', isBot: botOf(e), at: e.created_at, verb: 'referenced', detail: e.source?.issue?.title })
        break
      case 'head_ref_force_pushed':
      case 'head_ref_deleted':
      case 'head_ref_restored':
      case 'closed':
      case 'merged':
      case 'reopened':
      case 'ready_for_review':
      case 'convert_to_draft':
      case 'review_requested':
      case 'review_request_removed':
      case 'assigned':
      case 'unassigned':
      case 'deployed':
      case 'milestoned':
        nodes.push({ kind: 'event', actor: actorOf(e), isBot: botOf(e), at: e.created_at, verb: e.event })
        break
      default:
        // Keep a line for unknown events too, so nothing gets lost
        if (e.event && e.created_at) {
          nodes.push({ kind: 'event', actor: actorOf(e), isBot: botOf(e), at: e.created_at, verb: e.event })
        }
    }
  }
  return nodes
}

const MAX_DIFF = 400_000 // truncate huge diffs so they don't bog down the drawer
export async function fetchPrDiff(repo: string, prNumber: number): Promise<{ diff: string; truncated: boolean }> {
  // 60s timeout: when posting comments this runs inside the review's 'posting' window, and a hanging gh must not pin the row at 'posting' forever (timeout → throw → the endpoint restores).
  const out = await gh(['pr', 'diff', String(prNumber), '--repo', repo], 60_000)
  if (out.length > MAX_DIFF) return { diff: out.slice(0, MAX_DIFF), truncated: true }
  return { diff: out, truncated: false }
}

export type ReviewComment = {
  id: number
  path: string
  line: number | null
  body: string
  author: string
  isBot: boolean
  inReplyToId: number | null
  createdAt: string
}

// The PR's inline review comments (the timeline doesn't include these). The "fix" flow uses them as verification and reply anchors.
// With multiple pages, --paginate outputs "[...][...]" (invalid JSON) → --slurp wraps it into an array of pages, then flat.
export async function fetchReviewComments(repo: string, prNumber: number): Promise<ReviewComment[]> {
  const out = await gh(['api', `repos/${repo}/pulls/${prNumber}/comments`, '--paginate', '--slurp'])
  const arr = (JSON.parse(out) as any[][]).flat()
  return arr.map((c) => ({
    id: c.id,
    path: c.path ?? '',
    line: c.line ?? c.original_line ?? null,
    body: c.body ?? '',
    author: c.user?.login ?? '',
    isBot: c.user?.type === 'Bot' || /\[bot\]$/i.test(c.user?.login ?? ''),
    inReplyToId: c.in_reply_to_id ?? null,
    createdAt: c.created_at ?? '',
  }))
}

// The currently logged-in user (shown by /api/me, used to exclude your own comments from "review updated", etc.).
// Process-level cache: after `gh auth switch` the service must be restarted to pick up the change (acceptable for a single-user local tool).
let _login: string | null = null
export async function getCurrentUserLogin(): Promise<string> {
  if (_login) return _login
  _login = (await gh(['api', 'user', '--jq', '.login'])).trim()
  return _login
}

export type PullListItem = {
  number: number
  title: string
  author: string
  branch: string
  headSha: string
  state: PrMeta['state']
  isDraft: boolean
  reviewDecision: string // APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED / ''
  reviewsCount: number // number of reviews submitted on GitHub (from any source) → drives the "reviewed" tag in the list
  updatedAt: string
  additions: number
  deletions: number
}

export type PullPage = {
  pulls: PullListItem[]
  totalCount: number
  hasNextPage: boolean
  endCursor: string | null
}

const GQL_STATE: Record<string, string> = { open: 'OPEN', merged: 'MERGED', closed: 'CLOSED' }

// Fetch PRs with GraphQL cursor pagination (states match the tab exactly, ordered by update time descending).
export async function listPulls(
  repo: string,
  state: 'open' | 'closed' | 'merged' | 'all' = 'open',
  first = 20,
  after: string | null = null,
): Promise<PullPage> {
  const [owner, name] = repo.split('/')
  const statesArg = GQL_STATE[state] ? `, states: [${GQL_STATE[state]}]` : ''
  const q = `query($owner:String!,$name:String!,$first:Int!,$after:String){
    repository(owner:$owner,name:$name){
      pullRequests(first:$first${statesArg}, after:$after, orderBy:{field:UPDATED_AT,direction:DESC}){
        totalCount
        pageInfo{ hasNextPage endCursor }
        nodes{ number title author{login} headRefName headRefOid isDraft state reviewDecision additions deletions updatedAt reviews(first:1){ totalCount } }
      }
    }
  }`
  const args = ['api', 'graphql', '-f', `query=${q}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `first=${first}`]
  if (after) args.push('-f', `after=${after}`)
  const out = await gh(args)
  const pr = JSON.parse(out).data.repository.pullRequests
  return {
    pulls: (pr.nodes as any[]).map((j) => ({
      number: j.number,
      title: j.title ?? '',
      author: j.author?.login ?? 'unknown',
      branch: j.headRefName ?? '',
      headSha: j.headRefOid ?? '',
      state: normState(j.state, !!j.isDraft),
      isDraft: !!j.isDraft,
      reviewDecision: j.reviewDecision ?? '',
      reviewsCount: j.reviews?.totalCount ?? 0,
      updatedAt: j.updatedAt ?? '',
      additions: j.additions ?? 0,
      deletions: j.deletions ?? 0,
    })),
    totalCount: pr.totalCount,
    hasNextPage: pr.pageInfo.hasNextPage,
    endCursor: pr.pageInfo.endCursor ?? null,
  }
}

// Confirm gh is available and logged in
export async function ghStatus(): Promise<{ ok: boolean; detail: string }> {
  try {
    const out = await gh(['auth', 'status'])
    return { ok: true, detail: out.trim() }
  } catch (e) {
    return { ok: false, detail: (e as Error).message }
  }
}
