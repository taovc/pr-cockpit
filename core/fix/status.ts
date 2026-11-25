// Deciding a fix task's "next status": unuploaded changes (dirty locally or ahead of the remote) → ready; otherwise stay pushed, or fall back to open.
// This rule used to be written twice, in core/fix/pipeline.ts and server/api/fixes/[id].get.ts, which drifts easily — extracted into a single source.
export function computeFixNextStatus(args: {
  dirty: boolean
  ahead: boolean
  currentStatus?: string | null
}): 'ready' | 'pushed' | 'open' {
  if (args.dirty || args.ahead) return 'ready'
  return args.currentStatus === 'pushed' ? 'pushed' : 'open'
}

// Startup recovery of an upload that was cut off (busy_action = pushing): it landed only when the worktree is clean and
// its HEAD is what origin/<branch> points at. Uncommitted changes mean the cut came before the commit (the pre-upload
// check or the commit message), so HEAD still equals the remote without anything having been pushed.
export function interruptedPushLanded(a: { localHead: string | null; remoteHead: string | null; dirty: boolean | null }): boolean {
  return a.dirty === false && !!a.localHead && !!a.remoteHead && a.localHead === a.remoteHead
}
