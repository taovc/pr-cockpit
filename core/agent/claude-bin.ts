import { createRequire } from 'node:module'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// The claude executable handed to the SDK's pathToClaudeCodeExecutable, for every Claude path (sessions, reviews,
// helpers, probes). The CLI bundled with the pinned SDK is preferred so the engine changes only when the dependency
// is bumped. Order: ① env override ② the SDK's platform package (dev) ③ the same package found by file in
// node_modules/.pnpm (production: nitro bundles only JS) ④ the auto-updating PATH CLI, logged as unpinned.

// The CLI version bundled with the pinned SDK; a test keeps it in step with package.json.
export const EXPECTED_CLAUDE_CODE_VERSION = '2.1.310'

const PLATFORM_PKG = `claude-agent-sdk-${process.platform}-${process.arch}`

function fromEnv(): string | undefined {
  const p = process.env.CLAUDE_CODE_EXECUTABLE || process.env.CLAUDE_CLI_PATH
  return p && existsSync(p) ? p : undefined
}

function fromSdk(): string | undefined {
  try {
    const req = createRequire(import.meta.url)
    const pkgJson = req.resolve(`@anthropic-ai/${PLATFORM_PKG}/package.json`)
    const bin = path.join(path.dirname(pkgJson), 'claude')
    return existsSync(bin) ? bin : undefined
  } catch {
    return undefined
  }
}

// The SDK's exports hide package.json, so walk up from its entry point.
export function sdkVersion(): string | undefined {
  try {
    let dir = path.dirname(createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk'))
    for (let i = 0; i < 4; i++, dir = path.dirname(dir)) {
      const file = path.join(dir, 'package.json')
      if (!existsSync(file)) continue
      const pkg = JSON.parse(readFileSync(file, 'utf8'))
      if (pkg.name === '@anthropic-ai/claude-agent-sdk') return pkg.version
    }
  } catch { /* SDK not resolvable */ }
  return undefined
}

// The platform package matching the loaded SDK; another version only if that one is missing (logged).
export function fromVendored(): string | undefined {
  const nm = path.join(process.cwd(), 'node_modules')
  const bin = (dir: string) => path.join(nm, '.pnpm', dir, 'node_modules', '@anthropic-ai', PLATFORM_PKG, 'claude')
  let entries: string[] = []
  try {
    entries = readdirSync(path.join(nm, '.pnpm'))
      .filter((e) => e.startsWith(`@anthropic-ai+${PLATFORM_PKG}@`) && existsSync(bin(e)))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }))
  } catch { /* not a pnpm layout */ }
  const want = sdkVersion()
  const exact = want ? entries.find((e) => e === `@anthropic-ai+${PLATFORM_PKG}@${want}`) : undefined
  if (exact) return bin(exact)
  if (entries[0]) {
    console.warn(`[claude-bin] no ${PLATFORM_PKG}@${want ?? '?'} in node_modules; using ${entries[0]}`)
    return bin(entries[0])
  }
  const flat = path.join(nm, '@anthropic-ai', PLATFORM_PKG, 'claude')
  return existsSync(flat) ? flat : undefined
}

function fromPath(): string | undefined {
  const dirs = (process.env.PATH || '').split(path.delimiter)
  // the production process's PATH may be incomplete, so add the common install dirs
  dirs.push(path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin')
  for (const d of dirs) {
    if (!d) continue
    const p = path.join(d, 'claude')
    if (existsSync(p)) {
      console.warn(`[claude-bin] bundled Claude Code CLI not found; using the unpinned ${p}`)
      return p
    }
  }
  return undefined
}

let cached: string | undefined

// Re-resolved when the cached file disappears (a dependency bump while the server runs removes the old version).
export function resolveClaudeExecutable(): string | undefined {
  if (cached && existsSync(cached)) return cached
  cached = fromEnv() ?? fromSdk() ?? fromVendored() ?? fromPath()
  return cached
}
