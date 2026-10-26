import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Find a usable claude executable to hand to the SDK's pathToClaudeCodeExecutable.
//
// Why this is needed: the SDK ships the platform-specific native binary in an optional
// dependency (@anthropic-ai/claude-agent-sdk-<platform>-<arch>, ~200MB). In dev we run under
// the project's node_modules, so the SDK finds it on its own; but when nitro builds the
// production bundle it only traces the SDK's JS into .output, without bundling that binary —
// so the production process reports "Native CLI binary for darwin-arm64 not found". Pointing
// explicitly at an executable that definitely exists is stable in both dev and production.
//
// Resolution order:
//   ① env var escape hatch (manual override)
//   ② the same-version binary shipped with the SDK (resolvable from dev's module context)
//   ③ the claude CLI the user is already logged into, from PATH / common install dirs (production fallback)

let cached: string | null | undefined

function fromEnv(): string | undefined {
  const p = process.env.CLAUDE_CODE_EXECUTABLE || process.env.CLAUDE_CLI_PATH
  return p && existsSync(p) ? p : undefined
}

function fromSdk(): string | undefined {
  try {
    const req = createRequire(import.meta.url)
    const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
    const pkgJson = req.resolve(`${pkg}/package.json`)
    const bin = path.join(path.dirname(pkgJson), 'claude')
    return existsSync(bin) ? bin : undefined
  } catch {
    return undefined
  }
}

function fromPath(): string | undefined {
  const dirs = (process.env.PATH || '').split(path.delimiter)
  // the production process's PATH may be incomplete, so add the common install dirs
  dirs.push(path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin')
  for (const d of dirs) {
    if (!d) continue
    const p = path.join(d, 'claude')
    if (existsSync(p)) return p
  }
  return undefined
}

export function resolveClaudeExecutable(): string | undefined {
  if (cached !== undefined) return cached ?? undefined
  const found = fromEnv() ?? fromSdk() ?? fromPath()
  cached = found ?? null
  return found
}

// The CLI version bundled with the pinned SDK; a test keeps it in step with package.json.
export const EXPECTED_CLAUDE_CODE_VERSION = '2.1.310'

// The production bundle has no copy of the platform package, so look it up by file in the project's node_modules.
export function fromVendored(): string | undefined {
  const key = `${process.platform}-${process.arch}`
  const pkg = `claude-agent-sdk-${key}`
  const nm = path.join(process.cwd(), 'node_modules')
  const out: string[] = []
  try {
    const entries = readdirSync(path.join(nm, '.pnpm'))
      .filter((e) => e.startsWith(`@anthropic-ai+${pkg}@`))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }))
    for (const e of entries) out.push(path.join(nm, '.pnpm', e, 'node_modules', '@anthropic-ai', pkg, 'claude'))
  } catch { /* not a pnpm layout */ }
  out.push(path.join(nm, '@anthropic-ai', pkg, 'claude'))
  return out.find((p) => existsSync(p))
}

let pinned: { path: string | undefined; source: 'env' | 'vendored' | 'path' | null } | undefined

// Review family only: the SDK's bundled CLI, so a review's engine changes only when the dependency is bumped.
// The user's PATH CLI auto-updates; it is used only when no bundled copy exists, and logged as unpinned.
export function resolvePinnedClaudeExecutable(): string | undefined {
  if (pinned) return pinned.path
  const env = fromEnv()
  const vendored = env ? undefined : (fromSdk() ?? fromVendored())
  const fallback = env || vendored ? undefined : fromPath()
  pinned = { path: env ?? vendored ?? fallback, source: env ? 'env' : vendored ? 'vendored' : fallback ? 'path' : null }
  if (pinned.source === 'path') console.warn(`[claude-bin] bundled Claude Code CLI not found; reviews fall back to the unpinned ${fallback}`)
  return pinned.path
}
