import assert from 'node:assert/strict'
import { languageHold, makePrintEnglish, stripWrapperFence, untranslatedLine } from '../core/github/post'

// What reaches a PR has to be English: the reader-side check behind the preview warning and the unattended-publish hold.

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

// ── a sentence wrapped in backticks is still prose ──
assert.equal(
  untranslatedLine('**[Medium] Unbounded read**\n\n`仍无上限约束，隐藏集依旧全量物化。`'),
  '仍无上限约束，隐藏集依旧全量物化。',
  'backticks do not launder a sentence',
)

// ── only a wrapper fence around the whole answer is stripped ──
const endsWithCode = '**[Low] Hardcoded label**\n\nUse the key:\n\n```ts\nconst msg = "未知标签"\n```'
assert.equal(stripWrapperFence(endsWithCode), endsWithCode, 'a body ending in a code block keeps its closing fence')
assert.equal(untranslatedLine(stripWrapperFence(endsWithCode)), null, 'so the literal inside it is not reported')
assert.equal(stripWrapperFence('```markdown\n**[High] Fix the race**\n```'), '**[High] Fix the race**')
assert.equal(stripWrapperFence('```\n**[High] Fix the race**\n```\n'), '**[High] Fix the race**')

// ── the corrective pass: retried once on a leak; if the retry fails, the first answer is kept ──
const english = '**[High] Fix the race**\n\nThe claim is not atomic.'
const leaky = '**[High] Fix the race**\n\n这里没翻译。'
let calls = 0
assert.equal(await makePrintEnglish(async () => { calls++; return english })('p'), english)
assert.equal(calls, 1, 'no leak, no retry')
calls = 0
assert.equal(await makePrintEnglish(async () => (++calls === 1 ? leaky : english))('p'), english)
assert.equal(calls, 2, 'a leak gets exactly one corrective pass')
calls = 0
assert.equal(await makePrintEnglish(async () => { if (++calls === 1) return leaky; throw new Error('timeout') })('p'), leaky, 'a failed retry keeps the mostly-English first answer')
await assert.rejects(makePrintEnglish(async () => { throw new Error('down') })('p'), /down/, 'a failed first pass is still a failure')

// ── unattended publishes hold on any warning; a human who saw the preview may accept it ──
const warnings = [{ fid: 'F1', kind: 'failed' as const, sample: '' }]
assert.equal(languageHold([], false), null)
assert.equal(languageHold(undefined, false), null)
assert.match(languageHold(warnings, false)!, /1 条没转成英文/)
assert.equal(languageHold(warnings, true), null)

// ── kana and hangul are source language too ──
assert.equal(untranslatedLine('**[Low] Title**\n\nまだ翻訳されていない'), 'まだ翻訳されていない')
assert.equal(untranslatedLine('**[Low] Title**\n\n아직 번역되지 않음'), '아직 번역되지 않음')

// ── a quoted literal from the code is code, however long; a bare sentence in backticks is not ──
assert.equal(untranslatedLine("**[Low] Stale message**\n\nThe 409 still says `'评论正在发布中或状态已变化，请稍后再试'`."), null)
assert.equal(untranslatedLine('**[Low] x**\n\n`仍无上限约束，隐藏集依旧全量物化。`'), '仍无上限约束，隐藏集依旧全量物化。')

// ── a body that starts and ends with its own code blocks keeps both fences ──
const codeSandwich = '```ts\nconst a = 1\n```\n\nThen:\n\n```ts\nconst b = 2\n```'
assert.equal(stripWrapperFence(codeSandwich), codeSandwich)

// ── an empty translation is a failure (it would post the source-language title, unflagged) ──
await assert.rejects(makePrintEnglish(async () => '   ')('p'), /empty translation/)
let n2 = 0
assert.equal(await makePrintEnglish(async () => (++n2 === 1 ? leaky : ''))('p'), leaky, 'an empty corrective answer keeps the first one')

// ── a failed preface is left out of the post, so it does not hold it; an untranslated one does ──
assert.equal(languageHold([{ fid: 'notes', kind: 'failed', sample: '' }], false), null)
assert.match(languageHold([{ fid: 'notes', kind: 'untranslated', sample: '前言' }], false)!, /1 条/)

console.log('✓ post language guard')
