// Read-only command allowlist for the review family (the Claude Bash tool and Codex command approvals). A command runs
// only when every segment is a known read-only command; tests, builds, scripts and unknown tools are refused, because
// running anything from the PR branch executes the author's code with the owner's credentials.

export type BashVerdict = { ok: true } | { ok: false; reason: string }

export const REVIEW_BASH_HELP = 'This is the PR Cockpit read-only policy, not a missing file or a failed command. Allowed: one read-only command per segment — git diff/log/show/blame/grep/ls-files/ls-tree/cat-file/rev-parse/rev-list/merge-base/status/describe/shortlog/branch (listing), gh pr view/diff/checks/list, gh issue view/list, gh run view/list, gh repo view, gh api (GET), cat/head/tail/wc/ls/find/rg/grep/jq/nl/sort/uniq/cut/tr/diff/stat/file/echo, sed -n with a print-only script. Prefer the Read, Grep and Glob tools. Running project code (tests, builds, scripts, interpreters) is not allowed.'

const no = (reason: string): BashVerdict => ({ ok: false, reason })
const OK: BashVerdict = { ok: true }

type Parsed = { segs: string[][] } | { error: string }

// A small shell tokenizer: quotes, escapes and the operators | || && ; newline. Anything that can run or write
// something the tokens do not show — substitutions, expansions, subshells, redirects, background jobs — is an error.
export function splitCommand(cmd: string): Parsed {
  const segs: string[][] = []
  let argv: string[] = []
  let word = ''
  let inWord = false
  let quote: '"' | "'" | null = null
  const endWord = () => { if (inWord) { argv.push(word); word = ''; inWord = false } }
  const endSeg = () => { endWord(); if (argv.length) segs.push(argv); argv = [] }
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!
    const rest = cmd.slice(i)
    if (quote === "'") { if (c === "'") quote = null; else word += c; continue }
    if (c === '`') return { error: 'command substitution' }
    if (c === '$') {
      const n = cmd[i + 1] ?? ''
      if (n === '(' || n === '{' || /[A-Za-z_]/.test(n)) return { error: 'shell expansion' }
      word += c; inWord = true; continue
    }
    if (c === '\\') { word += cmd[i + 1] ?? ''; i++; inWord = true; continue }
    if (quote === '"') { if (c === '"') quote = null; else word += c; continue }
    if (c === "'" || c === '"') { quote = c; inWord = true; continue }
    if (c === ' ' || c === '\t') { endWord(); continue }
    if (c === '\n' || c === ';') { endSeg(); continue }
    if (rest.startsWith('&&') || rest.startsWith('||')) { endSeg(); i++; continue }
    if (c === '|') { endSeg(); continue }
    if (c === '>' || c === '<' || c === '&') {
      // Only output thrown away is allowed: 2>&1, 2>/dev/null, >/dev/null, &>/dev/null.
      const m = (inWord && word === '2' ? /^>(?:&1|\/dev\/null)(?=\s|$|[;|&])/ : !inWord ? /^&?>\/dev\/null(?=\s|$|[;|&])/ : null)?.exec(rest)
      if (m) { word = ''; inWord = false; i += m[0].length - 1; continue }
      return { error: c === '&' ? 'background job' : 'redirection' }
    }
    if (c === '(' || c === ')') return { error: 'subshell' }
    word += c; inWord = true
  }
  if (quote) return { error: 'unbalanced quotes' }
  endSeg()
  return { segs }
}

const PLAIN = new Set(['cat', 'head', 'wc', 'ls', 'grep', 'egrep', 'fgrep', 'cut', 'tr', 'nl', 'diff', 'stat', 'file', 'basename', 'dirname', 'realpath', 'pwd', 'echo', 'true', 'which', 'jq', 'cd', 'column', 'comm'])
const VERSION_ONLY = new Set(['node', 'python', 'python3', 'pnpm', 'npm', 'npx', 'yarn', 'go', 'cargo', 'ruby', 'java', 'deno', 'bun'])
const GIT_READ = new Set(['diff', 'log', 'show', 'blame', 'grep', 'ls-files', 'ls-tree', 'cat-file', 'rev-parse', 'rev-list', 'merge-base', 'status', 'describe', 'shortlog', 'name-rev', 'for-each-ref', 'branch'])
const GIT_BAD_FLAG = /^(--output|-O|--open-files-in-pager|--ext-diff|--exec|--upload-pack|--receive-pack|--config-env)/
const GH_READ: Record<string, Set<string>> = {
  pr: new Set(['view', 'diff', 'checks', 'list']),
  issue: new Set(['view', 'list']),
  run: new Set(['view', 'list']),
  repo: new Set(['view']),
}
const SED_PRINT = /^(?:(?:\d+|\$)(?:,(?:\d+|\$))?|\/[^/]*\/)p$/

function gitVerdict(args: string[]): BashVerdict {
  let i = 0
  while (i < args.length && args[i]!.startsWith('-')) {
    if (args[i] === '--no-pager') { i++; continue }
    if (args[i] === '-C' && args[i + 1]) { i += 2; continue }
    return no(`git option ${args[i]}`)
  }
  const sub = args[i]
  if (!sub || !GIT_READ.has(sub)) return no(`git ${sub ?? ''} is not a read command`)
  const rest = args.slice(i + 1)
  const bad = rest.find((a) => GIT_BAD_FLAG.test(a))
  if (bad) return no(`git ${sub} ${bad}`)
  if (sub === 'branch' && rest.some((a) => !a.startsWith('-'))) return no('git branch with a name creates or changes a branch')
  return OK
}

function ghVerdict(args: string[]): BashVerdict {
  const [group, verb] = args
  if (group === 'api') {
    for (let i = 1; i < args.length; i++) {
      const a = args[i]!
      if (/^(-f|-F|--field|--raw-field|--input)/.test(a)) return no('gh api with a request body')
      const method = a === '-X' || a === '--method' ? args[i + 1] : /^(?:-X|--method=)(.+)$/.exec(a)?.[1]
      if (method != null && method.toUpperCase() !== 'GET') return no(`gh api ${method}`)
    }
    return OK
  }
  if (!group || !verb || !GH_READ[group]?.has(verb)) return no(`gh ${group ?? ''} ${verb ?? ''} is not a read command`)
  if (args.some((a) => a === '--web' || a === '-w')) return no('gh --web opens a browser')
  return OK
}

function sedVerdict(args: string[]): BashVerdict {
  if (!args.includes('-n')) return no('sed without -n')
  let script: string | null = null
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '-n' || a === '-E' || a === '-r') continue
    if (a === '-e') { const s = args[++i]; if (!s || !SED_PRINT.test(s)) return no(`sed script ${s ?? ''}`); script = s; continue }
    if (a.startsWith('-')) return no(`sed option ${a}`)
    if (script == null) { if (!SED_PRINT.test(a)) return no(`sed script ${a}`); script = a }
  }
  return script == null ? no('sed without a script') : OK
}

function segmentVerdict(argv: string[]): BashVerdict {
  const [cmd, ...args] = argv
  if (!cmd) return OK
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(cmd)) return no('environment assignment')
  if (cmd.includes('/')) return no(`runs a file (${cmd})`)
  if (cmd === 'git') return gitVerdict(args)
  if (cmd === 'gh') return ghVerdict(args)
  if (cmd === 'sed') return sedVerdict(args)
  if (cmd === 'find') { const bad = args.find((a) => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(a)); return bad ? no(`find ${bad}`) : OK }
  if (cmd === 'rg') { const bad = args.find((a) => /^--pre(=|$)/.test(a)); return bad ? no('rg --pre runs a command') : OK }
  if (cmd === 'tail') { const bad = args.find((a) => /^(-f|-F|--follow)/.test(a)); return bad ? no('tail --follow never ends') : OK }
  if (cmd === 'sort') { const bad = args.find((a) => /^(-o|--output)/.test(a)); return bad ? no('sort --output writes a file') : OK }
  if (cmd === 'uniq') return args.filter((a) => !a.startsWith('-')).length > 1 ? no('uniq with an output file') : OK
  if (VERSION_ONLY.has(cmd)) return args.length === 1 && /^(--version|-v|-V)$/.test(args[0]!) ? OK : no(`${cmd} runs code`)
  if (PLAIN.has(cmd)) return OK
  return no(`${cmd} is not on the read-only list`)
}

// The verdict for a whole command line. A `bash -lc '<script>'` wrapper (how Codex reports commands) is judged by its script.
export function reviewBashVerdict(command: string): BashVerdict {
  const parsed = splitCommand(command)
  if ('error' in parsed) return no(parsed.error)
  const [only] = parsed.segs
  if (parsed.segs.length === 1 && only && only.length === 3 && /(^|\/)(bash|zsh|sh)$/.test(only[0]!) && /^-l?c$/.test(only[1]!)) return reviewBashVerdict(only[2]!)
  for (const argv of parsed.segs) {
    const v = segmentVerdict(argv)
    if (!v.ok) return v
  }
  return OK
}
