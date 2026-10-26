<script setup lang="ts">
import { reviewSectionRe } from '~core/agent/reviewSections'
import { isRecheckResolved, stanceOf } from '~core/recheckAxes'

const props = defineProps<{ projectId: string; prNumber: number; reviewId: string | null }>()
const emit = defineEmits<{ created: [id: string]; changed: [] }>()
const { t, locale } = useI18n()

type Finding = {
  id: string; fid: string; severity: 'High' | 'Medium' | 'Low'; title: string
  location: string | null; problem: string | null; detail: string | null; fix: string | null
  introducedByPr: boolean; checked: boolean; notes: string | null; verifyStatus?: 'confirmed' | 'refuted' | 'unsure' | null; verifyNote?: string | null
  rechecks: { round: number; status: string; stance?: string | null; stanceReason?: string | null; text: string | null; at: string }[]
}
type RunInfo = { id: string; subkind: string; provider: string; model: string | null; effort: string | null; status: string; costUsd: number | null; costSource: string | null; inputTokens: number; outputTokens: number; durationMs: number; skillVersion: number | null; skillName: string | null } | null
type ReviewData = {
  review: any
  findings: Finding[]
  posts: { round: number; url: string; mode: string; at: string }[]
  events: { ts: string; kind: string; message: string | null }[]
  run: RunInfo // the latest agent run (cost / tokens / model / skill version), null for legacy reviews
  totalCostUsd: number | null // all runs of this review added up (null when nothing was priced)
}

const rid = ref<string | null>(props.reviewId)
watch(() => props.reviewId, (v) => { rid.value = v; if (v) load() })

const data = ref<ReviewData | null>(null)
let adjustedFor: string | null = null // review whose checkboxes were already auto-adjusted from recheck status (adjusted once per open / per recheck)
const live = ref('')
const logLines = ref<string[]>([])
const showLog = ref(false)
const logBox = ref<HTMLElement>()
watch(logLines, () => {
  if (showLog.value) nextTick(() => { if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight })
}, { deep: true })
const busy = ref('')
const preview = ref<any>(null) // dry-run preview of the comment to post (declared early: needed by the unmount guard / PR-switch cleanup)
let es: EventSource | null = null
let alive = true // after unmount, ignore write-backs from in-flight $fetch (closing the drawer while a preview is generating leaves the request running)

async function load() {
  if (!rid.value) return
  const d = await $fetch<ReviewData>(`/api/reviews/${rid.value}`)
  if (!alive) return
  data.value = d
  emit('changed') // tell the page this review's status/content may have changed → refresh the task list
  // backfill the log from historical events (so opening a finished task still shows, line by line, what the agent did back then)
  if (!logLines.value.length && data.value.events?.length) {
    logLines.value = data.value.events
      .filter((e) => e.message)
      .map((e) => `${new Date(e.ts).toLocaleTimeString(locale.value, { hour12: false })}  ${e.message}`)
  }
  // on opening the drawer (and after each recheck), auto-adjust the checkboxes from recheck status — once per review
  if (adjustedFor !== rid.value) {
    adjustedFor = rid.value
    await autoAdjustChecks()
  }
}

// Resolved by the latest round (we retracted it, or the author fixed/replied) → uncheck; still open → check. Only touches
// findings that were rechecked; ones never rechecked stay as they are and the user can still change them by hand.
// Posting follows the checkboxes, so this decides what goes out — a retracted finding must not be ticked back on.
async function autoAdjustChecks() {
  const fs = data.value?.findings ?? []
  const changed: Finding[] = []
  for (const f of fs) {
    if (!f.rechecks.length) continue
    const latest = f.rechecks[f.rechecks.length - 1]!
    const desired = !isRecheckResolved(latest)
    if (f.checked !== desired) { f.checked = desired; changed.push(f) }
  }
  if (!changed.length) return
  // checkedBy:'auto' — a machine adjustment, not a human decision (kept out of the precision metric)
  await Promise.all(changed.map((f) => $fetch(`/api/findings/${f.id}`, { method: 'PATCH', body: { checked: f.checked, checkedBy: 'auto' } }).catch(() => {})))
}
function openSSE() {
  if (!rid.value || !import.meta.client) return
  es?.close()
  es = new EventSource(`/api/reviews/${rid.value}/stream`)
  es.onmessage = (ev) => {
    try {
      const e = JSON.parse(ev.data)
      if (e.message) {
        live.value = e.message
        // scrolling log: line by line, like a terminal
        logLines.value.push(`${new Date().toLocaleTimeString(locale.value, { hour12: false })}  ${e.message}`)
        if (logLines.value.length > 200) logLines.value.shift()
      }
      if (e.kind === 'recheck') adjustedFor = null // after a recheck, adjust the checkboxes once more from the new status
      if (['done', 'recheck', 'posted', 'error', 'status'].includes(e.kind)) load()
    } catch {}
  }
}
watch(rid, (v) => { if (v) { load(); openSSE() } }, { immediate: true })
onBeforeUnmount(() => { alive = false; es?.close() })

// Review status labels: store i18n keys, fall back to the raw status code when missing
const STATUS: Record<string, string> = {
  queued: 'review.status.queued', cloning: 'review.status.cloning', reviewing: 'review.status.reviewing', draft: 'review.status.draft',
  ready_to_post: 'review.status.ready_to_post', posting: 'review.status.posting', posted: 'review.status.posted', recheck_requested: 'review.status.recheck_requested', rechecking: 'review.status.rechecking', error: 'review.status.error',
}
function statusLabel(s: string) { const k = STATUS[s]; return k ? t(k) : s }
const running = computed(() => ['queued', 'cloning', 'reviewing', 'recheck_requested', 'rechecking', 'posting'].includes(data.value?.review?.status))

// Guidance for the very first pass. Without it the first review is blind to intent and the only way to steer is to let
// it go wide once and correct afterwards — which is what every extra round was paying for.
const startInstruction = ref('')

async function startReview() {
  busy.value = 'start'
  try {
    const res = await $fetch<{ created: { id: string }[] }>('/api/reviews', {
      method: 'POST', body: { projectId: props.projectId, pulls: [{ number: props.prNumber }], instruction: startInstruction.value.trim() || undefined },
    })
    const id = res.created[0]?.id
    if (id) { rid.value = id; emit('created', id) }
  } finally { busy.value = '' }
}
// A modal popped inside the drawer gets blocked by USlideover's focus trap and can't be clicked → use in-place two-step confirmation instead, without closing the drawer, so you can watch the log while it runs
const confirming = ref<'' | 'rerun' | 'recheck' | 'fresh' | 'delete'>('')
// fresh=true → full review from scratch (wipes findings/notes);
// false → re-review that keeps findings + notes and judges them round by round.
async function stopRun() {
  busy.value = 'stop'
  try { await $fetch(`/api/reviews/${rid.value}/stop`, { method: 'POST' }) } catch (e: any) { live.value = e?.data?.statusMessage || e?.message || String(e) } finally { busy.value = '' }
}
async function rerun(fresh = false) {
  confirming.value = ''
  busy.value = 'run'; logLines.value = []; showLog.value = true
  try { await $fetch(`/api/reviews/${rid.value}/run`, { method: 'POST', body: { fresh } }); await load() }
  catch (e: any) { live.value = e?.data?.statusMessage || t('review.triggerFailed') }
  finally { busy.value = '' }
}
async function recheck() {
  confirming.value = ''
  busy.value = 'recheck'; logLines.value = []; showLog.value = true
  try { await $fetch(`/api/reviews/${rid.value}/recheck`, { method: 'POST' }); await load() }
  catch (e: any) { live.value = e?.data?.statusMessage || t('review.triggerFailed') }
  finally { busy.value = '' }
}

// findings editing
const saving = ref<Record<string, any>>({})
async function toggleFinding(f: Finding) {
  f.checked = !f.checked
  await $fetch(`/api/findings/${f.id}`, { method: 'PATCH', body: { checked: f.checked, checkedBy: 'human' } })
}

// Cost / usage line for the latest run: "$1.36 · sonnet · high · 84.2k in / 3.1k out · 4m12s · skill v3"
function fmtTok(n: number) { return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n) }
function fmtDur(ms: number) { const s = Math.round(ms / 1000); return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s` }
const runLine = computed(() => {
  const r = data.value?.run
  if (!r) return ''
  const parts: string[] = []
  parts.push(r.costUsd != null ? `$${r.costUsd.toFixed(3)}${r.costSource === 'estimated' ? ' (est.)' : ''}` : t('review.costUnknown'))
  if (data.value?.totalCostUsd != null && data.value.totalCostUsd > (r.costUsd ?? 0) + 1e-9) parts.push(t('review.costTotal', { cost: data.value.totalCostUsd.toFixed(3) }))
  parts.push([r.provider, r.model, r.effort].filter(Boolean).join(' · '))
  if (r.inputTokens || r.outputTokens) parts.push(`${fmtTok(r.inputTokens)} in / ${fmtTok(r.outputTokens)} out`)
  if (r.durationMs) parts.push(fmtDur(r.durationMs))
  if (r.skillVersion != null) parts.push(`${r.skillName || 'skill'} v${r.skillVersion}`)
  return parts.join(' · ')
})
function saveNotes(f: Finding) {
  clearTimeout(saving.value[f.id])
  saving.value[f.id] = setTimeout(() => {
    $fetch(`/api/findings/${f.id}`, { method: 'PATCH', body: { notes: f.notes || '' } })
  }, 600)
}
const gnTimer = ref<any>(null)
function saveGlobalNotes() {
  clearTimeout(gnTimer.value)
  gnTimer.value = setTimeout(() => {
    $fetch(`/api/reviews/${rid.value}`, { method: 'PATCH', body: { globalNotes: data.value?.review.globalNotes || '' } })
  }, 600)
}
const riTimer = ref<any>(null)
function saveInstruction() {
  clearTimeout(riTimer.value)
  riTimer.value = setTimeout(() => {
    $fetch(`/api/reviews/${rid.value}`, { method: 'PATCH', body: { reviewInstruction: data.value?.review.reviewInstruction || '' } })
  }, 600)
}

// Posting: dry-run preview first, then confirm publishing. After unmount (drawer closed) ignore write-backs, so they don't leak into the next PR.
async function doPreview(force = false) {
  busy.value = 'preview'
  try {
    const res = await $fetch<{ assembled: any }>(`/api/reviews/${rid.value}/post`, { method: 'POST', body: { dryRun: true, force } })
    if (alive) preview.value = res.assembled
  } catch (e: any) { if (alive) live.value = e?.data?.statusMessage || t('review.previewFailed') }
  finally { busy.value = '' }
}
async function confirmPost() {
  busy.value = 'post'
  try {
    const res = await $fetch<{ url: string }>(`/api/reviews/${rid.value}/post`, { method: 'POST', body: { dryRun: false, acceptLangWarnings: true } })
    if (!alive) return
    preview.value = null; live.value = t('review.published', { url: res.url }); await load()
  } catch (e: any) { if (alive) live.value = e?.data?.statusMessage || t('review.publishFailed') }
  finally { busy.value = '' }
}
// Delete the review task (local only; comments already posted on GitHub are kept) → back to "start review", can be run again. Especially useful after an error.
async function deleteReview() {
  confirming.value = ''
  busy.value = 'delete'
  try {
    await $fetch(`/api/reviews/${rid.value}`, { method: 'DELETE' })
    if (!alive) return
    data.value = null; preview.value = null; live.value = ''; logLines.value = []
    rid.value = null
    emit('changed')
  } catch (e: any) { if (alive) live.value = e?.data?.statusMessage || t('common.failed') }
  finally { busy.value = '' }
}

// Section labels are written by the AI in the current working language; the matcher lives in
// ~core/agent/reviewSections next to the prompt that dictates them, so the two cannot drift apart.
const SECTION_RE = reviewSectionRe()

// A readability pre-pass, run before the markdown renderer: the AI often writes the requirement / test path as one
// run-on block, so line breaks go in ahead of enumerations and section labels (the renderer has breaks:true, so a
// single newline becomes a line break rather than being collapsed).
function fmt(t?: string | null) {
  if (!t) return ''
  return t
    // line break before circled numbers
    .replace(/([^\n])\s*([①②③④⑤⑥⑦⑧⑨⑩⑪⑫])/g, '$1\n$2')
    // line break + indent before letter enumerations like a) b) (negative lookbehind avoids hitting letters inside a word)
    .replace(/([^A-Za-z\n])\s*([a-h][)）])\s*/g, '$1\n　$2 ')
    // blank line before known section labels
    .replace(SECTION_RE, '\n\n$1$2')
    .replace(/^\n+/, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const checkedCount = computed(() => data.value?.findings.filter((f) => f.checked).length ?? 0)
const sevCls: Record<string, string> = { High: 'text-highlighted font-medium', Medium: 'text-toned', Low: 'text-dimmed' }
const RC: Record<string, string> = {
  fixed: 'review.rc.fixed', partial: 'review.rc.partial', unaddressed: 'review.rc.unaddressed', replied: 'review.rc.replied', new: 'review.rc.new',
  kept: 'review.rc.kept', retracted: 'review.rc.retracted', adjusted: 'review.rc.adjusted', discuss: 'review.rc.discuss',
}
function rcLabel(s: string) { const k = RC[s]; return k ? t(k) : s }
// Reasons a finding is skipped at post time based on its recheck status (surfaced in the preview)
const SKIP_REASON: Record<string, string> = {
  'replied-no-note': 'review.skipReason.repliedNoNote',
  retracted: 'review.skipReason.retracted',
}
function skipReasonLabel(s: string) { const k = SKIP_REASON[s]; return k ? t(k) : s }
</script>

<template>
  <div class="flex-1 overflow-y-auto px-6 py-5">
    <!-- no task -->
    <div v-if="!rid" class="py-16">
      <p class="text-sm text-dimmed mb-4 text-center">{{ $t('review.noTask') }}</p>
      <div class="max-w-xl mx-auto">
        <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed mb-1">{{ $t('review.startInstructionLabel') }}</div>
        <textarea
          v-model="startInstruction" rows="2"
          :placeholder="$t('review.startInstructionPlaceholder')"
          class="w-full text-sm bg-muted border border-default rounded px-2 py-1 resize-y outline-none focus:border-accented"
        />
        <p class="text-[11px] text-dimmed mt-1">{{ $t('review.startInstructionHint') }}</p>
      </div>
      <div class="text-center mt-4">
        <button class="text-sm bg-inverted text-inverted px-5 py-2 hover:bg-inverted/90 disabled:opacity-40" :disabled="busy === 'start'" @click="startReview">
          {{ busy === 'start' ? $t('review.creatingTask') : $t('review.startReview') }}
        </button>
      </div>
    </div>

    <template v-else-if="data">
      <!-- status + actions -->
      <div class="flex items-center justify-between gap-3 mb-1">
        <div class="text-sm">
          <span class="text-dimmed">{{ $t('review.statusLabel') }}</span>
          <span class="ml-2" :class="data.review.status === 'error' ? 'text-highlighted font-medium' : 'text-highlighted'">{{ statusLabel(data.review.status) }}</span>
          <span v-if="data.review.authorUpdated" class="ml-2 text-xs text-highlighted font-medium" :title="$t('review.authorUpdatedTitle')">● {{ $t('project.authorUpdated') }}</span>
        </div>
        <div class="flex items-center gap-3 text-xs">
          <button v-if="running && !confirming" class="text-highlighted font-medium hover:underline disabled:opacity-40" :disabled="busy === 'stop'" @click="stopRun">{{ $t('review.stop') }}</button>
          <template v-if="confirming === 'rerun'">
            <span class="text-dimmed">{{ $t('review.rerunConfirm') }}</span>
            <button class="text-highlighted font-medium hover:underline disabled:opacity-40" :disabled="!!busy" @click="rerun()">{{ $t('review.startRerun') }}</button>
            <button class="text-dimmed hover:text-highlighted" @click="confirming = ''">{{ $t('common.cancel') }}</button>
          </template>
          <template v-else-if="confirming === 'recheck'">
            <span class="text-dimmed">{{ $t('review.recheckConfirm') }}</span>
            <button class="text-highlighted font-medium hover:underline disabled:opacity-40" :disabled="!!busy" @click="recheck">{{ $t('review.startRecheck') }}</button>
            <button class="text-dimmed hover:text-highlighted" @click="confirming = ''">{{ $t('common.cancel') }}</button>
          </template>
          <template v-else-if="confirming === 'fresh'">
            <span class="text-dimmed">{{ $t('review.freshConfirm') }}</span>
            <button class="text-highlighted font-medium hover:underline disabled:opacity-40" :disabled="!!busy" @click="rerun(true)">{{ $t('review.startFresh') }}</button>
            <button class="text-dimmed hover:text-highlighted" @click="confirming = ''">{{ $t('common.cancel') }}</button>
          </template>
          <template v-else-if="confirming === 'delete'">
            <span class="text-dimmed">{{ $t('review.deleteConfirm') }}</span>
            <button class="text-error font-medium hover:underline disabled:opacity-40" :disabled="!!busy" @click="deleteReview">{{ $t('common.delete') }}</button>
            <button class="text-dimmed hover:text-highlighted" @click="confirming = ''">{{ $t('common.cancel') }}</button>
          </template>
          <template v-else>
            <!-- Restarts a full review from scratch (wipes findings + notes) → inline confirmation. Available in error/draft. -->
            <button v-if="data.review.status === 'error' || data.review.status === 'draft'" class="bg-inverted text-inverted px-3 py-1 hover:bg-inverted/90 disabled:opacity-40" :disabled="running || !!busy" :title="$t('review.retryTitle')" @click="confirming = 'fresh'">{{ $t('review.retryBtn') }}</button>
            <button class="text-muted hover:text-highlighted disabled:opacity-40" :disabled="running || !!busy" :title="$t('review.rerunTitle')" @click="confirming = 'rerun'">{{ $t('review.rerunBtn') }}</button>
            <button class="hover:text-highlighted disabled:opacity-40" :class="data.review.authorUpdated ? 'text-highlighted font-medium' : 'text-muted'" :disabled="running || !!busy" :title="$t('review.recheckTitle')" @click="confirming = 'recheck'">{{ $t('review.recheckBtn') }}</button>
            <button class="text-muted hover:text-error disabled:opacity-40" :disabled="running || !!busy" :title="$t('review.deleteTitle')" @click="confirming = 'delete'">{{ $t('review.deleteBtn') }}</button>
          </template>
        </div>
      </div>
      <div v-if="running || live || logLines.length" class="text-xs text-dimmed mb-2">
        <div class="flex items-center gap-2">
          <span class="min-w-0 truncate flex-1">
            <span v-if="running" class="inline-block w-1.5 h-1.5 rounded-full bg-inverted animate-pulse mr-1.5" />{{ running ? (live || $t('review.processing')) : $t('review.runLog', { count: logLines.length }) }}
          </span>
          <button v-if="logLines.length" class="text-dimmed hover:text-highlighted shrink-0" @click="showLog = !showLog">
            {{ showLog ? $t('review.collapseLog') : $t('review.expandLog', { count: logLines.length }) }}
          </button>
        </div>
        <!-- scrolling log: the agent's actions, line by line (read file / grep / git diff …)-->
        <pre v-if="showLog && logLines.length" ref="logBox" class="mt-2 max-h-56 overflow-auto bg-neutral-900 text-neutral-300 rounded p-2 text-[11px] leading-relaxed font-mono whitespace-pre-wrap">{{ logLines.join('\n') }}</pre>
      </div>
      <p v-if="data.review.error" class="text-xs text-highlighted border border-default rounded p-2 mb-4 whitespace-pre-wrap">{{ data.review.error }}</p>
      <!-- latest run: cost / tokens / model / skill version (observability) -->
      <p v-if="runLine" class="text-[11px] text-dimmed font-mono mb-3" :title="$t('review.runLineTitle')">{{ runLine }}</p>

      <!-- AI summary (pinned to the top) -->
      <section v-if="data.review.conclusion" class="mb-5 border border-default rounded p-3">
        <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed mb-1">{{ $t('review.aiSummary') }}</div>
        <MarkdownBody :text="fmt(data.review.conclusion)" />
      </section>

      <!-- review instruction for the AI (consulted on "recheck against my feedback") -->
      <section class="mb-6">
        <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed mb-1">{{ $t('review.instructionLabel') }}</div>
        <textarea
          v-model="data.review.reviewInstruction" rows="2"
          :placeholder="$t('review.instructionPlaceholder')"
          class="w-full text-sm bg-muted border border-default rounded px-2 py-1 resize-y outline-none focus:border-accented"
          @input="saveInstruction"
        />
      </section>

      <!-- requirement / test path -->
      <template v-if="data.review.requirement || data.review.testPath">
        <section v-if="data.review.requirement" class="mb-4">
          <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed mb-1">{{ $t('review.requirement') }}</div>
          <MarkdownBody :text="fmt(data.review.requirement)" />
        </section>
        <section v-if="data.review.testPath" class="mb-5">
          <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed mb-1">{{ $t('review.testPath') }}</div>
          <MarkdownBody :text="fmt(data.review.testPath)" />
        </section>
      </template>

      <!-- findings -->
      <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed mb-2">{{ $t('review.findings', { count: data.findings.length }) }}</div>
      <div v-for="f in data.findings" :key="f.id" class="border-t border-default py-3">
        <div class="flex gap-3 items-start">
          <input type="checkbox" class="accent-neutral-900 dark:accent-neutral-100 mt-1" :checked="f.checked" @change="toggleFinding(f)" />
          <div class="min-w-0 flex-1">
            <div class="text-sm">
              <span class="text-xs mr-1" :class="sevCls[f.severity]">[{{ f.severity }}]</span><MarkdownBody :text="f.title" inline />
            </div>
            <div class="text-xs text-dimmed mt-0.5">{{ f.location }}<span v-if="!f.introducedByPr"> {{ $t('review.preExisting') }}</span><span v-if="f.verifyStatus === 'refuted'" class="ml-1 text-highlighted" :title="f.verifyNote || ''">⊘ {{ $t('review.verifyRefuted') }}</span><span v-else-if="f.verifyStatus === 'confirmed'" class="ml-1" :title="f.verifyNote || ''">✓ {{ $t('review.verifyConfirmed') }}</span><span v-else-if="f.verifyStatus === 'unsure'" class="ml-1" :title="f.verifyNote || ''">? {{ $t('review.verifyUnsure') }}</span></div>
            <MarkdownBody v-if="f.problem" :text="f.problem" class="mt-1" />
            <details v-if="f.detail || f.fix" class="mt-1">
              <summary class="text-xs text-dimmed cursor-pointer">{{ $t('review.detailFix') }}</summary>
              <MarkdownBody v-if="f.detail" :text="f.detail" class="text-xs mt-1" />
              <MarkdownBody v-if="f.fix" :text="f.fix" class="text-xs bg-muted border border-default rounded p-2 mt-1 overflow-x-auto" />
            </details>
            <div v-for="r in f.rechecks" :key="r.round" class="text-xs mt-2 border-l-2 border-default pl-2">
              <span class="font-medium">🔁 {{ $t('review.recheckRound', { round: r.round }) }} · {{ rcLabel(r.status) }}<template v-if="stanceOf(r)"> · {{ rcLabel(stanceOf(r)!) }}</template></span>
              <MarkdownBody v-if="r.text" :text="r.text" class="text-muted" />
              <div v-if="r.stanceReason" class="text-muted mt-0.5 flex gap-1"><span class="shrink-0">↳</span><MarkdownBody :text="r.stanceReason" /></div>
            </div>
            <textarea
              v-model="f.notes" rows="1" :placeholder="$t('review.notePlaceholder')"
              class="w-full text-xs bg-muted border border-default rounded px-2 py-1 mt-2 resize-y outline-none focus:border-accented"
              @input="saveNotes(f)"
            />
          </div>
        </div>
      </div>
      <p v-if="!data.findings.length && !running" class="text-sm text-dimmed py-4">{{ $t('review.noFindings') }}</p>

      <!-- global notes + publish -->
      <section v-if="data.findings.length" class="mt-5 border-t border-default pt-4">
        <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed mb-1">{{ $t('review.globalNotesLabel') }}</div>
        <textarea
          v-model="data.review.globalNotes" rows="2" :placeholder="$t('review.globalNotesPlaceholder')"
          class="w-full text-sm bg-muted border border-default rounded px-2 py-1 resize-y outline-none focus:border-accented"
          @input="saveGlobalNotes"
        />
        <div class="flex items-center gap-3 mt-3">
          <button class="text-sm border border-accented px-4 py-1.5 hover:bg-muted disabled:opacity-40" :disabled="!checkedCount || !!busy" @click="doPreview()">
            <span v-if="busy === 'preview'" class="inline-flex items-center gap-1.5"><span class="inline-block w-1.5 h-1.5 rounded-full bg-inverted animate-pulse" />{{ $t('review.generatingPreview') }}</span>
            <span v-else>{{ $t('review.previewComment', { count: checkedCount }) }}</span>
          </button>
          <div v-if="data.posts.length" class="text-xs text-dimmed">
            {{ $t('review.postedTimes', { count: data.posts.length }) }} <a :href="data.posts[data.posts.length - 1]?.url" target="_blank" class="hover:text-highlighted underline">{{ $t('review.latest') }}</a>
          </div>
        </div>

        <!-- dry-run preview -->
        <div v-if="preview" class="mt-3 border border-default rounded p-3">
          <div class="flex items-center justify-between mb-2">
            <span class="text-xs text-dimmed">{{ $t('review.previewMeta', { count: preview.comments.length, mode: preview.mode }) }}<span v-if="preview.skipped?.length"> · {{ $t('review.previewSkipped', { count: preview.skipped.length }) }}</span></span>
            <div class="flex gap-3 items-center">
              <button class="text-xs text-dimmed hover:text-highlighted disabled:opacity-40" :disabled="!!busy" :title="$t('review.regenTitle')" @click="doPreview(true)">
                {{ busy === 'preview' ? $t('review.regenerating') : $t('review.regenerate') }}
              </button>
              <button class="text-xs text-dimmed hover:text-highlighted" @click="preview = null">{{ $t('review.close') }}</button>
              <button class="text-xs bg-inverted text-inverted px-3 py-1 hover:bg-inverted/90 disabled:opacity-40" :disabled="busy === 'post'" @click="confirmPost">
                {{ busy === 'post' ? $t('review.publishing') : $t('review.confirmPublish') }}
              </button>
            </div>
          </div>
          <div v-if="preview.skipped?.length" class="text-xs mb-2 border border-default rounded p-2 bg-muted">
            <div class="text-dimmed mb-1">{{ $t('review.skippedTitle', { count: preview.skipped.length }) }}</div>
            <div v-for="s in preview.skipped" :key="s.fid" class="text-toned">· {{ s.fid }} {{ s.title }} <span class="text-dimmed">— {{ skipReasonLabel(s.reason) }}</span></div>
          </div>
          <!-- What goes on the PR has to be English: say which items came back untranslated (or failed) instead of publishing them quietly -->
          <div v-if="preview.warnings?.length" class="text-xs mb-2 border border-warning rounded p-2 bg-warning/10">
            <div class="text-warning mb-1">{{ $t('review.langWarnTitle', { count: preview.warnings.length }) }}</div>
            <div v-for="w in preview.warnings" :key="w.fid + w.kind" class="text-toned">
              · {{ w.fid === 'notes' ? $t('review.globalNotesLabel') : w.fid }} <span class="text-dimmed">— {{ w.kind === 'untranslated' ? $t('review.langWarnLeak') : w.fid === 'notes' ? $t('review.langWarnNotesFailed') : $t('review.langWarnFailed') }}</span>
              <span v-if="w.sample" class="text-dimmed">: {{ w.sample }}</span>
            </div>
          </div>
          <pre class="text-xs text-toned whitespace-pre-wrap font-sans max-h-60 overflow-y-auto">{{ preview.body }}</pre>
          <div v-for="(c, i) in preview.comments" :key="i" class="text-xs mt-2 border-t border-default pt-2">
            <span class="font-mono text-dimmed">{{ c.path }}:{{ c.line }}</span>
            <pre class="text-toned whitespace-pre-wrap font-sans mt-1">{{ c.body }}</pre>
          </div>
        </div>
      </section>
    </template>

    <p v-else class="text-sm text-dimmed py-8">{{ $t('common.loading') }}</p>
  </div>
</template>
