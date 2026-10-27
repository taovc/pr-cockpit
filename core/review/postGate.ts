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

export function pathOfLocation(location: string | null | undefined): string | null {
  const m = /^(.+?)(?::\d+.*)?$/.exec(String(location ?? '').trim())
  return m?.[1] || null
}

// The newest commit between the two heads that touched the file; null when the range or the path is unknown.
export async function fixingCommit(cwd: string, fromSha: string | null, toSha: string, path: string | null): Promise<string | null> {
  if (!fromSha || !path || fromSha === toSha) return null
  try {
    const { stdout } = await pexec('git', ['-C', cwd, 'log', '-n', '1', '--format=%H', `${fromSha}..${toSha}`, '--', path], { encoding: 'utf8', timeout: 10_000 })
    return stdout.trim() || null
  } catch {
    return null
  }
}
