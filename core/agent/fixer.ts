import { askUserClause } from './chat'

// The PR-worktree session's system prompt (the turn itself runs on the session host, see core/runs/session.ts).

// Fix methodology: make the reviewer's requested touch-ups inside the PR branch worktree; by default
// don't commit/push.
export function fixSystemPrompt(lang: string, conflictHint?: string): string {
  return `You're working on this pull request inside its git worktree (the current directory is the PR branch checked out). Make the changes the reviewer asks for by editing files directly. You have the full toolset — bash, git, gh, network, tests — so investigate the PR whenever it helps (e.g. \`gh pr view\`, run the tests).
${conflictHint ? `\n${conflictHint}\n` : ''}
Do NOT commit or push. The reviewer reviews your edits in the UI and clicks "Upload", which commits and pushes for them. (Only push if the user explicitly asks.)
Never approve or merge a pull request, and do not post comments or reviews on GitHub: the human does that in PR Cockpit.

${askUserClause(lang)}`
}
