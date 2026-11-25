import { existsSync, readdirSync } from 'node:fs'
import { join, delimiter } from 'node:path'
import os from 'node:os'

// Locate the Codex CLI binary. One binary for everything (app-server, --version): the 0.149 line migrates thread
// history into ~/.codex/thread_history_1.sqlite and two different versions running side by side fight over it, so
// the resolution order is deliberate — pinned env override, the packaged copy, the vendored npm binary, PATH last.

// Platform → Rust target triple (the Codex binary lives under vendor/<triple>/bin/codex).
const CODEX_TARGET_TRIPLE: Record<string, string> = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'win32-x64': 'x86_64-pc-windows-msvc',
}

export function codexTargetTriple(): string | undefined {
  return CODEX_TARGET_TRIPLE[`${process.platform}-${process.arch}`]
}

// Look the binary up by file inside the real project node_modules (process.cwd()): the nitro production build bundles
// only JS into .output, never the platform binary package, so import-relative resolution finds nothing there.
function codexBinCandidates(triple: string, binName: string): string[] {
  const cwd = process.cwd()
  const key = `${process.platform}-${process.arch}`
  const out: string[] = []
  // Packaged app (scripts/prepare-electron-codex.mjs copies the vendored binary here) — checked before node_modules
  // because inside Electron cwd is userData, not the project root.
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resourcesPath) out.push(join(resourcesPath, '.output', 'vendor', 'codex', 'bin', binName))
  out.push(join(cwd, '.output', 'vendor', 'codex', 'bin', binName))
  // pnpm store: .pnpm/@openai+codex@<ver>-<platform>-<arch>/node_modules/@openai/codex/vendor/<triple>/bin/codex
  const pnpmDir = join(cwd, 'node_modules', '.pnpm')
  try {
    // An interrupted pnpm update can briefly leave several versions behind; prefer the newest so we don't land on an old model catalog again.
    const entries = readdirSync(pnpmDir)
      .filter((entry) => entry.startsWith('@openai+codex@') && entry.endsWith(`-${key}`))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }))
    for (const entry of entries) {
      out.push(join(pnpmDir, entry, 'node_modules', '@openai', 'codex', 'vendor', triple, 'bin', binName))
    }
  } catch { /* no .pnpm directory (non-pnpm layout) → fall through to the hoisted candidates below */ }
  // npm/yarn flat layout
  out.push(join(cwd, 'node_modules', '@openai', `codex-${key}`, 'vendor', triple, 'bin', binName))
  out.push(join(cwd, 'node_modules', '@openai', 'codex', 'vendor', triple, 'bin', binName))
  return out
}

// Last resort: the codex CLI the user installed globally (PATH / the usual install directories). Logged as unpinned
// because its version may differ from the vendored one.
function codexFromPath(binName: string): string | undefined {
  const dirs = (process.env.PATH || '').split(delimiter)
  dirs.push(join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin')
  for (const d of dirs) {
    if (!d) continue
    const p = join(d, binName)
    if (existsSync(p)) return p
  }
  return undefined
}

// The @openai/codex version this build was tested against; the app-server handshake warns when a different binary answers.
export const EXPECTED_CODEX_VERSION = '0.171.0'

let _codexBin: string | null | undefined
let _codexBinSource: 'env' | 'packaged' | 'vendored' | 'path' | null = null

export function resolveCodexExecutable(): string | undefined {
  if (_codexBin !== undefined) return _codexBin ?? undefined
  const envBin = process.env.CODEX_EXECUTABLE
  if (envBin && existsSync(envBin)) { _codexBinSource = 'env'; return (_codexBin = envBin) }
  const triple = codexTargetTriple()
  if (triple) {
    const binName = process.platform === 'win32' ? 'codex.exe' : 'codex'
    for (const cand of codexBinCandidates(triple, binName)) {
      if (existsSync(cand)) { _codexBinSource = cand.includes(join('.output', 'vendor')) ? 'packaged' : 'vendored'; return (_codexBin = cand) }
    }
    const fromPath = codexFromPath(binName)
    if (fromPath) { _codexBinSource = 'path'; console.warn(`[codex] using unpinned codex from PATH: ${fromPath}`); return (_codexBin = fromPath) }
  }
  _codexBin = null
  return undefined
}

export function codexExecutableSource(): 'env' | 'packaged' | 'vendored' | 'path' | null {
  resolveCodexExecutable()
  return _codexBinSource
}
