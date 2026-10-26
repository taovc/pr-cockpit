import { nanoid } from 'nanoid'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { generateSkill } from '~core/agent/skillgen'
import { usageOfError } from '~core/agent/claudeRun'
import { generateSkillCodex } from '~core/agent/codexSkill'
import { projectDirNameFor } from '~core/host/options'
import { resolveLang, type LangCode } from '~core/agent/lang'
import { cockpitBus } from '~core/events'
import { ensureSkillVersion } from '~core/skillVersions'
import { createRun, finishRun, recordRunUsage } from '~core/runs/store'
import { formatUsageLabel } from '~core/runs/format'

// The AI reads the local project and generates/improves a review skill. The result is stored as a
// **new candidate** (not activated, nothing overwritten), and the new skill is returned for preview/comparison.
const Body = z.object({
  baseSkillId: z.string().optional(),
  name: z.string().optional(),
  instruction: z.string().optional(), // user-supplied instruction (steers the generation)
})

// User-visible text (errors / progress / candidate label) follows the UI locale (mr-locale), same language as the skill body. Defaults to zh.
type SkillGenMessages = {
  notFound: string
  noLocalPath: string
  defaultModel: string
  stage: (provider: string, model: string, effort: string) => string
  done: (ops: number, usage: string) => string
  label: (optimize: boolean, stamp: string) => string
}
const SKILLGEN_MESSAGES = {
  zh: {
    notFound: '项目不存在',
    noLocalPath: '项目未配置本地 clone 路径（生成需要读代码）',
    defaultModel: '默认',
    stage: (p, m, e) => `开始调研项目（${p} · ${m}${e}）…`,
    done: (n, usage) => `生成完成 · 读取/搜索 ${n} 次 · ${usage}`,
    label: (o, s) => `${o ? 'AI 优化' : 'AI 生成'} · ${s}`,
  },
  en: {
    notFound: 'Project not found',
    noLocalPath: 'Project has no local clone path configured (generation needs to read the code)',
    defaultModel: 'default',
    stage: (p, m, e) => `Researching project (${p} · ${m}${e})…`,
    done: (n, usage) => `Generation complete · ${n} read/search ops · ${usage}`,
    label: (o, s) => `${o ? 'AI · Optimized' : 'AI · Generated'} · ${s}`,
  },
  fr: {
    notFound: 'Projet introuvable',
    noLocalPath: 'Le projet n’a pas de chemin de clone local configuré (la génération doit lire le code)',
    defaultModel: 'par défaut',
    stage: (p, m, e) => `Analyse du projet en cours (${p} · ${m}${e})…`,
    done: (n, usage) => `Génération terminée · ${n} lectures/recherches · ${usage}`,
    label: (o, s) => `${o ? 'IA · Optimisé' : 'IA · Généré'} · ${s}`,
  },
} satisfies Record<LangCode, SkillGenMessages>

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const b = Body.parse((await readBody(event)) || {})
  const d = db()
  // Output language follows the UI locale (consistent with the other AI endpoints: reviews/features/fix); defaults to zh.
  // Normalized once, so the skill body and this user-visible text share the same result and can't end up half English half Chinese.
  const lang = resolveLang(getCookie(event, 'mr-locale'))
  const t: SkillGenMessages = SKILLGEN_MESSAGES[lang]

  const project = d.select().from(schema.projects).where(eq(schema.projects.id, id)).get()
  if (!project) throw createError({ statusCode: 404, statusMessage: t.notFound })
  if (!project.localPath) throw createError({ statusCode: 400, statusMessage: t.noLocalPath })

  let baseContent: string | null = null
  if (b.baseSkillId) {
    const base = d.select().from(schema.skills).where(eq(schema.skills.id, b.baseSkillId)).get()
    baseContent = base?.content ?? null
  }

  // Use the project's configured model + effort (same as the review engine)
  const rc = resolveReviewConfig(d, project)
  // Progress events are pushed to the event bus under a project-level key, the frontend listens over SSE (see genstream.get.ts)
  const key = `skillgen:${id}`
  const emit = (kind: string, message: string) =>
    cockpitBus.emit({ reviewId: key, ts: new Date().toISOString(), kind, message })

  let content: string
  let toolN = 0
  // Follow the project's provider (never mixed): codex projects use Codex to read the project and generate the methodology, claude projects use Claude.
  const runGenerate = rc.provider === 'codex' ? generateSkillCodex : generateSkill
  // Run record: skill generation is an agent run too (cost / tokens / model attribution on the dashboard).
  const runId = createRun(d, schema, {
    kind: 'review', subkind: 'skillgen', provider: rc.provider, projectId: id, workspaceType: 'cwd', workspacePath: project.localPath,
    model: rc.model, effort: rc.effort || (rc.provider === 'claude' ? 'high' : ''), codexServiceTier: rc.codexServiceTier, skillId: b.baseSkillId ?? null, lang,
  })
  try {
    emit('stage', t.stage(rc.provider, rc.model || t.defaultModel, rc.effort ? ' · ' + rc.effort : ''))
    const res = await runGenerate({
      cwd: project.localPath,
      projectDirName: projectDirNameFor(project.localPath),
      model: rc.model,
      effort: rc.effort,
      codexServiceTier: rc.codexServiceTier,
      baseContent,
      instruction: b.instruction || null,
      lang,
      onTool: (name, info) => emit('tool', `[${++toolN}] ${name} ${info}`),
    })
    content = res.content
    recordRunUsage(d, schema, runId, res.usage)
    finishRun(d, schema, runId, { status: 'done' })
    emit('done', t.done(toolN, formatUsageLabel(res.usage, res.costUsd)))
  } catch (e) {
    recordRunUsage(d, schema, runId, usageOfError(e))
    finishRun(d, schema, runId, { status: 'error', error: (e as Error).message })
    emit('error', (e as Error).message)
    throw createError({ statusCode: 502, statusMessage: (e as Error).message })
  }

  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
  const row = {
    id: nanoid(),
    projectId: id,
    name: b.name || t.label(!!baseContent, stamp),
    content,
    source: (baseContent ? 'optimized' : 'ai') as 'optimized' | 'ai',
    createdAt: new Date().toISOString(),
  }
  d.insert(schema.skills).values(row).run()
  ensureSkillVersion(d, schema, row) // version 1 snapshot of the generated text
  return row // not activated; the frontend shows a diff preview and the user decides whether to activate
})
