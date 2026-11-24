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
const CMD_PREFIX_WORDS = new Set(['command', 'exec', 'env', 'time', 'nohup', 'sudo', 'builtin'])
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/
const SHELL_WRAPPER_RE = /^(?:\S*\/)?(?:ba|z|da|k|fi)?sh\s+(?:-[A-Za-z]+\s+)*-[A-Za-z]*c\s+(.*)$/s
const GRAPHQL_MERGE_RE = /\b(?:mergePullRequest|enablePullRequestAutoMerge)\b/
const GRAPHQL_APPROVE_RE = /\b(?:addPullRequestReview|submitPullRequestReview)\b[\s\S]*\bAPPROVE\b/

const unquote = (t: string) => t.replace(/^['"]+|['"]+$/g, '')

function ghArgsOf(segment: string): string[] | null {
  let seg = segment.trim()
  for (let m = seg.match(SHELL_WRAPPER_RE); m; m = seg.match(SHELL_WRAPPER_RE)) seg = m[1]!.trim()
  const tokens = seg.split(/\s+/).map(unquote).filter(Boolean)
  let i = 0
  while (i < tokens.length && (ENV_ASSIGN_RE.test(tokens[i]!) || CMD_PREFIX_WORDS.has(tokens[i]!))) i++
  const bin = tokens[i]
  if (!bin || bin.split('/').pop() !== 'gh') return null
  return tokens.slice(i + 1)
}

function classifyGhApi(args: string[], segment: string): GithubCommandClass | null {
  let method: string | null = null
  let hasBody = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '-X' || a === '--method') method = (args[++i] ?? '').toUpperCase()
    else if (a.startsWith('--method=')) method = a.slice('--method='.length).toUpperCase()
    else if (/^-X[A-Za-z]+$/.test(a)) method = a.slice(2).toUpperCase()
    else if (/^(?:-[fF]|--field|--raw-field|--input)(?:$|=)/.test(a) || /^-[fF].+/.test(a)) hasBody = true
  }
  // gh switches to POST as soon as a field or an input body is given.
  const effective = method || (hasBody ? 'POST' : 'GET')
  if (effective === 'GET' || effective === 'HEAD') return null
  if (/\/pulls\/[^\s/'"]+\/merge\b/.test(segment)) return 'approve-merge'
  if (/\/pulls\/[^\s/'"]+\/reviews\b/.test(segment) && /\bevent=["']?APPROVE\b/i.test(segment)) return 'approve-merge'
  return 'github-write'
}

function classifyGhSegment(segment: string, whole: string): GithubCommandClass | null {
  const args = ghArgsOf(segment)
  if (!args) return null
  let i = 0
  while (i < args.length && args[i]!.startsWith('-')) i += GH_GLOBAL_VALUE_FLAGS.has(args[i]!) ? 2 : 1
  const cmd = args[i]
  const sub = args[i + 1]
  const rest = args.slice(i + 2)
  if (cmd === 'api') {
    const apiArgs = args.slice(i + 1)
    const c = classifyGhApi(apiArgs, segment)
    if (c && apiArgs.includes('graphql') && (GRAPHQL_MERGE_RE.test(whole) || GRAPHQL_APPROVE_RE.test(whole))) return 'approve-merge'
    return c
  }
  if (cmd === 'pr' && sub === 'merge') return 'approve-merge'
  if (cmd === 'pr' && sub === 'review' && rest.some((a) => /^--approve(?:=|$)/.test(a) || /^-[A-Za-z]*a[A-Za-z]*$/.test(a))) return 'approve-merge'
  if (cmd && sub && GH_WRITE_SUBCOMMANDS[cmd]?.has(sub)) return 'github-write'
  return null
}

// Shared by the Claude session hook and the Codex guards: what a shell command would do on GitHub through `gh`.
// Every segment of a && ; || | chain (and $(…) / subshells) is classified; the most severe class wins.
export function classifyGithubCommand(command: string): GithubCommandClass | null {
  const segments = String(command || '').split(/&&|\|\||\$\(|[;|&\n`()]/)
  let found: GithubCommandClass | null = null
  for (const seg of segments) {
    const c = classifyGhSegment(seg, command)
    if (c === 'approve-merge') return c
    if (c) found = c
  }
  return found
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
