import type { ProviderUsage, ReviewStage } from '../runs/types'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { buildContextDoc, gatherReviewContext, writeContextDoc, type RuleFile } from './context'
import { runEngine, type EngineLevel } from './engine'
import { runCheck, runContextPass, runTier, type TierResult } from './agents'
import { assembleFindings, fromContext, fromEngine, type FindingRow, type RawFinding, type VerdictValue } from './assemble'

// The scope-review pipeline: code-gathered context → engine ∥ project-context pass → independent check → tiers.
// Each stage runs through `stage`, which the caller turns into a runs row (usage recorded even when it fails).

export type StageRunner = <T extends { usage: ProviderUsage | null }>(subkind: ReviewStage, fn: () => Promise<T>) => Promise<T>

export type ScopeReviewOptions = {
  cwd: string
  repo: string
  prNumber: number
  defaultBranch: string
  localPath: string
  projectDirName?: string
  projects: Array<{ repo: string; localPath: string | null; defaultBranch: string }>
  model?: string
  level: EngineLevel
  lang?: string
  instruction?: string | null
  historyRoot: string
  reviewId: string
  abort?: AbortController
  onTool?: (name: string, info: string) => void
  emit: (message: string) => void
  stage: StageRunner
}

export type ScopeReviewResult = {
  rows: FindingRow[]
  conclusion: string
  notDone: string
  reviewMdSuggestion: string
  reviewMd: RuleFile[]
  meta: { engineLevel: EngineLevel; engineOk: boolean; reviewMd: string[] }
}

const errMsg = (e: unknown) => (e as Error)?.message ?? String(e)

export async function runScopeReview(o: ScopeReviewOptions): Promise<ScopeReviewResult> {
  const agent = { cwd: o.cwd, model: o.model, projectDirName: o.projectDirName, abort: o.abort, onTool: o.onTool }

  o.emit('收集上下文：REVIEW.md、需求原意、CI、项目记忆')
  const ctx = await gatherReviewContext({ repo: o.repo, prNumber: o.prNumber, localPath: o.localPath, defaultBranch: o.defaultBranch, projectDirName: o.projectDirName, projects: o.projects })
  const contextPath = writeContextDoc(o.historyRoot, o.reviewId, buildContextDoc({ ...ctx, repo: o.repo, prNumber: o.prNumber, defaultBranch: o.defaultBranch, instruction: o.instruction }))
  o.emit(`上下文已备好（REVIEW.md ${ctx.reviewMd.length} 份 · 需求来源 ${ctx.requirement.source} · CI ${ctx.checks.length} 项）：${contextPath}`)

  o.emit(`并行：引擎 /code-review ${o.level} + 项目视角`)
  const [engine, context] = await Promise.allSettled([
    o.stage('engine', () => runEngine({ cwd: o.cwd, prNumber: o.prNumber, defaultBranch: o.defaultBranch, level: o.level, model: o.model, instruction: o.instruction, projectDirName: o.projectDirName, abort: o.abort, onTool: o.onTool })),
    o.stage('context', () => runContextPass({ ...agent, contextPath, baseBranch: o.defaultBranch, correctnessLens: false })),
  ])
  if (o.abort?.signal.aborted) throw new Error('aborted')
  const engineOk = engine.status === 'fulfilled'
  // Keep the engine's own report next to the context file, so a thin or failed engine pass can be read afterwards.
  try {
    const report = engineOk ? `${engine.value.text}\n\n---\n\n${JSON.stringify(engine.value.findings, null, 2)}\n\n---\n\n${engine.value.trace.join('\n')}` : `ENGINE FAILED: ${errMsg(engine.reason)}`
    writeFileSync(join(dirname(contextPath), 'engine-report.md'), report, 'utf8')
  } catch { /* the report file is only for reading later */ }
  let contextFindings = context.status === 'fulfilled' ? context.value.result.findings : []
  if (!engineOk) {
    o.emit(`引擎失败（${errMsg((engine as PromiseRejectedResult).reason)}），项目视角补一轮正确性视角`)
    const fallback = await o.stage('context', () => runContextPass({ ...agent, contextPath, baseBranch: o.defaultBranch, correctnessLens: true }))
    contextFindings = [...contextFindings, ...fallback.result.findings]
  }
  if (context.status === 'rejected') {
    if (!engineOk) throw new Error(`引擎和项目视角都失败：${errMsg(context.reason)}`)
    o.emit(`项目视角失败（${errMsg(context.reason)}），只用引擎的结果`)
  }
  const raw: RawFinding[] = [...(engineOk ? fromEngine(engine.value.findings) : []), ...fromContext(contextFindings)]
  o.emit(`发现 ${raw.length} 条（引擎 ${raw.filter((f) => f.source === 'engine').length} · 项目视角 ${raw.filter((f) => f.source === 'context').length}），开始核对`)

  const { rows, tier } = await classifyFindings({ ...agent, baseBranch: o.defaultBranch, lang: o.lang, contextPath, raw, stage: o.stage, emit: o.emit })

  return {
    rows,
    conclusion: tier.conclusion,
    notDone: [tier.notDone, engineOk ? '' : '引擎这次失败，正确性只由项目视角兜底。'].filter(Boolean).join(' '),
    reviewMdSuggestion: tier.reviewMdSuggestion,
    reviewMd: ctx.reviewMd,
    meta: { engineLevel: o.level, engineOk, reviewMd: ctx.reviewMd.map((r) => r.path) },
  }
}

// Check every finding independently, then tier them; the pure rules in assemble.ts have the last word. A failed check
// leaves everything "unsure"; a failed tier pass keeps everything as written under "later". Shared with re-reviews.
export async function classifyFindings(o: {
  cwd: string; model?: string; projectDirName?: string; abort?: AbortController; onTool?: (name: string, info: string) => void
  baseBranch: string; lang?: string; contextPath?: string | null; raw: RawFinding[]; stage: StageRunner; emit: (message: string) => void
}): Promise<{ rows: FindingRow[]; tier: TierResult }> {
  const agent = { cwd: o.cwd, model: o.model, projectDirName: o.projectDirName, abort: o.abort, onTool: o.onTool }
  const verdicts = new Map<string, { verdict: VerdictValue; reason: string }>()
  if (o.raw.length) {
    try {
      const check = await o.stage('check', () => runCheck({ ...agent, baseBranch: o.baseBranch, findings: o.raw }))
      for (const v of check.result.verdicts) verdicts.set(v.id, { verdict: v.verdict, reason: v.reason })
    } catch (e) {
      if (o.abort?.signal.aborted) throw e
      o.emit(`核对失败（${errMsg(e)}），全部标为不确定`)
    }
  }
  o.emit('分档：去重、分档、判断严重度、改写')
  let tier: TierResult = { conclusion: '', notDone: '', reviewMdSuggestion: '', items: [] }
  try {
    const withVerdicts = o.raw.map((f) => ({ ...f, verdict: verdicts.get(f.id)?.verdict ?? 'unsure', verdictReason: verdicts.get(f.id)?.reason ?? '' }))
    tier = (await o.stage('tier', () => runTier({ ...agent, baseBranch: o.baseBranch, lang: o.lang, contextPath: o.contextPath, findings: withVerdicts }))).result
  } catch (e) {
    if (o.abort?.signal.aborted) throw e
    o.emit(`分档失败（${errMsg(e)}），全部按原文放进「可以后续」`)
  }
  return { rows: assembleFindings(o.raw, verdicts, tier), tier }
}
