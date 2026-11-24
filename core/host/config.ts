import { describeCodexConfig, type CodexConfigReport } from '../codex/describe'
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { buildProbeOptions, projectDirNameFor } from './options'
import type { AgentSettings } from '../agent/settings'

// Agent configuration transparency, per provider: what the CLI itself reports once started (the source of truth —
// startup context by category and by file/tool/skill, MCP servers with their tools, commands, plugins) plus a disk scan
// of the files it may read, each marked "loaded" from the CLI's own report so "why is my rule not applied" is answerable.
// Settings contents are never read (env values may hold secrets).

export type Scope = 'user' | 'project' | 'local' | 'managed'
export type FileKind = 'settings' | 'memory' | 'rules' | 'skills' | 'commands' | 'plugins' | 'mcp'
export type ConfigFile = {
  path: string
  kind: FileKind
  scope: Scope
  exists: boolean
  bytes: number
  count: number | null // entries inside a directory
  loaded: boolean | null // true/false from the CLI's own report; null = the CLI does not report this kind
  tokens: number | null // Claude: tokens the file takes in the startup context
}
export type ProbeReport = {
  cwd: string
  at: string
  ms: number
  error: string | null
  commands: { name: string; description: string; argumentHint: string; aliases: string[]; origin: 'plugin' | 'custom' | 'builtin' }[]
  mcp: { name: string; status: string; scope?: string; transport?: string; version?: string; error?: string; tools: { name: string; readOnly?: boolean; destructive?: boolean }[] }[]
  context: {
    total: number
    max: number
    percentage: number
    categories: { name: string; tokens: number; deferred: boolean }[]
    memoryFiles: { path: string; type: string; tokens: number }[]
    mcpTools: { name: string; serverName: string; tokens: number }[]
    skills: { name: string; source: string; pluginName?: string; tokens: number }[]
    slashCommands: { total: number; included: number; tokens: number } | null
  } | null
  plugins: { name: string; version?: string; source?: string; path: string }[]
  settingsSources: string[] // settings layers the CLI applied (names only, e.g. userSettings)
  chromeTransport: 'extraArgs' | 'off' // how Claude in Chrome is attached (the only tier in use; the plugin-path / spawn fallbacks were never needed)
}
export type AgentConfigReport = {
  cwd: string
  projectDirName: string | undefined
  claude: { files: ConfigFile[]; probe: ProbeReport | null }
  codex: { files: ConfigFile[]; report: CodexConfigReport | null }
  agent: AgentSettings
}

function fileInfo(path: string, kind: FileKind, scope: Scope, countGlob?: (dir: string) => number): ConfigFile {
  const exists = existsSync(path)
  let bytes = 0
  let count: number | null = null
  if (exists) {
    try {
      const st = statSync(path)
      bytes = st.size
      if (st.isDirectory() && countGlob) count = countGlob(path)
    } catch { /* unreadable → report as present with 0 bytes */ }
  }
  return { path, kind, scope, exists, bytes, count, loaded: null, tokens: null }
}

// Markdown files at any depth (Claude's rules directory is nested by topic).
function countMd(dir: string, depth = 0): number {
  try {
    return readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isFile() && e.name.endsWith('.md') ? 1 : e.isDirectory() && depth < 4 ? countMd(join(dir, e.name), depth + 1) : 0), 0)
  } catch { return 0 }
}
function countSkillDirs(dir: string): number {
  try { return readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && existsSync(join(dir, e.name, 'SKILL.md'))).length } catch { return 0 }
}
function countDirs(dir: string): number {
  try { return readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).length } catch { return 0 }
}
function countJsonKeys(path: string): number {
  try { const v = JSON.parse(readFileSync(path, 'utf8')); const p = v?.plugins ?? v; return p && typeof p === 'object' ? Object.keys(p).length : 0 } catch { return 0 }
}
const scopeOf = (path: string, cwd: string): Scope => (path.startsWith(`${cwd}/`) ? 'project' : 'user')

// Files Claude Code may read for this cwd. Memory files are marked from the CLI's own startup-context report, which
// also adds what the scan cannot know about (the auto-memory MEMORY.md, the one rule file loaded out of a nested set).
// AGENTS.md is deliberately absent: this CLI version does not load it (verified: never in memoryFiles).
export function claudeFiles(cwd: string, probe: ProbeReport | null): ConfigFile[] {
  const home = homedir()
  const u = join(home, '.claude')
  const files: ConfigFile[] = [
    fileInfo('/Library/Application Support/ClaudeCode/managed-settings.json', 'settings', 'managed'),
    fileInfo(join(u, 'settings.json'), 'settings', 'user'),
    fileInfo(join(cwd, '.claude', 'settings.json'), 'settings', 'project'),
    fileInfo(join(cwd, '.claude', 'settings.local.json'), 'settings', 'local'),
    fileInfo(join(u, 'CLAUDE.md'), 'memory', 'user'),
    fileInfo(join(u, 'rules'), 'rules', 'user', countMd),
    fileInfo(join(cwd, 'CLAUDE.md'), 'memory', 'project'),
    fileInfo(join(cwd, '.claude', 'CLAUDE.md'), 'memory', 'project'),
    fileInfo(join(cwd, 'CLAUDE.local.md'), 'memory', 'local'),
    fileInfo(join(cwd, '.claude', 'rules'), 'rules', 'project', countMd),
    fileInfo(join(u, 'skills'), 'skills', 'user', countSkillDirs),
    fileInfo(join(cwd, '.claude', 'skills'), 'skills', 'project', countSkillDirs),
    fileInfo(join(u, 'commands'), 'commands', 'user', countMd),
    fileInfo(join(cwd, '.claude', 'commands'), 'commands', 'project', countMd),
    fileInfo(join(home, '.claude.json'), 'mcp', 'user'),
    fileInfo(join(cwd, '.mcp.json'), 'mcp', 'project'),
    { ...fileInfo(join(u, 'plugins', 'installed_plugins.json'), 'plugins', 'user'), count: existsSync(join(u, 'plugins', 'installed_plugins.json')) ? countJsonKeys(join(u, 'plugins', 'installed_plugins.json')) : null },
  ]
  if (!probe?.context) return files
  const loaded = new Map(probe.context.memoryFiles.map((m) => [m.path, m]))
  for (const f of files) {
    if (f.kind !== 'memory') continue
    const m = loaded.get(f.path)
    f.loaded = !!m
    f.tokens = m?.tokens ?? null
    loaded.delete(f.path)
  }
  for (const [path, m] of loaded) files.push({ ...fileInfo(path, 'memory', scopeOf(path, cwd)), loaded: true, tokens: m.tokens })
  return files
}

// Files Codex may read for this cwd. Instruction files are marked from the app-server's instructionSources; the memories
// directory is listed because it exists on disk but the protocol never reports whether it was injected (loaded = null).
export function codexFiles(cwd: string, report: CodexConfigReport | null): ConfigFile[] {
  const home = homedir()
  const c = join(home, '.codex')
  const files: ConfigFile[] = [
    fileInfo('/etc/codex/config.toml', 'settings', 'managed'),
    fileInfo(join(c, 'config.toml'), 'settings', 'user'),
    fileInfo(join(cwd, '.codex', 'config.toml'), 'settings', 'project'),
    fileInfo(join(c, 'AGENTS.md'), 'memory', 'user'),
    fileInfo(join(cwd, 'AGENTS.md'), 'memory', 'project'),
    fileInfo(join(cwd, 'CLAUDE.md'), 'memory', 'project'), // project_doc_fallback_filenames: only read when AGENTS.md is absent
    fileInfo(join(c, 'memories'), 'memory', 'user', countMd),
    fileInfo(join(c, 'skills'), 'skills', 'user', countSkillDirs),
    fileInfo(join(home, '.agents', 'skills'), 'skills', 'user', countSkillDirs),
    fileInfo(join(cwd, '.agents', 'skills'), 'skills', 'project', countSkillDirs),
    fileInfo(join(c, 'plugins', 'cache'), 'plugins', 'user', countDirs),
  ]
  if (!report) return files
  // A failed call leaves its rows at "not reported" rather than claiming "not loaded".
  const injected = report.instructionSources ? new Set(report.instructionSources) : null
  const layers = report.configLayers ? new Set(report.configLayers.map((l) => l.file).filter(Boolean)) : null
  for (const f of files) {
    if (injected && f.kind === 'memory' && !f.count && f.path.endsWith('.md')) { f.loaded = injected.has(f.path); injected.delete(f.path) }
    if (layers && f.kind === 'settings') f.loaded = f.exists && layers.has(f.path) // the server lists a layer even when its file is absent
  }
  for (const path of injected ?? []) files.push({ ...fileInfo(path, 'memory', scopeOf(path, cwd)), loaded: true })
  return files
}

const PROBE_TTL_MS = 5 * 60_000
const probeCache = new Map<string, ProbeReport>()
const inflight = new Map<string, Promise<ProbeReport>>()

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms); p.then(v => { clearTimeout(t); res(v) }, e => { clearTimeout(t); rej(e) }) })
}

function commandOrigin(name: string, description = ''): ProbeReport['commands'][number]['origin'] {
  if (name.includes(':') || name.startsWith('mcp__plugin_')) return 'plugin'
  return /\((user|project)\)\s*$/.test(description) ? 'custom' : 'builtin' // the CLI suffixes user/project skills; built-ins carry no suffix
}
const transportOf = (config: any): string | undefined => (config?.type ? String(config.type) : config?.command ? 'stdio' : config?.url ? 'http' : undefined)

// Start the CLI exactly like a session would, ask it what it loaded, never run a turn. Cached per cwd+chrome.
export async function probeAgent(cwd: string, chrome: boolean, refresh = false): Promise<ProbeReport> {
  const key = `${cwd}|${chrome ? 1 : 0}`
  const hit = probeCache.get(key)
  if (hit && !refresh && Date.now() - Date.parse(hit.at) < PROBE_TTL_MS) return hit
  const running = inflight.get(key)
  if (running) return running
  const p = (async (): Promise<ProbeReport> => {
    const started = Date.now()
    const abort = new AbortController()
    const report: ProbeReport = { cwd, at: new Date().toISOString(), ms: 0, error: null, commands: [], mcp: [], context: null, plugins: [], settingsSources: [], chromeTransport: chrome ? 'extraArgs' : 'off' }
    const never = (async function* () { await new Promise<void>((r) => abort.signal.addEventListener('abort', () => r(), { once: true })) })()
    let q: ReturnType<typeof query> | null = null
    try {
      q = query({ prompt: never as any, options: buildProbeOptions({ cwd, chrome, projectDirName: projectDirNameFor(cwd), abort }) })
      const init = await withTimeout(q.initializationResult(), 60_000, 'initialization')
      report.commands = (init.commands ?? []).map((c: any) => ({ name: c.name, description: c.description, argumentHint: String(c.argumentHint ?? ''), aliases: Array.isArray(c.aliases) ? c.aliases : [], origin: commandOrigin(c.name, c.description) }))
      const [plugins, settings] = await Promise.all([
        withTimeout(q.reloadPlugins(), 30_000, 'reloadPlugins').catch(() => null),
        withTimeout((q as any).getSettings?.() ?? Promise.resolve(null), 15_000, 'getSettings').catch(() => null), // present at runtime, absent from the SDK typings
      ])
      // Remote MCP servers (plugin HTTP servers) can still be `pending` right after initialization; their tools and the
      // context they take only appear once connected, so give them a few seconds before reading both.
      let mcp: any[] = []
      let ctx: any = null
      for (let attempt = 0; attempt < 5; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, 2000))
        ;[mcp, ctx] = await Promise.all([
          withTimeout(q.mcpServerStatus(), 30_000, 'mcpServerStatus').catch(() => [] as any[]),
          withTimeout(q.getContextUsage(), 30_000, 'getContextUsage').catch(() => null),
        ])
        if (!mcp.some((s: any) => s.status === 'pending')) break
      }
      report.mcp = (mcp as any[]).map(s => ({
        name: s.name, status: s.status,
        ...(s.scope ? { scope: String(s.scope) } : {}), ...(transportOf(s.config) ? { transport: transportOf(s.config) } : {}),
        ...(s.serverInfo?.version ? { version: String(s.serverInfo.version) } : {}), ...(s.error ? { error: String(s.error) } : {}),
        tools: (s.tools ?? []).map((t: any) => ({ name: String(t.name), ...(t.annotations?.readOnly != null ? { readOnly: !!t.annotations.readOnly } : {}), ...(t.annotations?.destructive != null ? { destructive: !!t.annotations.destructive } : {}) })),
      }))
      const c = ctx as any
      if (c) {
        report.context = {
          total: Number(c.totalTokens ?? 0), max: Number(c.maxTokens ?? 0), percentage: Number(c.percentage ?? 0),
          categories: (c.categories ?? []).map((x: any) => ({ name: String(x.name), tokens: Number(x.tokens ?? 0), deferred: !!x.isDeferred })),
          memoryFiles: (c.memoryFiles ?? []).map((m: any) => ({ path: String(m.path), type: String(m.type ?? ''), tokens: Number(m.tokens ?? 0) })),
          mcpTools: (c.mcpTools ?? []).map((t: any) => ({ name: String(t.name), serverName: String(t.serverName ?? ''), tokens: Number(t.tokens ?? 0) })),
          skills: (c.skills?.skillFrontmatter ?? []).map((s: any) => ({ name: String(s.name), source: String(s.source ?? ''), ...(s.pluginName ? { pluginName: String(s.pluginName) } : {}), tokens: Number(s.tokens ?? 0) })),
          slashCommands: c.slashCommands ? { total: Number(c.slashCommands.totalCommands ?? 0), included: Number(c.slashCommands.includedCommands ?? 0), tokens: Number(c.slashCommands.tokens ?? 0) } : null,
        }
      }
      report.plugins = ((plugins as any)?.plugins ?? []).map((p: any) => ({ name: String(p.name), ...(p.version ? { version: String(p.version) } : {}), ...(p.source ? { source: String(p.source) } : {}), path: String(p.path ?? '') }))
      report.settingsSources = ((settings as any)?.sources ?? []).map((s: any) => String(s.source ?? '')).filter(Boolean)
    } catch (e) {
      report.error = (e as Error).message
    } finally {
      try { q?.close() } catch { /* already closed */ }
      abort.abort()
    }
    report.ms = Date.now() - started
    probeCache.set(key, report)
    return report
  })()
  inflight.set(key, p)
  try { return await p } finally { inflight.delete(key) }
}

export async function agentConfigReport(opts: { cwd: string; agent: AgentSettings; probe: boolean; refresh?: boolean }): Promise<AgentConfigReport> {
  const cwd = resolve(opts.cwd)
  const [probe, codex] = opts.probe ? await Promise.all([probeAgent(cwd, opts.agent.chrome, opts.refresh), describeCodexConfig(cwd, opts.refresh)]) : [null, null]
  return { cwd, projectDirName: projectDirNameFor(cwd), claude: { files: claudeFiles(cwd, probe), probe }, codex: { files: codexFiles(cwd, codex), report: codex }, agent: opts.agent }
}
