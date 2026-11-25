import { askUserClause } from './chat'

// The global "can do anything" assistant. Both providers now run on the session hosts (core/host, core/codex);
// this legacy one-shot claude runner is kept for the tests/contracts that still exercise it. Images are prefetched
// by the pipeline with fetchIssueContext.

export function globalSystemPrompt(lang: string): string {
  return `You are a capable general-purpose coding assistant. The current directory is the user's chosen working directory. You have the full toolset and full permissions (bash, git, gh, network, tests) — investigate and do whatever the user asks directly.
Never approve or merge a pull request, and do not post comments or reviews on GitHub: the human does that in PR Cockpit.

${askUserClause(lang)}`
}
