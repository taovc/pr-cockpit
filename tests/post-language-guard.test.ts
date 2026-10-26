import assert from 'node:assert/strict'
import { untranslatedLine } from '../core/github/post'

// What reaches a PR has to be English. The re-review branches of the post prompt used to hand the model a long
// source-language verdict without ever saying "translate", and whole comments went out in Chinese — title, prose and
// all. The prompt now says it in every branch; this is the reader-side guard that catches the times it still doesn't,
// so the preview can warn instead of publishing quietly.

// ── prose in the source language is a leak, and the reported line is the offending one ──
assert.equal(untranslatedLine('**[High] Fix the race**\n\nThe claim is not atomic.'), null)
assert.equal(
  untranslatedLine('**[High] 解决与目标分支的合并冲突**\n\nThe merge is stale.'),
  '**[High] 解决与目标分支的合并冲突**',
  'a title left untranslated is reported even when the body is English',
)
assert.equal(
  untranslatedLine('**[Medium] Unbounded read**\n\n仍无上限约束，隐藏集依旧全量物化。'),
  '仍无上限约束，隐藏集依旧全量物化。',
  'a body left untranslated is reported even when the title is English',
)
assert.equal(untranslatedLine(''), null)
assert.equal(untranslatedLine(undefined as unknown as string), null)

// ── code is exempt: a review quotes code for a living ──
assert.equal(
  untranslatedLine('**[Low] Hardcoded label**\n\nThe literal `未知标签` is compared by value.'),
  null,
  'a source-language string literal inside backticks is supposed to survive verbatim',
)
assert.equal(
  untranslatedLine('**[Low] Hardcoded label**\n\n```ts\nconst msg = "未知标签"\n```\n\nCompare by key instead.'),
  null,
  'so is one inside a fenced block',
)
assert.equal(
  untranslatedLine('<!-- mr:fid=F2 sev=High 备注 -->\n**[High] Unbounded read**'),
  null,
  'our own HTML marker is not published prose',
)

// ── the exemption stops at the fence: prose outside it still counts ──
assert.equal(
  untranslatedLine('```ts\nconst msg = "未知标签"\n```\n\n这里没翻译。'),
  '这里没翻译。',
  'a fenced block does not launder the prose that follows it',
)

// ── CJK punctuation and fullwidth forms count as source language too ──
assert.equal(untranslatedLine('The claim is not atomic（see below）'), 'The claim is not atomic（see below）')

console.log('✓ post language guard')
