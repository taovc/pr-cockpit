import { sql } from 'drizzle-orm'
import { projectForPath } from '../runs/adopt'
import { STAGE_SUBKINDS_SQL } from '../runs/types'

// Inbox: everything that is waiting for the human. Pure read queries over the existing tables (injected db).
// (reviews.author_updated is only ever cleared in the DB — the "author pushed" signal is computed live per review — so there is no bucket for it here.)
export type InboxPrompt = { id: string; runId: string; kind: string; toolName: string | null; title: string | null; createdAt: string; sessionTitle: string | null; workspacePath: string | null; workspaceType: string | null; projectId: string | null; prNumber: number | null }
export type InboxReview = { reviewId: string; projectId: string; projectName: string; prNumber: number; title: string | null; status: string; updatedAt: string; findings: number; unchecked: number }
export type InboxError = { runId: string; subkind: string; error: string | null; endedAt: string | null; projectId: string | null; projectName: string | null; reviewId: string | null; prNumber: number | null; title: string | null; workspaceType: string | null; workspacePath: string | null }
export type InboxAutomation = { id: string; projectId: string; projectName: string | null; prNumber: number; ts: string; kind: string; message: string | null }
export type InboxOverview = {
  prompts: InboxPrompt[]
  drafts: InboxReview[]
  errors: InboxError[]
  automation: InboxAutomation[]
  counts: { prompts: number; drafts: number; errors: number; total: number }
}

function all<T>(db: any, query: string): T[] {
  return db.all(sql.raw(query)) as T[]
}

const REVIEW_COLS = `r.id AS reviewId, r.project_id AS projectId, p.name AS projectName, r.pr_number AS prNumber, r.title, r.status, r.updated_at AS updatedAt,
  (SELECT COUNT(*) FROM findings f WHERE f.review_id = r.id) AS findings,
  (SELECT COUNT(*) FROM findings f WHERE f.review_id = r.id AND f.checked = 0) AS unchecked`

export function inboxOverview(db: any, opts: { sinceIso: string }): InboxOverview {
  const since = opts.sinceIso.replace(/'/g, '')
  const prompts = all<InboxPrompt>(db, `
    SELECT q.id, q.run_id AS runId, q.kind, q.tool_name AS toolName, q.title, q.created_at AS createdAt,
      ru.title AS sessionTitle, ru.workspace_path AS workspacePath, ru.workspace_type AS workspaceType, ru.project_id AS projectId, ru.pr_number AS prNumber
    FROM permission_requests q
    LEFT JOIN runs ru ON ru.id = q.run_id
    WHERE q.status = 'pending'
    ORDER BY q.created_at ASC`)
  const drafts = all<InboxReview>(db, `
    SELECT ${REVIEW_COLS} FROM reviews r JOIN projects p ON p.id = r.project_id
    WHERE r.status = 'draft' AND r.author_updated = 0
      AND EXISTS (SELECT 1 FROM findings f WHERE f.review_id = r.id)
    ORDER BY r.updated_at DESC`)
  const errors = all<InboxError>(db, `
    SELECT ru.id AS runId, ru.subkind, ru.error, ru.ended_at AS endedAt, ru.project_id AS projectId, p.name AS projectName,
      ru.review_id AS reviewId, COALESCE(r.pr_number, ru.pr_number) AS prNumber, COALESCE(r.title, ru.title) AS title, ru.workspace_type AS workspaceType, ru.workspace_path AS workspacePath
    FROM runs ru
    LEFT JOIN projects p ON p.id = ru.project_id
    LEFT JOIN reviews r ON r.id = ru.review_id
    WHERE ru.status = 'error' AND ru.subkind NOT IN ${STAGE_SUBKINDS_SQL} AND COALESCE(ru.ended_at, ru.updated_at, ru.started_at) >= '${since}'
    ORDER BY COALESCE(ru.ended_at, ru.updated_at, ru.started_at) DESC
    LIMIT 50`)
  const automation = all<InboxAutomation>(db, `
    SELECT a.id, a.project_id AS projectId, p.name AS projectName, a.pr_number AS prNumber, a.ts, a.kind, a.message
    FROM automation_events a LEFT JOIN projects p ON p.id = a.project_id
    WHERE a.ts >= '${since}'
    ORDER BY a.ts DESC LIMIT 30`)
  // Directory sessions without a project (from before the assistant was project-scoped) are adopted by path, the same
  // rule as GET /api/runs — otherwise their rows have no project to open the drawer in.
  const projects = all<{ id: string; localPath: string | null; name: string | null }>(db, `SELECT id, local_path AS localPath, name FROM projects`)
  for (const x of prompts) if (!x.projectId && x.workspaceType === 'cwd') x.projectId = projectForPath(projects, x.workspacePath)
  for (const x of errors) if (!x.projectId && x.workspaceType === 'cwd') { x.projectId = projectForPath(projects, x.workspacePath); if (x.projectId) x.projectName = projects.find((p) => p.id === x.projectId)?.name ?? null }
  const counts = { prompts: prompts.length, drafts: drafts.length, errors: errors.length, total: 0 }
  counts.total = counts.prompts + counts.drafts + counts.errors
  return { prompts, drafts, errors, automation, counts }
}
