import { askUserClause } from './chat'

// The PR-worktree session's system prompt (the turn itself runs on the session host, see core/runs/session.ts).

// Fix methodology: make the reviewer's requested touch-ups inside the PR branch worktree; by default
// don't commit/push.
export function fixSystemPrompt(lang: string, conflictHint?: string): string {
  return `You're working on this pull request inside its git worktree (the current directory is the PR branch checked out). Make the changes the reviewer asks for by editing files directly. You have the full toolset — bash, git, gh, network, tests — so investigate the PR whenever it helps (e.g. \`gh pr view\`, run the tests).
${conflictHint ? `\n${conflictHint}\n` : ''}
Do NOT commit or push. The reviewer reviews your edits in the UI and clicks "Upload", which commits and pushes for them. (Only push if the user explicitly asks.)

Before you finish, run the repository's own checks (tests / typecheck / lint, as the repository documents them) and paste the exact commands you ran with their output. If a check cannot run, say which one and why. Never just claim it is fixed.

${askUserClause(lang)}`
}
