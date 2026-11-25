import { query } from '@anthropic-ai/claude-agent-sdk'
import { buildProbeOptions } from '../host/options'
import { withTimeout } from '../host/config'

export type ModelCap = {
  value: string
  displayName: string
  description: string
  supportsEffort: boolean
  effortLevels: string[]
  resolvedModel?: string
  supportsFastMode?: boolean
}

let _cache: { models: ModelCap[]; at: number } | null = null
const TTL = 5 * 60_000

export function toModelCap(m: any): ModelCap {
  return {
    value: m.value,
    displayName: m.displayName || m.value,
    description: m.description || '',
    supportsEffort: !!m.supportsEffort,
    effortLevels: m.supportedEffortLevels || [],
    ...(typeof m.resolvedModel === 'string' && m.resolvedModel ? { resolvedModel: m.resolvedModel } : {}),
    ...(typeof m.supportsFastMode === 'boolean' ? { supportsFastMode: m.supportsFastMode } : {}),
  }
}

// Read the actually available models (including each model's supported effort levels) from the locally logged-in claude.
export async function getCapabilities(force = false): Promise<{ models: ModelCap[] }> {
  if (!force && _cache && Date.now() - _cache.at < TTL) return { models: _cache.models }

  const abort = new AbortController()
  // never yields: keeps the streaming input open without running a turn
  const input = (async function* () { await new Promise<void>((r) => abort.signal.addEventListener('abort', () => r(), { once: true })) })()
  // Settings load like a session's (availableModels, ANTHROPIC_DEFAULT_*_MODEL); MCP servers are not needed for the catalog.
  const q = query({ prompt: input as any, options: { ...buildProbeOptions({ cwd: process.cwd(), abort }), mcpServers: {}, strictMcpConfig: true } })
  try {
    const models = (await withTimeout(q.supportedModels(), 60_000, 'supportedModels')).map(toModelCap)
    _cache = { models, at: Date.now() }
    return { models }
  } finally {
    try { q.close() } catch { /* already closed */ }
    abort.abort()
  }
}
