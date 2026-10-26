import assert from 'node:assert/strict'
import { reviewBashVerdict as v, splitCommand } from '../core/agent/reviewBash'
import { reviewPolicy } from '../core/codex/policy'

// The review family runs only allowlisted read commands: running anything from the PR branch executes the author's
// code with the owner's credentials, and the old blacklist could never list every way to do that.

const allow = [
  'git diff origin/main...HEAD', 'git merge-base HEAD origin/dev', 'git log --oneline -5 2>/dev/null', 'git -C /x --no-pager show HEAD:a.md',
  'git branch --show-current', 'git rev-list --count a..b', 'ls -la 2>&1 | head', 'grep -rn foo . >/dev/null; echo $?',
  'gh pr view 12 --json title', 'gh pr checks 12', 'gh api repos/o/r/pulls/1/files', 'gh api -X GET repos/o/r', 'gh run view 5 --log',
  'sed -n 1,80p a.ts', "sed -n '/foo/p' a.ts", 'sed -n -e 10,20p a.ts', 'rg "TODO" --glob "*.ts"', 'cat a | head', 'nl -ba a.ts | sed -n 10,40p',
  'find . -name "*.ts" | wc -l', 'cd apps && git log -3', 'node --version', 'grep -n "x >= 1" f.ts', 'grep -rn "=>" src | head', "grep -n 'a$' f",
  'jq .scripts package.json', 'sort a | uniq -c',
]
for (const c of allow) assert.equal(v(c).ok, true, `should allow: ${c}`)

const deny: Array<[string, RegExp]> = [
  ['pnpm test', /runs code/], ['npm run build', /runs code/], ['npx vitest', /runs code/], ['node scripts/x.js', /runs code/], ['python3 x.py', /runs code/],
  ['make', /not on the read-only list/], ['./run.sh', /runs a file/], ['bash x.sh', /not on the read-only list/], ['/usr/bin/env node x', /runs a file/],
  ['cat $(echo a)', /expansion/], ['cat `x`', /substitution/], ['cat ${HOME}/x', /expansion/], ['cat $HOME/.ssh/id_rsa', /expansion/],
  ['echo x > a', /redirection/], ['cat <a', /redirection/], ['ls & sleep 1', /background/], ['(cd x; ls)', /subshell/], ["echo 'x", /unbalanced/],
  ['FOO=1 git log', /environment/], ['git -c diff.external=x diff', /git option -c/], ['git grep -O vim x', /-O/], ['git diff --output=x', /--output/],
  ['git log --ext-diff', /--ext-diff/], ['git fetch origin', /not a read command/], ['git checkout main', /not a read command/], ['git branch evil', /creates or changes/],
  ['gh api -X POST x', /POST/], ['gh api --method=DELETE x', /DELETE/], ['gh api x -f a=b', /request body/], ['gh pr checkout 1', /not a read command/],
  ['gh pr comment 1 -b x', /not a read command/], ['gh pr view 1 --web', /browser/], ['find . -exec rm {} ;', /-exec/], ['rg --pre cat x', /--pre/],
  ["sed -n 'e id' a", /sed script/], ['sed -i s/a/b/ f', /sed without -n/], ["sed -n '1w out' a", /sed script/], ['xargs rm', /not on the read-only list/],
  ['awk 1 f', /not on the read-only list/], ['tail -f log', /follow/], ['sort -o x y', /--output/], ['uniq a b', /output file/], ['curl x', /not on the read-only list/],
  ['ls; pnpm test', /runs code/], ['git log | tee out', /not on the read-only list/],
]
for (const [c, why] of deny) {
  const r = v(c)
  assert.equal(r.ok, false, `should deny: ${c}`)
  assert.match((r as any).reason, why, c)
}

// A shell wrapper (how Codex reports commands) is judged by its script.
assert.equal(v("/bin/zsh -lc 'git status | head -5'").ok, true)
assert.equal(v("bash -lc 'pnpm test'").ok, false)
assert.equal(v('bash -c "git log -1"').ok, true)

// Tokenizer details the verdicts rely on.
assert.deepEqual(splitCommand('a "b c" | d && e; f'), { segs: [['a', 'b c'], ['d'], ['e'], ['f']] })
assert.deepEqual(splitCommand("grep 'x|y' f"), { segs: [['grep', 'x|y', 'f']] })
assert.deepEqual(splitCommand('git log 2>&1 | head'), { segs: [['git', 'log'], ['head']] })

// Codex review approvals use the same list.
const rp = reviewPolicy({ allowNetwork: true })
assert.equal(rp.autoDecide!("/bin/zsh -lc 'git diff origin/main...HEAD'"), 'accept')
assert.equal(rp.autoDecide!("/bin/zsh -lc 'pnpm test'"), 'decline')
assert.equal(rp.autoDecide!('gh pr comment 1 --body x'), 'decline')

console.log('✓ review bash allowlist')
