import type { ProviderUsage, ReviewStage } from '../runs/types'
import { pickByLang } from '../agent/lang'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { buildContextDoc, gatherReviewContext, writeContextDoc, type RuleFile } from './context'
import { runEngine, type EngineLevel } from './engine'
import { runCheck, runContextPass, runTier, type TierResult } from './agents'
import { assembleFindings, fromContext, fromEngine, type FindingRow, type RawFinding, type VerdictValue } from './assemble'

// Context by code → engine ∥ project-context pass → independent check → tiers; each stage is a runs row via `stage`.

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
  effort?: string
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
  requirement: string
  reviewMd: RuleFile[]
  meta: { engineLevel: EngineLevel; engineOk: boolean; reviewMd: string[] }
}

const errMsg = (e: unknown) => (e as Error)?.message ?? String(e)
const ENGINE_FAILED_NOTE = { zh: '引擎这次失败，正确性只由项目视角兜底。', en: 'The engine failed this time; correctness was covered by the project pass only.', fr: 'Le moteur a échoué cette fois ; la justesse n’a été couverte que par le regard projet.' }

// The calls runScopeReview makes; tests replace them.
export type ScopeDeps = { gather: typeof gatherReviewContext; engine: typeof runEngine; context: typeof runContextPass; classify: typeof classifyFindings }

export async function runScopeReview(o: ScopeReviewOptions, deps: ScopeDeps = { gather: gatherReviewContext, engine: runEngine, context: runContextPass, classify: classifyFindings }): Promise<ScopeReviewResult> {
  const agent = { cwd: o.cwd, model: o.model, effort: o.effort, projectDirName: o.projectDirName, abort: o.abort, onTool: o.onTool }

  o.emit('收集上下文：REVIEW.md、需求原意、CI、项目记忆')
  const ctx = await deps.gather({ repo: o.repo, prNumber: o.prNumber, localPath: o.localPath, defaultBranch: o.defaultBranch, projectDirName: o.projectDirName, projects: o.projects })
  const contextPath = writeContextDoc(o.historyRoot, o.reviewId, buildContextDoc({ ...ctx, repo: o.repo, prNumber: o.prNumber, defaultBranch: o.defaultBranch, instruction: o.instruction }))
  o.emit(`上下文已备好（REVIEW.md ${ctx.reviewMd.length} 份 · 需求来源 ${ctx.requirement.source} · CI ${ctx.checks.length} 项）：${contextPath}`)

  if (o.abort?.signal.aborted) throw new Error('aborted')
  o.emit(`并行：引擎 /code-review ${o.level} + 项目视角`)
  const [engine, context] = await Promise.allSettled([
    o.stage('engine', () => deps.engine({ cwd: o.cwd, prNumber: o.prNumber, defaultBranch: o.defaultBranch, level: o.level, model: o.model, effort: o.effort, instruction: o.instruction, projectDirName: o.projectDirName, abort: o.abort, onTool: o.onTool })),
    o.stage('context', () => deps.context({ ...agent, contextPath, baseBranch: o.defaultBranch, correctnessLens: false })),
  ])
  if (o.abort?.signal.aborted) throw new Error('aborted')
  const engineOk = engine.status === 'fulfilled'
  // Keep the engine's own report next to the context file, so a thin or failed engine pass can be read afterwards.
  try {
    const report = engineOk ? `${engine.value.text}\n\n---\n\n${JSON.stringify(engine.value.findings, null, 2)}\n\n---\n\n${engine.value.trace.join('\n')}` : `ENGINE FAILED: ${errMsg(engine.reason)}`
    writeFileSync(join(dirname(contextPath), 'engine-report.md'), report, 'utf8')
  } catch { /* the report file is only for reading later */ }
  if (!engineOk && context.status === 'rejected') throw new Error(`引擎和项目视角都失败：${errMsg(context.reason)}`)
  let contextFindings = context.status === 'fulfilled' ? context.value.result.findings : []
  if (context.status === 'rejected') o.emit(`项目视角失败（${errMsg(context.reason)}），只用引擎的结果`)
  if (!engineOk) {
    o.emit(`引擎失败（${errMsg((engine as PromiseRejectedResult).reason)}），项目视角补一轮正确性视角`)
    try {
      contextFindings = [...contextFindings, ...(await o.stage('context', () => deps.context({ ...agent, contextPath, baseBranch: o.defaultBranch, correctnessLens: true }))).result.findings]
    } catch (e) {
      if (o.abort?.signal.aborted) throw e
      o.emit(`正确性兜底也失败（${errMsg(e)}），保留首轮项目视角的结果`)
    }
  }
  const raw: RawFinding[] = [...(engineOk ? fromEngine(engine.value.findings) : []), ...fromContext(contextFindings)]
  o.emit(`发现 ${raw.length} 条（引擎 ${raw.filter((f) => f.source === 'engine').length} · 项目视角 ${raw.filter((f) => f.source === 'context').length}），开始核对`)

  const { rows, tier } = await deps.classify({ ...agent, baseBranch: o.defaultBranch, lang: o.lang, contextPath, raw, stage: o.stage, emit: o.emit })

  return {
    rows,
    conclusion: tier.conclusion,
    notDone: [tier.notDone, engineOk ? '' : pickByLang(o.lang, ENGINE_FAILED_NOTE)].filter(Boolean).join(' '),
    requirement: ctx.requirement.text,
    reviewMdSuggestion: tier.reviewMdSuggestion,
    reviewMd: ctx.reviewMd,
    meta: { engineLevel: o.level, engineOk, reviewMd: ctx.reviewMd.map((r) => r.path) },
  }
}

// Check, then tier; shared with re-reviews. A failed check leaves "unsure", a failed tier pass keeps everything as "later".
export async function classifyFindings(o: {
  cwd: string; model?: string; effort?: string; projectDirName?: string; abort?: AbortController; onTool?: (name: string, info: string) => void
  baseBranch: string; lang?: string; contextPath?: string | null; raw: RawFinding[]; stage: StageRunner; emit: (message: string) => void
}): Promise<{ rows: FindingRow[]; tier: TierResult }> {
  const agent = { cwd: o.cwd, model: o.model, effort: o.effort, projectDirName: o.projectDirName, abort: o.abort, onTool: o.onTool }
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
