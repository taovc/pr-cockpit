import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const pexec = promisify(execFile)

// Posting checks the PR head the review saw against the one on GitHub; an unknown sha on either side is not a move.
export function headMoved(reviewed: string | null | undefined, current: string | null | undefined): boolean {
  return !!reviewed && !!current && reviewed !== current
}

// A re-review found an unposted finding fixed: it no longer goes out. A posted one stays ticked for the "Confirmed fixed" line.
export function fixedUncheck(old: { checked?: boolean | null; postedPostId?: string | null }, status: string): Record<string, unknown> | null {
  if (status !== 'fixed' || !old.checked || old.postedPostId) return null
  return { checked: false, checkedBy: null, checkedAt: null }
}

// "path:line" (a range or trailing text after the line is ignored); a bare path has no line.
export function parseLocation(location: string | null | undefined): { path: string; line: number | null } | null {
  const m = /^(.+?)(?::(\d+).*)?$/.exec(String(location ?? '').trim())
  return m?.[1] ? { path: m[1], line: m[2] ? Number(m[2]) : null } : null
}

export function pathOfLocation(location: string | null | undefined): string | null {
  return parseLocation(location)?.path ?? null
}

// Automation ticks a finding for posting unless a re-review already settled it before it was ever posted.
export function stillToPost(f: { postedPostId?: string | null }, latestRecheckResolved: boolean): boolean {
  return !!f.postedPostId || !latestRecheckResolved
}

// The newest commit on the PR's own line between the two heads that touched the file (commits merged in from the base
// are not the author's fix); null when the range or the path is unknown.
export async function fixingCommit(cwd: string, fromSha: string | null, toSha: string, path: string | null): Promise<string | null> {
  if (!fromSha || !path || fromSha === toSha) return null
  try {
    const { stdout } = await pexec('git', ['-C', cwd, 'log', '--first-parent', '-n', '1', '--format=%H', `${fromSha}..${toSha}`, '--', path], { encoding: 'utf8', timeout: 10_000 })
    return stdout.trim() || null
  } catch {
    return null
  }
}
