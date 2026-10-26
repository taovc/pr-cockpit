#!/usr/bin/env tsx
// Replay a golden set through the review pipeline and score it. Read-only: worktrees are throwaway, nothing is
// posted to GitHub, no git/gh write ever runs (the review family's read-only policy applies).
//
//   pnpm eval run --golden eval/golden/<name>.json [--project <id|name>] [--provider claude|codex]
//                 [--model a,b] [--effort high] [--skill-version <id> | --skill <id> | --methodology <file>]
//                 [--verify] [--lang en] [--db data/cockpit.db]
//
// One eval run per model in --model; reports land in eval/reports/<timestamp>-<name>-<model>.md.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { getDb, schema } from '../core/db/client'
import { goldenFromReviews, loadGolden } from '../core/eval/golden'
import { runEval } from '../core/eval/runner'
import { renderReport } from '../core/eval/report'
import { loadMethodology } from '../core/methodology'
import { projectDirNameFor } from '../core/host/options'
import { stopCodexServer } from '../core/codex/appServer'
import { precisionBySkillVersion } from '../core/metrics/queries'

function parseArgs(argv: string[]): { cmd: string; flags: Record<string, string | true> } {
  const [cmd = 'help', ...rest] = argv
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = rest[i + 1]
    if (next && !next.startsWith('--')) { flags[key] = next; i++ } else flags[key] = true
  }
  return { cmd, flags }
}

const { cmd, flags } = parseArgs(process.argv.slice(2))
const str = (k: string): string | undefined => (typeof flags[k] === 'string' ? (flags[k] as string) : undefined)

if (cmd === 'score-history') {
  const dbPath0 = str('db') || process.env.NUXT_DB_PATH || process.env.DB_PATH || resolve('data', 'cockpit.db')
  const d0 = getDb(dbPath0)
  const ref = str('project')
  const proj = ref ? (d0.select().from(schema.projects).all() as any[]).find((p) => p.id === ref || p.name === ref || p.slug === ref) : null
  if (ref && !proj) { process.stderr.write(`project not found: ${ref}\n`); process.exit(1) }
  const rows = precisionBySkillVersion(d0, { projectId: proj?.id ?? null, from: str('from') ?? null, to: str('to') ?? null }) as any[]
  process.stdout.write('skill · version | reviews | findings | human accepted | precision | cost/accepted\n')
  for (const r of rows) {
    const precision = r.findings ? (Number(r.human_accepted) / Number(r.findings)) : null
    const cpa = r.human_accepted && r.cost_usd != null ? Number(r.cost_usd) / Number(r.human_accepted) : null
    process.stdout.write(`${r.skill_name ?? '(default)'} · v${r.version ?? '-'} | ${r.reviews} | ${r.findings} | ${r.human_accepted} | ${precision == null ? '—' : `${(precision * 100).toFixed(0)}%`} | ${cpa == null ? '—' : `$${cpa.toFixed(3)}`}\n`)
  }
  process.exit(0)
}

if (cmd === 'golden-from-reviews') {
  const dbPath0 = str('db') || process.env.NUXT_DB_PATH || process.env.DB_PATH || resolve('data', 'cockpit.db')
  const d0 = getDb(dbPath0)
  const ref = str('project')
  const proj = ref ? (d0.select().from(schema.projects).all() as any[]).find((p) => p.id === ref || p.name === ref || p.slug === ref) : null
  if (!proj) { process.stderr.write('--project <id|name> is required\n'); process.exit(1) }
  const g = goldenFromReviews(d0, schema, proj, { limit: str('limit') ? Number(str('limit')) : undefined })
  if (!g.cases.length) { process.stderr.write('no review with human-accepted findings for this project\n'); process.exit(1) }
  const out = str('out') || resolve('eval', 'golden', `${g.name}.json`)
  mkdirSync(resolve(out, '..'), { recursive: true })
  writeFileSync(out, JSON.stringify(g, null, 2) + '\n')
  process.stdout.write(`${g.cases.length} case(s), ${g.cases.reduce((a, c) => a + c.labels.length, 0)} label(s) → ${out}\nReview the labels by hand before trusting the scores (accepted ≠ complete).\n`)
  process.exit(0)
}

if (cmd !== 'run') {
  process.stdout.write('usage: pnpm eval run --golden <file> … | pnpm eval score-history [--project <id|name>] [--from iso] [--to iso] | pnpm eval golden-from-reviews --project <id|name> [--out file] [--limit n]\n       pnpm eval run --golden <file> [--project <id|name>] [--provider claude|codex] [--model a,b] [--effort e] [--skill-version id | --skill id | --methodology file] [--verify] [--lang en] [--db path]\n')
  process.exit(cmd === 'help' ? 0 : 1)
}

const goldenPath = str('golden')
if (!goldenPath) { process.stderr.write('--golden is required\n'); process.exit(1) }
const golden = loadGolden(resolve(goldenPath))
const dbPath = str('db') || process.env.NUXT_DB_PATH || process.env.DB_PATH || resolve('data', 'cockpit.db')
const db = getDb(dbPath)

// Project: by id or name from the golden's projectId / --project; gives the local clone, provider defaults and skill.
const projectRef = str('project') || golden.projectId
const projects = db.select().from(schema.projects).all() as any[]
const project = projectRef ? projects.find((p) => p.id === projectRef || p.name === projectRef || p.slug === projectRef) : projects.find((p) => p.repo === golden.repo)
if (!project) { process.stderr.write(`project not found for ${projectRef ?? golden.repo}\n`); process.exit(1) }
if (!project.localPath || !existsSync(project.localPath)) { process.stderr.write(`project ${project.name} has no local clone path\n`); process.exit(1) }

const providerRaw = str('provider') || project.provider || 'claude'
if (providerRaw !== 'claude' && providerRaw !== 'codex') { process.stderr.write(`--provider must be claude or codex (got ${providerRaw})\n`); process.exit(1) }
const provider = providerRaw as 'claude' | 'codex'
const models = (str('model') || project.model || process.env[provider === 'codex' ? 'CODEX_MODEL' : 'ANTHROPIC_MODEL'] || '').split(',').map((s) => s.trim()).filter(Boolean)
if (!models.length) models.push('')
const effort = str('effort') || project.effort || undefined

// Methodology: explicit version / skill / file, else the project's active skill, else the built-in default.
let methodology = ''
let skillVersionId: string | null = null
if (str('skill-version')) {
  const v = db.select().from(schema.skillVersions).where(eq(schema.skillVersions.id, str('skill-version')!)).get() as any
  if (!v) { process.stderr.write('skill version not found\n'); process.exit(1) }
  methodology = v.content; skillVersionId = v.id
} else if (str('skill')) {
  const s = db.select().from(schema.skills).where(eq(schema.skills.id, str('skill')!)).get() as any
  if (!s) { process.stderr.write('skill not found\n'); process.exit(1) }
  methodology = s.content; skillVersionId = s.currentVersionId ?? null
} else if (str('methodology')) {
  methodology = readFileSync(resolve(str('methodology')!), 'utf8')
} else if (project.activeSkillId) {
  const s = db.select().from(schema.skills).where(eq(schema.skills.id, project.activeSkillId)).get() as any
  methodology = s?.content || loadMethodology(project); skillVersionId = s?.currentVersionId ?? null
} else {
  methodology = loadMethodology(project)
}

const reposDir = process.env.NUXT_REPOS_DIR || process.env.REPOS_DIR || resolve('data', 'repos')
const worktreeLocation = process.env.NUXT_WORKTREE_LOCATION || process.env.WORKTREE_LOCATION || 'repo'
const reportsDir = resolve('eval', 'reports')
mkdirSync(reportsDir, { recursive: true })
const log = (l: string) => process.stdout.write(`${l}\n`)

for (const model of models) {
  log(`▸ eval ${golden.name} · ${provider} ${model || '(default)'} ${effort || ''} · verify=${!!flags.verify} · ${golden.cases.length} case(s)`)
  const summary = await runEval({
    db, schema, golden, provider, model, effort, codexServiceTier: provider === 'codex' && project.codexServiceTier === 'fast' ? 'fast' : null,
    methodology, skillVersionId, projectId: project.id, verify: !!flags.verify,
    localPath: project.localPath, reposDir, worktreeLocation, lang: str('lang') || 'en',
    projectDirName: projectDirNameFor(project.localPath), onLog: log,
  })
  const file = resolve(reportsDir, `${summary.startedAt.replace(/[:.]/g, '-')}-${golden.name}-${(model || 'default').replace(/[^a-z0-9.-]/gi, '_')}${flags.verify ? '-verify' : ''}.md`)
  writeFileSync(file, renderReport(summary))
  db.update(schema.evalRuns).set({ reportPath: file }).where(eq(schema.evalRuns.id, summary.id)).run()
  log(`  precision ${fmt(summary.precision)} · recall ${fmt(summary.recall)} · F1 ${fmt(summary.f1)}${summary.verified ? ` · after verify F1 ${fmt(summary.verified.f1)}` : ''} · cost ${summary.costUsd == null ? '—' : `$${summary.costUsd.toFixed(3)}`}`)
  log(`  report: ${file}`)
}
stopCodexServer()

function fmt(v: number | null): string { return v == null ? '—' : `${(v * 100).toFixed(0)}%` }
