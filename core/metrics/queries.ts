import { sql } from 'drizzle-orm'
import { loadCodexRates } from '../runs/pricing'
import { STAGE_SUBKINDS_SQL } from '../runs/types'

// Pure read-side queries for the dashboard. db/schema are injected (same convention as core/automation/*),
// so the same code runs against the real SQLite and the in-memory test DB. Everything here is plain SQL over
// the runs / run_usage / findings / finding_rechecks / automation tables — no extra store.

export type MetricsFilter = { projectId?: string | null; from?: string | null; to?: string | null }

function where(f: MetricsFilter, col: { project: string; ts: string }) {
  const parts: string[] = []
  const args: unknown[] = []
  if (f.projectId) { parts.push(`${col.project} = ?`); args.push(f.projectId) }
  if (f.from) { parts.push(`${col.ts} >= ?`); args.push(f.from) }
  if (f.to) { parts.push(`${col.ts} <= ?`); args.push(f.to) }
  return { clause: parts.length ? `WHERE ${parts.join(' AND ')}` : '', args }
}

function all<T = any>(db: any, query: string, args: unknown[] = []): T[] {
  // drizzle's better-sqlite3 driver exposes the raw connection through the session; fall back to db.all for the sql`` path.
  const raw = db?.$client ?? db?.session?.client
  if (raw?.prepare) return raw.prepare(query).all(...args) as T[]
  return db.all(sql.raw(query)) as T[]
}

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))
  return s[idx]!
}

// Runs grouped by subkind × provider: how many, what they cost, how many tokens.
export function runsBySubkind(db: any, f: MetricsFilter = {}) {
  const w = where(f, { project: 'project_id', ts: 'created_at' })
  return all(db, `
    SELECT subkind, provider,
           COUNT(*) AS runs,
           SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
           SUM(cost_usd) AS cost_usd,
           SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced,
           SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
           SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_create_tokens) AS cache_create_tokens
    FROM runs ${w.clause ? w.clause + ' AND' : 'WHERE'} subkind NOT IN ${STAGE_SUBKINDS_SQL}
    GROUP BY subkind, provider
    ORDER BY subkind, provider`, w.args)
}

// Review-family runs by model × effort: count, cost avg, duration p50/p95 (percentiles computed in JS — SQLite has none).
export function reviewRunsByModel(db: any, f: MetricsFilter = {}) {
  const w = where(f, { project: 'project_id', ts: 'created_at' })
  const rows = all<{ provider: string; model: string | null; effort: string | null; cost_usd: number | null; duration_ms: number; status: string }>(db, `
    SELECT provider, model, effort, cost_usd, duration_ms, status
    FROM runs ${w.clause ? w.clause + ' AND' : 'WHERE'} kind = 'review' AND subkind IN ('review', 'guided', 'recheck')`, w.args)
  const groups = new Map<string, { provider: string; model: string | null; effort: string | null; runs: number; errors: number; costs: number[]; durations: number[] }>()
  for (const r of rows) {
    const key = `${r.provider}|${r.model ?? ''}|${r.effort ?? ''}`
    const g = groups.get(key) ?? { provider: r.provider, model: r.model, effort: r.effort, runs: 0, errors: 0, costs: [], durations: [] }
    g.runs++
    if (r.status === 'error') g.errors++
    if (r.cost_usd != null) g.costs.push(r.cost_usd)
    if (r.duration_ms) g.durations.push(r.duration_ms)
    groups.set(key, g)
  }
  return [...groups.values()].map((g) => ({
    provider: g.provider, model: g.model, effort: g.effort, runs: g.runs, errors: g.errors,
    avgCostUsd: g.costs.length ? g.costs.reduce((a, b) => a + b, 0) / g.costs.length : null,
    p50CostUsd: percentile(g.costs, 50),
    p50DurationMs: percentile(g.durations, 50),
    p95DurationMs: percentile(g.durations, 95),
  })).sort((a, b) => b.runs - a.runs)
}

// Precision per skill version. Only TRIAGED reviews count — ones where a human made at least one decision or a
// comment was posted; a draft nobody looked at says nothing about the skill. A finding is "accepted" when it was
// posted to GitHub, or a human ticked it (auto/engine ticks excluded; a NULL provenance = pre-upgrade human tick).
// Cost = every run of those reviews inside the same filter window, per human-accepted finding.
export function precisionBySkillVersion(db: any, f: MetricsFilter = {}) {
  const w = where(f, { project: 'r.project_id', ts: 'r.created_at' })
  const triaged = `(EXISTS (SELECT 1 FROM findings fx WHERE fx.review_id = r.id AND (fx.posted_post_id IS NOT NULL OR fx.human_accepted_at IS NOT NULL OR fx.checked_by = 'human'))
                    OR EXISTS (SELECT 1 FROM posts px WHERE px.review_id = r.id))`
  const costWhere = where(f, { project: 'r2.project_id', ts: 'r2.created_at' })
  return all(db, `
    SELECT r.skill_version_id AS skill_version_id,
           sv.version AS version, COALESCE(s.name, sv.skill_name) AS skill_name, sv.skill_id AS skill_id,
           COUNT(DISTINCT r.id) AS reviews,
           COUNT(fd.id) AS findings,
           SUM(CASE WHEN fd.posted_post_id IS NOT NULL OR fd.human_accepted_at IS NOT NULL THEN 1 ELSE 0 END) AS human_accepted,
           SUM(CASE WHEN fd.posted_post_id IS NULL AND fd.checked = 1 AND fd.checked_by IN ('auto', 'engine') THEN 1 ELSE 0 END) AS machine_checked,
           SUM(CASE WHEN fd.posted_post_id IS NOT NULL THEN 1 ELSE 0 END) AS posted,
           (SELECT SUM(ru.cost_usd) FROM runs ru JOIN reviews r2 ON r2.id = ru.review_id
              ${costWhere.clause ? costWhere.clause + ' AND' : 'WHERE'} ru.subkind NOT IN ${STAGE_SUBKINDS_SQL} AND r2.skill_version_id IS r.skill_version_id AND ${triaged.replace(/\br\./g, 'r2.')}) AS cost_usd
    FROM reviews r
    LEFT JOIN findings fd ON fd.review_id = r.id AND COALESCE(fd.source, '') <> 'human' AND NOT (fd.source IS NOT NULL AND fd.tier IS NULL AND fd.verify_status = 'refuted') -- what the AI presented as holding
    LEFT JOIN skill_versions sv ON sv.id = r.skill_version_id
    LEFT JOIN skills s ON s.id = sv.skill_id
    ${w.clause ? w.clause + ' AND' : 'WHERE'} ${triaged}
    GROUP BY r.skill_version_id
    ORDER BY reviews DESC`, [...costWhere.args, ...w.args])
    .map((row: any) => ({
      ...row,
      precision: row.findings ? row.human_accepted / row.findings : null,
      costPerAccepted: row.human_accepted && row.cost_usd != null ? row.cost_usd / row.human_accepted : null,
    }))
}

// Recheck outcomes: the most recent recheck entry per finding (by timestamp, not MAX(round) — round numbers were once
// counted separately per path and can repeat within one finding), bucketed on both axes.
// `status` is what the AUTHOR did; `stance` is what we think. Rows written before the split carry a stance word in
// `status` and no `stance`, so the stance axis falls back to it.
const STANCE_WORDS = new Set(['kept', 'retracted', 'adjusted', 'discuss'])

export function recheckFunnel(db: any, f: MetricsFilter = {}) {
  const w = where(f, { project: 'r.project_id', ts: 'r.created_at' })
  const rows = all<{ status: string; stance: string | null; n: number }>(db, `
    WITH latest AS (
      SELECT fr.finding_id, MAX(fr.at) AS at FROM finding_rechecks fr GROUP BY fr.finding_id
    )
    SELECT fr.status AS status, fr.stance AS stance, COUNT(DISTINCT fr.finding_id) AS n
    FROM finding_rechecks fr
    JOIN latest l ON l.finding_id = fr.finding_id AND l.at = fr.at
    JOIN findings fd ON fd.id = fr.finding_id
    JOIN reviews r ON r.id = fd.review_id
    ${w.clause}
    GROUP BY fr.status, fr.stance`, w.args)
  const by: Record<string, number> = {}
  const byStance: Record<string, number> = {}
  for (const r of rows) {
    const n = Number(r.n)
    by[r.status] = (by[r.status] ?? 0) + n
    const stance = r.stance ?? (STANCE_WORDS.has(r.status) ? r.status : null)
    if (stance) byStance[stance] = (byStance[stance] ?? 0) + n
  }
  // Every round now records a stance, so this denominator is "findings whose last round expressed a position" —
  // which since the split is all of them, not just the ones a feedback round touched. Numbers either side of the
  // split are therefore not comparable, and the older ones read high because only feedback rounds counted then.
  const stanced = Object.values(byStance).reduce((a, b) => a + b, 0)
  const authorRound = (by.fixed ?? 0) + (by.partial ?? 0) + (by.unaddressed ?? 0) + (by.replied ?? 0) + (by.new ?? 0)
  return {
    byStatus: by,
    byStance,
    retractionRate: stanced ? (byStance.retracted ?? 0) / stanced : null,
    fixedRate: authorRound ? (by.fixed ?? 0) / authorRound : null,
  }
}

// What the automation engine did: counts per event kind.
export function automationFunnel(db: any, f: MetricsFilter = {}) {
  const w = where(f, { project: 'project_id', ts: 'ts' })
  const rows = all<{ kind: string; n: number }>(db, `SELECT kind, COUNT(*) AS n FROM automation_events ${w.clause} GROUP BY kind`, w.args)
  const by: Record<string, number> = {}
  for (const r of rows) by[r.kind] = Number(r.n)
  return by
}

// Cost per day (all runs), for the trend table.
export function costByDay(db: any, f: MetricsFilter = {}, days = 30) {
  const w = where(f, { project: 'project_id', ts: 'created_at' })
  return all(db, `
    SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS runs, SUM(cost_usd) AS cost_usd,
           SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens
    FROM runs ${w.clause ? w.clause + ' AND' : 'WHERE'} subkind NOT IN ${STAGE_SUBKINDS_SQL}
    GROUP BY day ORDER BY day DESC LIMIT ?`, [...w.args, days])
}

// One page of runs, newest first (limit/offset); countRuns gives the total for the pager.
export function recentRuns(db: any, f: MetricsFilter = {}, page: { limit?: number; offset?: number } = {}) {
  const limit = page.limit ?? 30
  const offset = page.offset ?? 0
  const w = where(f, { project: 'r.project_id', ts: 'r.created_at' })
  return all(db, `
    SELECT r.id, r.kind, r.subkind, r.provider, r.model, r.effort, r.status, r.cost_usd, r.cost_source, r.unpriced_turns,
           r.input_tokens, r.output_tokens, r.num_turns, r.duration_ms, r.pr_number, r.title, r.created_at, r.error,
           p.name AS project_name, sv.version AS skill_version
    FROM runs r
    LEFT JOIN projects p ON p.id = r.project_id
    LEFT JOIN skill_versions sv ON sv.id = r.skill_version_id
    ${w.clause}
    ORDER BY r.created_at DESC LIMIT ? OFFSET ?`, [...w.args, limit, offset])
}

export function countRuns(db: any, f: MetricsFilter = {}): number {
  const w = where(f, { project: 'project_id', ts: 'created_at' })
  return Number(all<{ n: number }>(db, `SELECT COUNT(*) AS n FROM runs ${w.clause}`, w.args)[0]?.n ?? 0)
}

export function metricsOverview(db: any, f: MetricsFilter = {}) {
  const rates = loadCodexRates()
  return {
    filter: f,
    runsBySubkind: runsBySubkind(db, f),
    reviewRunsByModel: reviewRunsByModel(db, f),
    precisionBySkillVersion: precisionBySkillVersion(db, f),
    recheck: recheckFunnel(db, f),
    automation: automationFunnel(db, f),
    costByDay: costByDay(db, f),
    pricing: { codexRatesAsOf: rates.asOf, codexModelsPriced: Object.keys(rates.rates).length },
  }
}
