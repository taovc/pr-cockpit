function gitCommandPattern(commandPattern: string): RegExp {
  const gitOption = String.raw`(?:-[A-Za-z](?:\s+\S+)?|--[A-Za-z0-9-]+(?:[=\s]\S+)?)`
  return new RegExp(String.raw`\bgit\b(?:\s+${gitOption})*\s+${commandPattern}(?=\s|$|[|;&])`, 'i')
}

function ghCommandPattern(commandPattern: string): RegExp {
  const ghOption = String.raw`(?:-[A-Za-z](?:\s+\S+)?|--[A-Za-z0-9-]+(?:[=\s]\S+)?)`
  return new RegExp(String.raw`\bgh\b(?:\s+${ghOption})*\s+${commandPattern}(?=\s|$|[|;&])`, 'i')
}

const GIT_REMOTE_MUTATION_RE = gitCommandPattern('push')
const GIT_LOCAL_MUTATION_RES = [
  gitCommandPattern('(?:add|commit|reset|checkout|switch|merge|rebase|restore|clean|cherry-pick|revert|apply|am|mv|rm)'),
  gitCommandPattern(String.raw`branch\s+(?:-[dDmMcC]\b|--(?:delete|move|copy|set-upstream-to|unset-upstream)\b|[^\s-]\S*)`),
  gitCommandPattern(String.raw`tag\s+(?:-[adfsm]\b|--(?:annotate|delete|sign|force|message)\b|[^\s-]\S*)`),
  gitCommandPattern(String.raw`stash\s+(?:push|pop|apply|drop|clear|save|store|branch|create)\b`),
  gitCommandPattern(String.raw`worktree\s+(?:add|remove|move|prune|repair)\b`),
  gitCommandPattern(String.raw`remote\s+(?:add|remove|rm|rename|set-url|prune)\b`),
  gitCommandPattern(String.raw`config\s+(?:(?:--global|--system|--local)\s+)?(?:--add|--unset|--unset-all|--replace-all|--rename-section|--remove-section|--edit)\b`),
]
const GH_MUTATION_RE = ghCommandPattern(String.raw`pr\s+(?:create|review|comment|merge|close|edit|ready|reopen)`)
const GH_API_MUTATION_RE = ghCommandPattern(String.raw`api\b.*(?:--method|-X)\s*(?:POST|PUT|PATCH|DELETE)\b`)

export type GithubCommandClass = 'approve-merge' | 'github-write'

const GH_WRITE_SUBCOMMANDS: Record<string, Set<string>> = {
  pr: new Set(['comment', 'review', 'edit', 'close', 'reopen', 'ready', 'lock', 'unlock']),
  issue: new Set(['comment', 'edit', 'close', 'reopen', 'lock', 'unlock', 'delete', 'transfer']),
  release: new Set(['create', 'edit', 'delete', 'upload']),
  label: new Set(['set', 'create', 'edit', 'delete']),
  secret: new Set(['set', 'create', 'edit', 'delete']),
  variable: new Set(['set', 'create', 'edit', 'delete']),
  workflow: new Set(['run']),
  repo: new Set(['edit', 'archive', 'rename', 'delete']),
}
const GH_GLOBAL_VALUE_FLAGS = new Set(['-R', '--repo', '--hostname'])
const GH_API_VALUE_FLAGS = new Set(['-X', '--method', '-f', '--raw-field', '-F', '--field', '--input', '-H', '--header', '-q', '--jq', '-t', '--template', '--hostname', '--cache', '-p', '--preview'])
// Shell keywords and wrappers that run the word after them (and their own options) as the command.
const CMD_PREFIX_WORDS = new Set(['command', 'exec', 'env', 'time', 'nohup', 'sudo', 'builtin', 'eval', 'xargs', 'timeout', 'nice', 'stdbuf', 'ionice', '{', '!', 'if', 'then', 'do', 'else', 'elif', 'while', 'until'])
const PREFIX_VALUE_FLAGS: Record<string, string[]> = {
  env: ['-u', '-C', '-S'],
  sudo: ['-u', '-g', '-C', '-h', '-p', '-U', '-D', '-r', '-t'],
  timeout: ['-s', '-k'],
  nice: ['-n'],
  xargs: ['-I', '-n', '-P', '-L', '-d', '-E', '-s', '-a'],
  stdbuf: ['-i', '-o', '-e'],
  ionice: ['-c', '-n', '-p'],
}
// Commands that only print or search text: a `gh pr merge` among their arguments is not run.
const TEXT_ONLY_COMMANDS = new Set(['echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'git', 'cat', 'head', 'tail', 'wc', 'less'])
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/
const SHELL_WRAPPER_RE = /^(?:\S*\/)?(?:ba|z|da|k|fi)?sh\s+(?:-[A-Za-z]+\s+)*-[A-Za-z]*c\s+(.*)$/s
const GRAPHQL_MERGE_RE = /\b(?:mergePullRequest|enablePullRequestAutoMerge)\b/
const GRAPHQL_REVIEW_RE = /\b(?:addPullRequestReview|submitPullRequestReview)\b/
const REVIEW_SUBMIT_RE = /\/pulls\/[^\s/'"]+\/reviews(?:\/[^\s/'"]+\/events)?(?=$|[\s'"?#])/
const REVIEW_EVENT_RE = /\bevent["']?\s*[=:]\s*["']?([A-Za-z_]+)/gi
const SUBST = '__SUBST__'
const GH_SUBST = '__GH_SUBST__'

const unquote = (t: string) => t.replace(/^['"]+|['"]+$/g, '')
const isGhBin = (t: string) => t === GH_SUBST || t.split('/').pop() === 'gh'
const isApproveFlag = (a: string) => /^--approve(?:=|$)/.test(a) || /^-[A-Za-z]*a[A-Za-z]*$/.test(a)

// $(…) and `…` are taken out of the command: the outer text keeps a placeholder (so `pulls/$(…)/merge` stays one
// endpoint) and the inner commands are classified on their own.
function splitSubstitutions(command: string): { outer: string; inner: string[] } {
  let outer = ''
  const inner: string[] = []
  const take = (body: string) => { inner.push(body); outer += /\bgh\b/.test(body) ? GH_SUBST : SUBST }
  for (let i = 0; i < command.length; i++) {
    if (command[i] === '$' && command[i + 1] === '(') {
      let depth = 1
      let j = i + 2
      for (; j < command.length && depth; j++) {
        if (command[j] === '(') depth++
        else if (command[j] === ')') depth--
      }
      take(command.slice(i + 2, depth ? j : j - 1))
      i = j - 1
    } else if (command[i] === '`') {
      const end = command.indexOf('`', i + 1)
      take(command.slice(i + 1, end < 0 ? command.length : end))
      i = end < 0 ? command.length : end
    } else {
      outer += command[i]
    }
  }
  return { outer, inner }
}

function tokensOf(segment: string): string[] {
  let seg = segment.trim()
  for (let m = seg.match(SHELL_WRAPPER_RE); m; m = seg.match(SHELL_WRAPPER_RE)) seg = m[1]!.trim()
  return seg.split(/\s+/).map(unquote).filter(Boolean)
}

function commandStart(tokens: string[]): number {
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]!
    if (ENV_ASSIGN_RE.test(t)) { i++; continue }
    if (!CMD_PREFIX_WORDS.has(t)) break
    i++
    const valueFlags = PREFIX_VALUE_FLAGS[t] ?? []
    while (tokens[i]?.startsWith('-')) {
      const f = tokens[i++]!
      if (f === '--') break
      if (valueFlags.includes(f)) i++
    }
    if (t === 'timeout' && /^\d+(?:\.\d+)?[smhd]?$/.test(tokens[i] ?? '')) i++
  }
  return i
}

function skipGhFlags(args: string[], i: number): number {
  while (args[i]?.startsWith('-')) i += GH_GLOBAL_VALUE_FLAGS.has(args[i]!) ? 2 : 1
  return i
}

// A review submission is an approval unless every event the command shows is COMMENT or REQUEST_CHANGES
// (a payload from a file or stdin cannot be read, so it counts as an approval).
function reviewEventClass(whole: string): GithubCommandClass {
  const events = [...whole.matchAll(REVIEW_EVENT_RE)].map((m) => m[1]!.toUpperCase())
  return events.length && events.every((e) => e === 'COMMENT' || e === 'REQUEST_CHANGES') ? 'github-write' : 'approve-merge'
}

function classifyGhApi(args: string[], segment: string, whole: string): GithubCommandClass | null {
  let method: string | null = null
  let hasBody = false
  let bodyFromFile = false
  let endpoint: string | null = null
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '-X' || a === '--method') method = (args[i + 1] ?? '').toUpperCase()
    else if (a.startsWith('--method=')) method = a.slice('--method='.length).toUpperCase()
    else if (/^-X[A-Za-z]+$/.test(a)) method = a.slice(2).toUpperCase()
    else if (a === '--input' || a.startsWith('--input=')) { hasBody = true; bodyFromFile = true }
    else if (/^(?:-F|--field)(?:$|=)/.test(a) || /^-F.+/.test(a)) {
      hasBody = true
      if (/=@/.test(a === '-F' || a === '--field' ? (args[i + 1] ?? '') : a)) bodyFromFile = true
    } else if (/^(?:-f|--raw-field)(?:$|=)/.test(a) || /^-f.+/.test(a)) hasBody = true
    else if (!a.startsWith('-') && endpoint === null) endpoint = a
    if (GH_API_VALUE_FLAGS.has(a)) i++
  }
  if (endpoint === 'graphql') {
    if (bodyFromFile) return 'approve-merge' // the query is not on the command line
    if (!/\bmutation\b/.test(whole)) return null
    if (GRAPHQL_MERGE_RE.test(whole)) return 'approve-merge'
    return GRAPHQL_REVIEW_RE.test(whole) ? reviewEventClass(whole) : 'github-write'
  }
  // gh switches to POST as soon as a field or an input body is given.
  const effective = method || (hasBody ? 'POST' : 'GET')
  if (effective === 'GET' || effective === 'HEAD') return null
  if (/\/pulls\/[^\s/'"]+\/merge\b/.test(segment) || /\/merges\b/.test(segment)) return 'approve-merge'
  if (REVIEW_SUBMIT_RE.test(segment)) return reviewEventClass(whole)
  return 'github-write'
}

// Fail closed when gh is not in command position (an unknown wrapper, awk system(), …): only a visible
// `pr merge` / `pr review --approve` after a gh word counts.
function fallbackClass(tokens: string[]): GithubCommandClass | null {
  const g = tokens.findIndex((t) => isGhBin(t) || /["'({]gh$/.test(t))
  if (g < 0) return null
  for (let i = g + 1; i < tokens.length; i++) {
    if (tokens[i] !== 'pr') continue
    const s = skipGhFlags(tokens, i + 1)
    if (tokens[s] === 'merge') return 'approve-merge'
    if (tokens[s] === 'review' && tokens.slice(s + 1).some(isApproveFlag)) return 'approve-merge'
  }
  return null
}

function classifyGhSegment(segment: string, whole: string): GithubCommandClass | null {
  const tokens = tokensOf(segment)
  const start = commandStart(tokens)
  const bin = tokens[start]
  if (!bin) return null
  if (!isGhBin(bin)) return TEXT_ONLY_COMMANDS.has(bin.split('/').pop()!) ? null : fallbackClass(tokens.slice(start))
  const args = tokens.slice(start + 1)
  const ci = skipGhFlags(args, 0)
  const cmd = args[ci]
  if (cmd === 'api') return classifyGhApi(args.slice(ci + 1), segment, whole)
  const si = skipGhFlags(args, ci + 1)
  const sub = args[si]
  const rest = args.slice(si + 1)
  if (cmd === 'pr' && sub === 'merge') return 'approve-merge'
  if (cmd === 'pr' && sub === 'review' && rest.some(isApproveFlag)) return 'approve-merge'
  if (cmd && sub && GH_WRITE_SUBCOMMANDS[cmd]?.has(sub)) return 'github-write'
  return null
}

// Shared by the Claude session hook and the Codex guards: what a shell command would do on GitHub through `gh`.
// Every segment of a && ; || | chain, subshell and $(…) / `…` substitution is classified; the most severe class wins.
export function classifyGithubCommand(command: string): GithubCommandClass | null {
  const text = String(command || '')
  const { outer, inner } = splitSubstitutions(text)
  const classes = [...outer.split(/&&|\|\||[;|&\n()]/).map((seg) => classifyGhSegment(seg, text)), ...inner.map(classifyGithubCommand)]
  if (classes.includes('approve-merge')) return 'approve-merge'
  return classes.includes('github-write') ? 'github-write' : null
}

// MCP tools (a GitHub MCP server, a plugin) reach GitHub without a shell: the approve / merge rule applies by tool
// name and input.
export function classifyMcpToolCall(name: string, input: unknown): GithubCommandClass | null {
  const tool = name.split('__').slice(2).join('__') || name
  const words = tool.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z]+/)
  if (words.some((w) => w === 'merge' || w === 'automerge' || w.startsWith('approv'))) return 'approve-merge'
  let text = ''
  try { text = JSON.stringify(input ?? {}) } catch { /* unserialisable input */ }
  if (/"(?:event|review_?event)"\s*:\s*"APPROVE"/i.test(text) || /"[A-Za-z_]*auto_?merge[A-Za-z_]*"\s*:/i.test(text)) return 'approve-merge'
  return null
}

export function isForbiddenRemoteOrGitMutation(command: string, opts: { allowLocalGitMutation?: boolean } = {}): boolean {
  return GIT_REMOTE_MUTATION_RE.test(command)
    || GH_MUTATION_RE.test(command)
    || GH_API_MUTATION_RE.test(command)
    || classifyGithubCommand(command) !== null
    || (!opts.allowLocalGitMutation && GIT_LOCAL_MUTATION_RES.some((re) => re.test(command)))
}

export type CodexCommandGuardScope = 'readonly' | 'fix' | 'feature' | 'global'

export function shouldBlockCodexCommand(
  command: string,
  opts: { scope: CodexCommandGuardScope; allowDanger?: boolean },
): boolean {
  if (opts.scope !== 'global' && classifyGithubCommand(command) === 'approve-merge') return true
  if (opts.scope === 'global' || opts.allowDanger) return false
  return isForbiddenRemoteOrGitMutation(command)
}
