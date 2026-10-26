import { createHash } from 'node:crypto'
import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import { prepareWorktree } from '../git/worktree'
import { selectReviewRunner } from '../pipeline'
import { runVerifyAgent, verdictMap, type VerifyVerdict } from '../agent/verify'
import { usageOfError } from '../agent/claudeRun'
import { createRun, finishRun, recordRunUsage } from '../runs/store'
import { judge, prf, type JudgedFinding } from './judge'
import type { Golden, GoldenCase } from './golden'
import type { ReviewProvider } from '../agent/runners'

// Replay a golden set: fixed PR heads → the review runner (read-only worktree, never posts, never git-writes) →
// path/title matching against the labels → precision / recall / F1, cost and duration, with and without the
// verify pass. Rows go to eval_runs / eval_cases / eval_findings; the caller renders the markdown report.

export type EvalOptions = {
  db: any
  schema: any
  golden: Golden
  provider: ReviewProvider
  model: string
  effort?: string
  codexServiceTier?: string | null
  methodology: string
  skillVersionId?: string | null
  projectId?: string | null
  verify: boolean
  localPath: string
  reposDir: string
  worktreeLocation?: string | null
  lang?: string
  mcp?: boolean
  chrome?: boolean
  projectDirName?: string
  onLog?: (line: string) => void
}

export type EvalCaseSummary = {
  id: string
  prNumber: number
  headSha: string
  status: 'done' | 'error'
  error: string | null
  tp: number
  fp: number
  fn: number
  costUsd: number | null
  durationMs: number
  missedLabelIds: string[]
  findings: Array<{ fid: string; severity: string; title: string; location: string | null; matchedLabelId: string | null; verifyStatus: VerifyVerdict | null }>
  verified: { tp: number; fp: number; fn: number } | null
}

export type EvalSummary = {
  id: string
  golden: Golden
  provider: ReviewProvider
  model: string
  effort?: string
  skillVersionId: string | null
  methodologySha: string
  verify: boolean
  startedAt: string
  endedAt: string
  cases: EvalCaseSummary[]
  tp: number
  fp: number
  fn: number
  precision: number | null
  recall: number | null
  f1: number | null
  verified: { tp: number; fp: number; fn: number; precision: number | null; recall: number | null; f1: number | null } | null
  verifyStats: { refutedFp: number; refutedTp: number; unsure: number; costUsd: number | null } | null
  costUsd: number | null
  durationMs: number
}

const now = () => new Date().toISOString()
const addCost = (a: number | null, b: number | null | undefined): number | null => (b == null ? a : (a ?? 0) + b)

export async function runEval(o: EvalOptions): Promise<EvalSummary> {
  const { db, schema } = o
  const id = nanoid()
  const startedAt = now()
  const t0 = Date.now()
  const methodologySha = createHash('sha256').update(o.methodology).digest('hex')
  const log = (l: string) => o.onLog?.(l)
  db.insert(schema.evalRuns).values({
    id, golden: o.golden.name, projectId: o.projectId ?? null, provider: o.provider, model: o.model || null, effort: o.effort || null,
    skillVersionId: o.skillVersionId ?? null, methodologySha, verify: o.verify, cases: o.golden.cases.length, status: 'running', createdAt: startedAt,
  }).run()

  const cases: EvalCaseSummary[] = []
  let verifyCost: number | null = null
  let refutedFp = 0
  let refutedTp = 0
  let unsure = 0
  for (const c of o.golden.cases) {
    const cs = await runCase(o, id, c, log)
    cases.push(cs)
    if (cs.verified) {
      for (const f of cs.findings) {
        if (f.verifyStatus === 'refuted') { if (f.matchedLabelId) refutedTp++; else refutedFp++ }
        else if (f.verifyStatus === 'unsure') unsure++
      }
    }
    verifyCost = addCost(verifyCost, cs.verifyCostUsd)
  }

  const tp = cases.reduce((a, c) => a + c.tp, 0)
  const fp = cases.reduce((a, c) => a + c.fp, 0)
  const fn = cases.reduce((a, c) => a + c.fn, 0)
  const costUsd = cases.reduce<number | null>((a, c) => addCost(a, c.costUsd), null)
  const verified = o.verify
    ? (() => { const v = { tp: cases.reduce((a, c) => a + (c.verified?.tp ?? c.tp), 0), fp: cases.reduce((a, c) => a + (c.verified?.fp ?? c.fp), 0), fn: cases.reduce((a, c) => a + (c.verified?.fn ?? c.fn), 0) }; return { ...v, ...prf(v.tp, v.fp, v.fn) } })()
    : null
  const endedAt = now()
  const summary: EvalSummary = {
    id, golden: o.golden, provider: o.provider, model: o.model, effort: o.effort, skillVersionId: o.skillVersionId ?? null, methodologySha, verify: o.verify,
    startedAt, endedAt, cases: cases.map(({ verifyCostUsd: _v, ...rest }) => rest as EvalCaseSummary), tp, fp, fn, ...prf(tp, fp, fn), verified,
    verifyStats: o.verify ? { refutedFp, refutedTp, unsure, costUsd: verifyCost } : null, costUsd, durationMs: Date.now() - t0,
  }
  db.update(schema.evalRuns).set({
    tp, fp, fn, precision: summary.precision, recall: summary.recall, f1: summary.f1,
    verifiedTp: verified?.tp ?? null, verifiedFp: verified?.fp ?? null, verifiedFn: verified?.fn ?? null,
    costUsd, durationMs: summary.durationMs, status: cases.every((c) => c.status === 'done') ? 'done' : 'partial', endedAt,
  }).where(eq(schema.evalRuns.id, id)).run()
  return summary
}

async function runCase(o: EvalOptions, evalRunId: string, c: GoldenCase, log: (l: string) => void): Promise<EvalCaseSummary & { verifyCostUsd: number | null }> {
  const { db, schema } = o
  const caseId = nanoid()
  const t0 = Date.now()
  db.insert(schema.evalCases).values({ id: caseId, evalRunId, prNumber: c.prNumber, headSha: c.headSha, status: 'running', createdAt: now() }).run()
  const base: EvalCaseSummary & { verifyCostUsd: number | null } = { id: caseId, prNumber: c.prNumber, headSha: c.headSha, status: 'done', error: null, tp: 0, fp: 0, fn: 0, costUsd: null, durationMs: 0, missedLabelIds: [], findings: [], verified: null, verifyCostUsd: null }
  let wt: Awaited<ReturnType<typeof prepareWorktree>> | null = null
  let runId: string | null = null
  const defaultBranch = c.baseBranch || o.golden.defaultBranch
  try {
    log(`PR #${c.prNumber} @ ${c.headSha.slice(0, 7)}: preparing worktree`)
    wt = await prepareWorktree({
      localPath: o.localPath, reposDir: o.reposDir, location: o.worktreeLocation, reviewId: `eval-${caseId}`, branch: c.branch, defaultBranch,
      checkoutSha: c.headSha, prNumber: c.prNumber, mergeDefault: false, onStep: (m) => log(`  ${m}`),
    })
    runId = createRun(db, schema, { kind: 'review', subkind: 'eval', provider: o.provider, projectId: o.projectId ?? null, workspaceType: 'pr_worktree', workspacePath: wt.path, prNumber: c.prNumber, branch: c.branch, model: o.model, effort: o.effort, codexServiceTier: o.codexServiceTier, skillVersionId: o.skillVersionId ?? null, lang: o.lang ?? null, title: `eval ${o.golden.name} #${c.prNumber}` })
    log(`  reviewing (${o.provider} ${o.model || 'default'})`)
    const r = await selectReviewRunner(o.provider).runReview({
      cwd: wt.path, repo: o.golden.repo, prNumber: c.prNumber, branch: c.branch, defaultBranch, methodology: o.methodology,
      model: o.model, effort: o.effort, codexServiceTier: o.codexServiceTier, lang: o.lang, mcp: o.mcp, chrome: o.chrome, projectDirName: o.projectDirName,
      onTool: (n, i) => log(`    ${n} ${i}`),
    })
    recordRunUsage(db, schema, runId, r.usage)
    finishRun(db, schema, runId, { status: 'done' })
    base.costUsd = r.usage?.costUsd ?? null
    const findings: JudgedFinding[] = r.result.findings.map((f, i) => ({ fid: `F${i + 1}`, severity: f.severity, title: f.title, location: f.location || null, problem: f.problem || null }))
    const j = judge(findings, c.labels)
    base.tp = j.tp; base.fp = j.fp; base.fn = j.fn; base.missedLabelIds = j.missedLabelIds
    const matched = new Map(j.matches.map((m) => [m.fid, m.labelId]))
    base.findings = findings.map((f) => ({ fid: f.fid, severity: f.severity, title: f.title, location: f.location, matchedLabelId: matched.get(f.fid) ?? null, verifyStatus: null }))
    log(`  ${findings.length} findings → TP ${j.tp} · FP ${j.fp} · FN ${j.fn}`)

    if (o.verify && findings.length) {
      log('  verify pass (trying to refute each finding)')
      const vRun = createRun(db, schema, { kind: 'review', subkind: 'verify', provider: o.provider, projectId: o.projectId ?? null, workspaceType: 'pr_worktree', workspacePath: wt.path, prNumber: c.prNumber, branch: c.branch, model: o.model, effort: o.effort, codexServiceTier: o.codexServiceTier, skillVersionId: o.skillVersionId ?? null, lang: o.lang ?? null, title: `eval verify ${o.golden.name} #${c.prNumber}` })
      try {
        const v = await runVerifyAgent({
          cwd: wt.path, repo: o.golden.repo, prNumber: c.prNumber, branch: c.branch, defaultBranch, provider: o.provider, model: o.model, effort: o.effort, codexServiceTier: o.codexServiceTier, lang: o.lang, methodology: o.methodology,
          findings: r.result.findings.map((f, i) => ({ fid: `F${i + 1}`, severity: f.severity, title: f.title, location: f.location || null, problem: f.problem || null, detail: f.detail || null })),
          mcp: o.mcp, chrome: o.chrome, projectDirName: o.projectDirName, onTool: (n, i) => log(`    ${n} ${i}`),
        })
        recordRunUsage(db, schema, vRun, v.usage)
        finishRun(db, schema, vRun, { status: 'done' })
        base.verifyCostUsd = v.usage?.costUsd ?? null
        const verdicts = verdictMap(v.result, findings.map((f) => f.fid))
        for (const f of base.findings) f.verifyStatus = verdicts.get(f.fid)?.verdict ?? 'unsure'
        // Metrics as if refuted findings had been dropped before posting.
        const kept = base.findings.filter((f) => f.verifyStatus !== 'refuted')
        const keptTp = kept.filter((f) => f.matchedLabelId).length
        // Only a refuted match to a must-find label becomes a miss; dropping an optional hit costs nothing.
        const mustFind = new Set(c.labels.filter((l) => l.mustFind).map((l) => l.id))
        const droppedTp = base.findings.filter((f) => f.verifyStatus === 'refuted' && f.matchedLabelId && mustFind.has(f.matchedLabelId)).length
        base.verified = { tp: keptTp, fp: kept.length - keptTp, fn: base.fn + droppedTp }
        log(`  after verify → TP ${base.verified.tp} · FP ${base.verified.fp} · FN ${base.verified.fn}`)
      } catch (e) {
        recordRunUsage(db, schema, vRun, usageOfError(e))
        finishRun(db, schema, vRun, { status: 'error', error: (e as Error).message })
        log(`  verify failed: ${(e as Error).message}`)
      }
    }
  } catch (e) {
    base.status = 'error'
    base.error = (e as Error).message
    if (runId) { recordRunUsage(db, schema, runId, usageOfError(e)); finishRun(db, schema, runId, { status: 'error', error: base.error }) }
    log(`  error: ${base.error}`)
  } finally {
    if (wt) await wt.cleanup().catch(() => {})
  }
  base.durationMs = Date.now() - t0
  db.update(schema.evalCases).set({ status: base.status, tp: base.tp, fp: base.fp, fn: base.fn, costUsd: base.costUsd, durationMs: base.durationMs, error: base.error }).where(eq(schema.evalCases.id, caseId)).run()
  for (const f of base.findings) {
    db.insert(schema.evalFindings).values({ id: nanoid(), evalCaseId: caseId, fid: f.fid, severity: f.severity, title: f.title, location: f.location, matchedLabelId: f.matchedLabelId, verifyStatus: f.verifyStatus, createdAt: now() }).run()
  }
  return base
}
