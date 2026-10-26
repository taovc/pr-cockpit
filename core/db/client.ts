import { migrateLegacyRuns } from '../runs/migrate'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import * as schema from './schema'

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null

export function getDb(dbPath: string) {
  if (_db) return _db

  const dir = dirname(dbPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')

  _db = drizzle(sqlite, { schema })

  // MVP: create the tables with CREATE TABLE IF NOT EXISTS, no formal migrations
  ensureSchema(sqlite)
  ensureColumns(sqlite)
  migrateLegacyRuns(sqlite)
  backfillSkillVersions(sqlite)
  backfillLegacyRunCosts(sqlite)
  // Reviews no longer connect MCP; drop the retired switches.
  sqlite.prepare(`DELETE FROM meta WHERE key IN ('agent.reviewMcp', 'agent.reviewMcpAllow')`).run()
  return _db
}

// One-off: reviews finished before the runs table existed only left their cost inside the Chinese "done" event
// string ("审核完成 · $1.364"). Turn each of those into a run row (cost only — model/effort/tokens are unknown,
// so they stay null) so the dashboard starts with history. Guarded by a meta key → runs exactly once.
function backfillLegacyRunCosts(sqlite: Database.Database) {
  const KEY = 'legacy_run_cost_backfill_v1'
  try {
    if (sqlite.prepare(`SELECT value FROM meta WHERE key = ?`).get(KEY)) return
    const events = sqlite.prepare(`
      SELECT e.id, e.review_id, e.ts, e.message, r.project_id, r.pr_number, r.branch, r.title, p.provider
      FROM events e JOIN reviews r ON r.id = e.review_id LEFT JOIN projects p ON p.id = r.project_id
      WHERE e.kind = 'done' AND e.message LIKE '%$%'`).all() as
      { id: string; review_id: string; ts: string; message: string; project_id: string; pr_number: number; branch: string | null; title: string | null; provider: string | null }[]
    const fixes = sqlite.prepare(`SELECT f.id, f.project_id, f.pr_number, f.branch, f.title, f.cost_usd, f.created_at, f.updated_at, f.worktree_path, p.provider
      FROM fixes f LEFT JOIN projects p ON p.id = f.project_id WHERE f.cost_usd IS NOT NULL AND f.cost_usd > 0`).all() as
      { id: string; project_id: string; pr_number: number; branch: string; title: string | null; cost_usd: number; created_at: string; updated_at: string; worktree_path: string | null; provider: string | null }[]
    const insert = sqlite.prepare(`INSERT OR IGNORE INTO runs (id, kind, subkind, project_id, review_id, workspace_type, workspace_path, pr_number, branch, provider, status, title, cost_usd, cost_source, created_at, started_at, ended_at, updated_at)
      VALUES (?, 'review', ?, ?, ?, 'pr_worktree', NULL, ?, ?, ?, 'done', ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE 'reported' END, ?, ?, ?, ?)`)
    const insertFix = sqlite.prepare(`INSERT OR IGNORE INTO runs (id, kind, subkind, project_id, review_id, workspace_type, workspace_path, pr_number, branch, provider, status, title, cost_usd, cost_source, created_at, started_at, ended_at, updated_at)
      VALUES (?, 'session', 'session', ?, NULL, 'pr_worktree', ?, ?, ?, ?, 'idle', ?, ?, 'reported', ?, ?, ?, ?)`)
    const tx = sqlite.transaction(() => {
      for (const e of events) {
        const m = /\$(\d+(?:\.\d+)?)/.exec(e.message || '')
        if (!m) continue
        const subkind = /^复审/.test(e.message) ? 'guided' : 'review'
        // Codex reviews used to log a hard-coded "$0.000": that is an unknown cost, not a free run → NULL, never 0.
        const cost = Number(m[1])
        insert.run(`legacy-${e.id}`, subkind, e.project_id, e.review_id, e.pr_number, e.branch, e.provider === 'codex' ? 'codex' : 'claude', e.title, cost > 0 ? cost : null, cost > 0 ? cost : null, e.ts, e.ts, e.ts, e.ts)
      }
      for (const f of fixes) {
        insertFix.run(f.id, f.project_id, f.worktree_path, f.pr_number, f.branch, f.provider === 'codex' ? 'codex' : 'claude', f.title, f.cost_usd, f.created_at, f.created_at, f.updated_at, f.updated_at)
      }
      // Ticks made before check provenance existed were human decisions (the drawer's auto-adjust also existed, but a
      // NULL provenance must not read as "machine" and zero out precision).
      sqlite.exec(`UPDATE findings SET checked_by = 'human' WHERE checked = 1 AND checked_by IS NULL`)
      sqlite.exec(`UPDATE findings SET human_accepted_at = COALESCE(checked_at, created_at) WHERE human_accepted_at IS NULL AND (posted_post_id IS NOT NULL OR (checked = 1 AND checked_by = 'human'))`)
      sqlite.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).run(KEY, new Date().toISOString())
    })
    tx()
  } catch { /* best effort: a DB that predates the events table simply has no history to backfill */ }
}

// Every skill gets an immutable version-1 snapshot of its current content (skills created before versioning
// existed). Idempotent: only rows with current_version_id IS NULL are touched, so later startups are no-ops.
function backfillSkillVersions(sqlite: Database.Database) {
  try {
    const rows = sqlite.prepare(`SELECT id, name, content, source, created_at FROM skills WHERE current_version_id IS NULL`).all() as
      { id: string; name: string; content: string; source: string; created_at: string }[]
    if (!rows.length) return
    const insert = sqlite.prepare(`INSERT INTO skill_versions (id, skill_id, skill_name, version, content, content_sha, source, created_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)`)
    const link = sqlite.prepare(`UPDATE skills SET current_version_id = ? WHERE id = ?`)
    const tx = sqlite.transaction(() => {
      for (const r of rows) {
        const id = randomBytes(12).toString('base64url')
        insert.run(id, r.id, r.name, r.content, createHash('sha256').update(r.content).digest('hex'), r.source || 'manual', r.created_at)
        link.run(id, r.id)
      }
    })
    tx()
  } catch { /* an old DB missing the tables is created by ensureSchema first; ignore */ }
}

// Add missing columns to existing old tables (CREATE IF NOT EXISTS won't alter a table that already exists)
function ensureColumns(sqlite: Database.Database) {
  const adds: Array<[string, string, string]> = [
    ['reviews', 'author', 'TEXT'],
    ['reviews', 'review_instruction', 'TEXT'],
    ['projects', 'active_skill_id', 'TEXT'],
    ['projects', 'provider', "TEXT NOT NULL DEFAULT 'claude'"],
    ['projects', 'model', 'TEXT'],
    ['projects', 'effort', 'TEXT'],
    ['projects', 'codex_service_tier', 'TEXT'],
    ['projects', 'auto_max_rounds', 'INTEGER NOT NULL DEFAULT 2'],
    ['projects', 'auto_cooldown_minutes', 'INTEGER NOT NULL DEFAULT 5'],
    ['pr_automation', 'head_seen_sha', 'TEXT'],
    ['pr_automation', 'head_seen_at', 'TEXT'],
    ['reviews', 'preview_json', 'TEXT'],
    ['reviews', 'preview_sig', 'TEXT'],
    ['reviews', 'author_updated', 'INTEGER NOT NULL DEFAULT 0'],
    ['reviews', 'review_decision', 'TEXT'],
    // fixes: old tables were created with CREATE IF NOT EXISTS — add the columns M1 missed + the ones M2 added
    ['fixes', 'pr_author', 'TEXT'],
    ['fixes', 'title', 'TEXT'],
    ['fixes', 'instruction', 'TEXT'],
    ['fixes', 'lang', "TEXT NOT NULL DEFAULT 'en'"],
    ['fixes', 'summary', 'TEXT'],
    ['fixes', 'session_id', 'TEXT'],
    ['fixes', 'codex_session_id', 'TEXT'],
    ['fixes', 'last_upload_at', 'TEXT'],
    ['fixes', 'base_ref', 'TEXT'],
    ['fixes', 'last_push_sha', 'TEXT'],
    ['fixes', 'last_action_kind', 'TEXT'],
    ['fixes', 'reviews_at_push', 'INTEGER'],
    // the assistant (global) stores effort per session (symmetric with model/provider); add the column to old DBs
    ['global_sessions', 'effort', 'TEXT'],
    // observability (phase 0): skill versioning + run attribution + human-vs-machine check provenance
    ['skills', 'current_version_id', 'TEXT'],
    ['reviews', 'last_run_id', 'TEXT'],
    ['reviews', 'skill_version_id', 'TEXT'],
    ['findings', 'checked_by', 'TEXT'],
    // the re-review's second dimension (what we think) alongside `status` (what the author did)
    ['finding_rechecks', 'stance', 'TEXT'],
    ['finding_rechecks', 'stance_reason', 'TEXT'],
    ['findings', 'checked_at', 'TEXT'],
    ['findings', 'posted_post_id', 'TEXT'],
    ['findings', 'human_accepted_at', 'TEXT'],
    ['skill_versions', 'skill_name', 'TEXT'],
    ['runs', 'unpriced_turns', 'INTEGER NOT NULL DEFAULT 0'],
    // session host (phase 1): runs created by phase 0 predate these columns
    ['runs', 'permission_mode', 'TEXT'],
    ['runs', 'allow_danger', 'INTEGER NOT NULL DEFAULT 0'],
    ['runs', 'network_access', 'INTEGER NOT NULL DEFAULT 0'],
    ['runs', 'allow_rules', 'TEXT'],
    // verify-before-post (phase 5)
    ['projects', 'verify_before_post', 'INTEGER NOT NULL DEFAULT 0'],
    ['findings', 'verify_status', 'TEXT'],
    ['findings', 'verify_note', 'TEXT'],
    // unified session runs (phase 3): workspace state that used to live on fixes / feature_tasks / global_sessions
    ['runs', 'description', 'TEXT'],
    ['runs', 'base_branch', 'TEXT'],
    ['runs', 'base_head_sha', 'TEXT'],
    ['runs', 'fix_head_sha', 'TEXT'],
    ['runs', 'last_push_sha', 'TEXT'],
    ['runs', 'pushed_at', 'TEXT'],
    ['runs', 'reviews_at_push', 'INTEGER'],
    ['runs', 'pr_url', 'TEXT'],
    ['runs', 'pr_author', 'TEXT'],
    ['runs', 'upload_state', "TEXT NOT NULL DEFAULT 'none'"],
    ['runs', 'busy_action', 'TEXT'],
    ['runs', 'forked_from', 'TEXT'],
    ['runs', 'cli_version', 'TEXT'],
    ['runs', 'review_rules', 'TEXT'],
    ['findings', 'tier', 'TEXT'],
    ['findings', 'evidence', 'TEXT'],
    ['findings', 'source', 'TEXT'],
    ['findings', 'rating', 'TEXT'],
    ['findings', 'rated_at', 'TEXT'],
    ['reviews', 'not_done', 'TEXT'],
    ['reviews', 'review_md_suggestion', 'TEXT'],
    ['reviews', 'pipeline_meta', 'TEXT'],
    ['projects', 'review_engine_level', "TEXT NOT NULL DEFAULT 'high'"],
    ['run_turns', 'message_uuid', 'TEXT'],
  ]
  for (const [table, col, type] of adds) {
    const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    if (!cols.some((c) => c.name === col)) {
      sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`)
    }
  }
  // Existing pushed tasks: backfill last_push_sha = fix_head_sha (treat them as uploaded so the refactor doesn't wrongly show "upload changes")
  try {
    sqlite.exec(`UPDATE fixes SET last_push_sha = fix_head_sha, last_action_kind = 'pushed'
                 WHERE pushed_at IS NOT NULL AND last_push_sha IS NULL AND fix_head_sha IS NOT NULL`)
  } catch { /* ignore when an old DB lacks those columns */ }
  // Chat-only version: normalize legacy statuses onto the new enum (old DBs may hold queued/validating/awaiting/fixing/ready/merging/conflict).
  // After the first normalization the old values are gone, so every later startup is a no-op.
  try {
    // First mark merging/conflict (which may have left a half-finished merge) as error to warn the user; any other legacy value outside the new enum falls back to open.
    sqlite.exec(`UPDATE fixes SET status = 'error' WHERE status IN ('merging','conflict')`)
    sqlite.exec(`UPDATE fixes SET status = 'open'  WHERE status NOT IN ('open','ready','pushing','pushed','error','discarded')`)
  } catch { /* ignore */ }
  // feature single-phase: normalize the two-phase legacy statuses onto the new enum. First preserve rows that already opened a PR
  // (old built + pr_url also counts as opened), then map the remaining legacy statuses (analyzing/planned/building/built) to working; opened/error are left alone.
  try {
    sqlite.exec(`UPDATE feature_tasks SET status = 'opened' WHERE pr_url IS NOT NULL AND status NOT IN ('working','awaiting','opened','error')`)
    sqlite.exec(`UPDATE feature_tasks SET status = 'working' WHERE status NOT IN ('working','awaiting','opened','error')`)
  } catch { /* ignore when an old DB lacks that table */ }
}

function ensureSchema(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      repo TEXT NOT NULL,
      local_path TEXT,
      methodology_ref TEXT,
      methodology_md TEXT,
      active_skill_id TEXT,
      provider TEXT NOT NULL DEFAULT 'claude',
      model TEXT,
      effort TEXT,
      codex_service_tier TEXT,
      auto_max_rounds INTEGER NOT NULL DEFAULT 2,
      auto_cooldown_minutes INTEGER NOT NULL DEFAULT 5,
      default_branch TEXT NOT NULL DEFAULT 'dev',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS skills_project_idx ON skills(project_id);

    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      pr_number INTEGER NOT NULL,
      pr_url TEXT NOT NULL,
      title TEXT,
      author TEXT,
      branch TEXT,
      head_sha TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      pr_state TEXT NOT NULL DEFAULT 'unknown',
      additions INTEGER,
      deletions INTEGER,
      changed_files INTEGER,
      logic TEXT, quality TEXT, risk TEXT, conclusion TEXT,
      requirement TEXT, test_path TEXT, global_notes TEXT, review_instruction TEXT,
      last_post_sha TEXT,
      last_post_url TEXT,
      author_updated INTEGER NOT NULL DEFAULT 0,
      review_decision TEXT,
      preview_json TEXT,
      preview_sig TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS reviews_project_idx ON reviews(project_id);
    CREATE UNIQUE INDEX IF NOT EXISTS reviews_project_pr_uq ON reviews(project_id, pr_number);

    CREATE TABLE IF NOT EXISTS findings (
      id TEXT PRIMARY KEY,
      review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      fid TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      location TEXT,
      problem TEXT,
      detail TEXT,
      fix TEXT,
      introduced_by_pr INTEGER NOT NULL DEFAULT 1,
      checked INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS findings_review_idx ON findings(review_id);

    CREATE TABLE IF NOT EXISTS finding_rechecks (
      id TEXT PRIMARY KEY,
      finding_id TEXT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
      round INTEGER NOT NULL,
      status TEXT NOT NULL,
      text TEXT,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS rechecks_finding_idx ON finding_rechecks(finding_id);

    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      round INTEGER NOT NULL,
      url TEXT,
      sha TEXT,
      mode TEXT NOT NULL,
      body TEXT,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS posts_review_idx ON posts(review_id);

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      ts TEXT NOT NULL,
      kind TEXT NOT NULL,
      message TEXT
    );
    CREATE INDEX IF NOT EXISTS events_review_idx ON events(review_id);

    CREATE TABLE IF NOT EXISTS fixes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      pr_number INTEGER NOT NULL,
      branch TEXT NOT NULL,
      pr_author TEXT,
      title TEXT,
      instruction TEXT,
      lang TEXT NOT NULL DEFAULT 'en',
      status TEXT NOT NULL DEFAULT 'open',
      stage TEXT,
      summary TEXT,
      worktree_path TEXT,
      base_ref TEXT,
      base_head_sha TEXT,
      fix_head_sha TEXT,
      last_push_sha TEXT,
      last_action_kind TEXT,
      reviews_at_push INTEGER,
      files_changed INTEGER,
      additions INTEGER,
      deletions INTEGER,
      session_id TEXT,
      codex_session_id TEXT,
      last_upload_at TEXT,
      cost_usd REAL,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      pushed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS fixes_project_pr_idx ON fixes(project_id, pr_number);

    CREATE TABLE IF NOT EXISTS fix_turns (
      id TEXT PRIMARY KEY,
      fix_id TEXT NOT NULL REFERENCES fixes(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'done',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS fix_turns_fix_idx ON fix_turns(fix_id);

    CREATE TABLE IF NOT EXISTS fix_events (
      id TEXT PRIMARY KEY,
      fix_id TEXT NOT NULL REFERENCES fixes(id) ON DELETE CASCADE,
      ts TEXT NOT NULL,
      kind TEXT NOT NULL,
      message TEXT
    );
    CREATE INDEX IF NOT EXISTS fix_events_fix_idx ON fix_events(fix_id);

    CREATE TABLE IF NOT EXISTS global_sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      provider TEXT NOT NULL DEFAULT 'claude',
      model TEXT,
      effort TEXT,
      cwd TEXT,
      session_id TEXT,
      codex_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      error TEXT,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS global_sessions_last_used_idx ON global_sessions(last_used_at);

    CREATE TABLE IF NOT EXISTS global_turns (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES global_sessions(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'done',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS global_turns_session_idx ON global_turns(session_id);

    CREATE TABLE IF NOT EXISTS feature_tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT,
      description TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'claude',
      model TEXT,
      lang TEXT NOT NULL DEFAULT 'en',
      status TEXT NOT NULL DEFAULT 'working',
      plan_json TEXT,
      decisions TEXT,
      base_branch TEXT,
      branch TEXT,
      worktree_path TEXT,
      base_head_sha TEXT,
      pr_number INTEGER,
      pr_url TEXT,
      session_id TEXT,
      codex_session_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS feature_tasks_project_idx ON feature_tasks(project_id);

    CREATE TABLE IF NOT EXISTS feature_turns (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES feature_tasks(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'done',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS feature_turns_task_idx ON feature_turns(task_id);

    CREATE TABLE IF NOT EXISTS feature_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES feature_tasks(id) ON DELETE CASCADE,
      ts TEXT NOT NULL,
      kind TEXT NOT NULL,
      message TEXT
    );
    CREATE INDEX IF NOT EXISTS feature_events_task_idx ON feature_events(task_id);

    CREATE TABLE IF NOT EXISTS project_automation (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      master_enabled INTEGER NOT NULL DEFAULT 0,
      review_enabled INTEGER NOT NULL DEFAULT 0,
      review_mode TEXT NOT NULL DEFAULT 'once',
      review_authors TEXT NOT NULL DEFAULT '[]',
      review_statuses TEXT NOT NULL DEFAULT '["open"]',
      fix_enabled INTEGER NOT NULL DEFAULT 0,
      fix_authors TEXT NOT NULL DEFAULT '[]',
      fix_statuses TEXT NOT NULL DEFAULT '["open"]',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pr_automation (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      pr_number INTEGER NOT NULL,
      review_on INTEGER,
      fix_on INTEGER,
      round INTEGER NOT NULL DEFAULT 0,
      last_fix_review_sha TEXT,
      pending_fix INTEGER NOT NULL DEFAULT 0,
      opt_out INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      head_seen_sha TEXT,
      head_seen_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pr_automation_project_idx ON pr_automation(project_id);
    CREATE UNIQUE INDEX IF NOT EXISTS pr_automation_project_pr_uq ON pr_automation(project_id, pr_number);

    CREATE TABLE IF NOT EXISTS automation_events (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      pr_number INTEGER NOT NULL,
      ts TEXT NOT NULL,
      kind TEXT NOT NULL,
      message TEXT
    );
    CREATE INDEX IF NOT EXISTS automation_events_pr_idx ON automation_events(project_id, pr_number);

    CREATE TABLE IF NOT EXISTS skill_versions (
      id TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL,
      skill_name TEXT,
      version INTEGER NOT NULL,
      content TEXT NOT NULL,
      content_sha TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS skill_versions_skill_idx ON skill_versions(skill_id, version);

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      subkind TEXT NOT NULL,
      project_id TEXT,
      review_id TEXT,
      workspace_type TEXT,
      workspace_path TEXT,
      pr_number INTEGER,
      branch TEXT,
      provider TEXT NOT NULL,
      model TEXT,
      effort TEXT,
      codex_service_tier TEXT,
      skill_id TEXT,
      skill_version_id TEXT,
      claude_session_id TEXT,
      codex_thread_id TEXT,
      permission_mode TEXT,
      allow_danger INTEGER NOT NULL DEFAULT 0,
      network_access INTEGER NOT NULL DEFAULT 0,
      allow_rules TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      title TEXT,
      lang TEXT,
      error TEXT,
      cost_usd REAL,
      cost_source TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_create_tokens INTEGER NOT NULL DEFAULT 0,
      num_turns INTEGER NOT NULL DEFAULT 0,
      unpriced_turns INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS runs_project_idx ON runs(project_id, created_at);
    CREATE INDEX IF NOT EXISTS runs_review_idx ON runs(review_id);
    CREATE INDEX IF NOT EXISTS runs_kind_status_idx ON runs(kind, status);

    CREATE TABLE IF NOT EXISTS run_usage (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      turn_id TEXT,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_create_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL,
      cost_source TEXT,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS run_usage_run_idx ON run_usage(run_id);

    CREATE TABLE IF NOT EXISTS run_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      turn_id TEXT,
      ts TEXT NOT NULL,
      kind TEXT NOT NULL,
      message TEXT,
      data TEXT,
      tool_use_id TEXT
    );
    CREATE INDEX IF NOT EXISTS run_events_run_seq_idx ON run_events(run_id, seq);

    CREATE TABLE IF NOT EXISTS permission_requests (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      turn_id TEXT,
      tool_use_id TEXT,
      provider_request_id TEXT,
      kind TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      input TEXT,
      suggestions TEXT,
      title TEXT,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      answer TEXT,
      always INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS permission_requests_run_idx ON permission_requests(run_id);
    CREATE INDEX IF NOT EXISTS permission_requests_status_idx ON permission_requests(status);

    CREATE TABLE IF NOT EXISTS run_turns (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'done',
      created_at TEXT NOT NULL,
      ended_at TEXT
    );
    CREATE INDEX IF NOT EXISTS run_turns_run_seq_idx ON run_turns(run_id, seq);

    CREATE TABLE IF NOT EXISTS eval_runs (
      id TEXT PRIMARY KEY,
      golden TEXT NOT NULL,
      project_id TEXT,
      provider TEXT NOT NULL,
      model TEXT,
      effort TEXT,
      skill_version_id TEXT,
      methodology_sha TEXT NOT NULL,
      verify INTEGER NOT NULL DEFAULT 0,
      cases INTEGER NOT NULL DEFAULT 0,
      tp INTEGER, fp INTEGER, fn INTEGER,
      precision REAL, recall REAL, f1 REAL,
      verified_tp INTEGER, verified_fp INTEGER, verified_fn INTEGER,
      cost_usd REAL,
      duration_ms INTEGER,
      report_path TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      created_at TEXT NOT NULL,
      ended_at TEXT
    );
    CREATE TABLE IF NOT EXISTS eval_cases (
      id TEXT PRIMARY KEY,
      eval_run_id TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
      pr_number INTEGER NOT NULL,
      head_sha TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      tp INTEGER, fp INTEGER, fn INTEGER,
      cost_usd REAL,
      duration_ms INTEGER,
      error TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS eval_findings (
      id TEXT PRIMARY KEY,
      eval_case_id TEXT NOT NULL REFERENCES eval_cases(id) ON DELETE CASCADE,
      fid TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      location TEXT,
      matched_label_id TEXT,
      verify_status TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS eval_cases_run_idx ON eval_cases(eval_run_id);
    CREATE INDEX IF NOT EXISTS eval_findings_case_idx ON eval_findings(eval_case_id);

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS finding_labels (
      id TEXT PRIMARY KEY,
      review_id TEXT NOT NULL,
      head_sha TEXT,
      fid TEXT NOT NULL,
      severity TEXT,
      title TEXT NOT NULL,
      location TEXT,
      problem TEXT,
      tier TEXT,
      verify_status TEXT,
      source TEXT,
      rating TEXT,
      rated_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS finding_labels_review_idx ON finding_labels(review_id);

    CREATE TABLE IF NOT EXISTS review_rule_files (
      sha TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `)
}

export { schema }
