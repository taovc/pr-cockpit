<script setup lang="ts">
const props = defineProps<{
  projectId: string; prNumber: number | null; reviewId: string | null; fixId: string | null; initialTab?: string
  autoReviewOn?: boolean; autoFixOn?: boolean; autoNote?: string | null; autoRound?: number; autoMaxRounds?: number
  autoCoolingUntil?: string | null
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ taskCreated: [] }>()
const { t, te, locale } = useI18n()
// The PR's GitHub lifecycle is the first thing to read when the drawer opens: same badge styling as the PR list.
const PR_STATE: Record<string, { label: string; cls: string }> = {
  open: { label: 'status.pr.open', cls: 'text-default border-accented' },
  merged: { label: 'status.pr.merged', cls: 'text-highlighted border-accented' },
  closed: { label: 'status.pr.closed', cls: 'text-dimmed border-default' },
  draft: { label: 'status.pr.draft', cls: 'text-dimmed border-default' },
}
const prBadge = (state: string) => PR_STATE[state] ?? { label: 'status.pr.unknown', cls: 'text-dimmed border-default' }
const reviewBadge = (decision: string) => (decision === 'APPROVED' ? { label: 'status.pr.approved', cls: 'text-highlighted border-accented' } : decision === 'CHANGES_REQUESTED' ? { label: 'status.pr.changes', cls: 'text-default border-accented' } : null)

// The two per-instance automation switches (auto review / auto fix). Optimistic local state: the switch
// moves immediately instead of waiting for the 8s poll (feels smooth); on failure, or on the next poll,
// it is corrected with the real value. Only the switch itself is clickable (the template uses a div
// rather than a label, so the text doesn't toggle it).
const reviewOnLocal = ref(props.autoReviewOn ?? false)
const fixOnLocal = ref(props.autoFixOn ?? false)
watch(() => props.autoReviewOn, (v) => { reviewOnLocal.value = v ?? false })
watch(() => props.autoFixOn, (v) => { fixOnLocal.value = v ?? false })
async function toggleAuto(field: 'reviewOn' | 'fixOn', value: boolean) {
  if (props.prNumber == null) return
  if (field === 'reviewOn') reviewOnLocal.value = value
  else fixOnLocal.value = value
  try {
    await $fetch(`/api/projects/${props.projectId}/pulls/${props.prNumber}/automation`, { method: 'POST', body: { [field]: value } })
    emit('taskCreated') // triggers the parent's refreshPulls to pull back the effective state/round count
  } catch {
    // failed → roll back the optimistic local value
    if (field === 'reviewOn') reviewOnLocal.value = !value
    else fixOnLocal.value = !value
  }
}
// Why the engine stopped → a one-line hint (capped/converged/cant_fix/...)
const autoNoteText = computed(() => {
  if (!props.autoNote) return ''
  const k = `automation.note.${props.autoNote}`
  return te(k) ? t(k, { round: props.autoRound ?? 0, max: props.autoMaxRounds ?? 0 }) : ''
})
// Cooling down: how many minutes until the automatic run starts (the user can flip the switch off during this window)
const coolingMinLeft = computed(() => {
  if (!props.autoCoolingUntil) return 0
  const ms = Date.parse(props.autoCoolingUntil) - Date.now()
  return ms > 0 ? Math.ceil(ms / 60000) : 0
})

type Detail = {
  number: number; title: string; body: string; author: string; createdAt: string
  state: string; reviewDecision: string; branch: string; additions: number; deletions: number; changedFiles: number
  url: string; files: { path: string; additions: number; deletions: number }[]
  commits: { oid: string; headline: string; date: string; author: string }[]
}
type Node = {
  kind: 'comment' | 'review' | 'commit' | 'event'
  actor: string; isBot: boolean; at: string
  body?: string; state?: string; sha?: string; message?: string; verb?: string; detail?: string
}

type MyReview = { id: number; state: string } | null // the caller's own standing verdict on this PR, from the server
const detail = ref<Detail | null>(null)
const nodes = ref<Node[]>([])
const myReview = ref<MyReview>(null)
const pending = ref(false)
const error = ref('')

const activeTab = ref<'review' | 'fix' | 'timeline' | 'changes' | 'workflow'>('timeline')
const diff = ref<string | null>(null)
const diffTruncated = ref(false)
const diffPending = ref(false)

// ── Automation workflow timeline (what the engine did to this PR) ──
type WfEvent = { id: string; kind: string; ts: string; message: string | null }
const wfEvents = ref<WfEvent[]>([])
const wfPending = ref(false)
let wfTimer: ReturnType<typeof setInterval> | null = null
async function loadWf() {
  if (!props.prNumber) return
  wfPending.value = true
  try {
    const r = await $fetch<{ events: WfEvent[] }>(`/api/projects/${props.projectId}/pulls/${props.prNumber}/automation-events`)
    wfEvents.value = r.events
  } catch { /* silent: the next poll will fetch again */ } finally {
    wfPending.value = false
  }
}
function stopWfPoll() { if (wfTimer) { clearInterval(wfTimer); wfTimer = null } }
// While the automation tab is open, fetch every 5s so workflow progress surfaces live
watch([activeTab, open], ([tabNow, isOpen]) => {
  stopWfPoll()
  if (isOpen && tabNow === 'workflow') {
    loadWf()
    wfTimer = setInterval(() => { if (typeof document === 'undefined' || document.visibilityState !== 'hidden') loadWf() }, 5000)
  }
})
onBeforeUnmount(stopWfPoll)
// Automation event i18n: kind → text (fix_started/capped interpolate message)
const WF_DOT: Record<string, string> = {
  review_created: 'bg-inverted', recheck: 'bg-inverted', posted: 'bg-accented',
  fix_started: 'bg-inverted', pushed: 'bg-accented',
  capped: 'bg-warning', converged: 'bg-success', cant_fix: 'bg-error', fix_error: 'bg-error', post_error: 'bg-error',
  push_error: 'bg-error', fix_unverified: 'bg-warning', cooldown: 'bg-accented',
}
function wfLabel(ev: WfEvent) {
  const k = `automation.event.${ev.kind}`
  if (!te(k)) return ev.message ? `${ev.kind} ${ev.message}` : ev.kind
  return t(k, { round: ev.message ?? '', info: ev.message ?? '' })
}

// ── Approve the PR on GitHub (header button) ──
// Everyone on the repo sees this, so it goes through the drawer's inline confirmation (a modal on top of a
// slideover is not interactive here). Only offered while the PR is open; the two refusals the server names
// — your own PR, a PR that is no longer open — are translated, anything else shows what gh reported.
const { confirming } = useInlineConfirm()
const approving = ref(false)
const approveError = ref('')
const dismissReason = ref('')

// The PR header + timeline in one call; also re-read after an approval so the badge and the timeline show it.
// Two loads can be in flight at once (switching PRs while an approval is finishing), so the late one must not win:
// same load-token + id re-check the other drawers in this repo use.
let loadToken = 0
async function loadDetail(num: number) {
  const my = ++loadToken
  pending.value = true
  try {
    const res = await $fetch<{ detail: Detail; nodes: Node[]; myReview: MyReview }>(
      `/api/projects/${props.projectId}/pulls/${num}/timeline`,
    )
    if (my !== loadToken || num !== props.prNumber) return // stale
    // Rendered by MarkdownBody where they are shown (one shared pipeline, see useMarkdown) rather than
    // pre-rendered into the node list here.
    detail.value = res.detail
    nodes.value = res.nodes
    myReview.value = res.myReview ?? null
  } catch (e: any) {
    if (my !== loadToken || num !== props.prNumber) return
    error.value = e?.data?.statusMessage || e?.message || t('prDrawer.loadFailed')
  } finally {
    if (my === loadToken) pending.value = false
  }
}

watch(
  () => [open.value, props.prNumber] as const,
  async ([isOpen, num]) => {
    if (!isOpen || !num) return
    approveError.value = ''; confirming.value = ''; dismissReason.value = '' // before the same-PR early return: a failed approval must not greet the next open
    if (detail.value?.number === num) return
    detail.value = null; nodes.value = []; myReview.value = null; diff.value = null; wfEvents.value = []
    activeTab.value = (props.initialTab as any) || (props.reviewId ? 'review' : 'timeline'); error.value = ''
    await loadDetail(num)
  },
  { immediate: true },
)

// ── Approve / withdraw on GitHub (header button) ──
// One button, two states: it offers to withdraw once your own approval is standing, and to approve otherwise.
// Drafts are approvable on GitHub, merged/closed ones are not, and your own PR never is — so it is not offered.
const me = ref('')
watch(open, (isOpen) => { if (isOpen && !me.value) $fetch<{ login: string }>('/api/me').then((r) => { me.value = r.login || '' }).catch(() => {}) }, { immediate: true })
// Both actions need a PR GitHub will still act on: it accepts neither an approval nor a dismissal once the PR is
// merged or closed (the dismissal it even accepts silently, changing nothing).
const isLive = computed(() => detail.value?.state === 'open' || detail.value?.state === 'draft')
const notMine = computed(() => !me.value || me.value.toLowerCase() !== (detail.value?.author || '').toLowerCase())
// A dismissed or changes-requested review of ours is not a standing approval; only APPROVED can be withdrawn.
const approvedByMe = computed(() => myReview.value?.state === 'APPROVED')
const canApprove = computed(() => isLive.value && notMine.value && !approvedByMe.value)
const canDismiss = computed(() => isLive.value && approvedByMe.value)
async function approve() {
  const num = props.prNumber
  if (!num || approving.value) return
  approving.value = true
  approveError.value = ''
  try {
    await $fetch(`/api/projects/${props.projectId}/pulls/${num}/approve`, { method: 'POST' })
    confirming.value = ''
    await loadDetail(num) // the APPROVED badge and the new timeline entry come from the server, not from a local guess
    emit('taskCreated') // the list shows the review decision too
  } catch (e: any) {
    const reason = e?.data?.data?.reason
    const key = `prDrawer.approve.${reason}`
    const raw = e?.data?.data?.detail
    approveError.value = reason && te(key)
      ? t(key)
      : raw ? `${t('prDrawer.approve.failed')}: ${raw}` : (e?.data?.statusMessage || t('prDrawer.approve.failed'))
  } finally {
    approving.value = false
  }
}

// GitHub cannot delete a submitted review, so taking an approval back means dismissing it, with a reason everyone on
// the PR will read. The box is optional; empty falls back to the server's default sentence.
async function dismiss() {
  const num = props.prNumber
  if (!num || approving.value) return
  approving.value = true
  approveError.value = ''
  try {
    await $fetch(`/api/projects/${props.projectId}/pulls/${num}/dismiss`, { method: 'POST', body: { message: dismissReason.value.trim() || undefined } })
    confirming.value = ''
    dismissReason.value = ''
    await loadDetail(num) // the button flips back to "approve" off the reloaded review state, not a local guess
    emit('taskCreated')
  } catch (e: any) {
    const reason = e?.data?.data?.reason
    const key = `prDrawer.dismiss.${reason}`
    const raw = e?.data?.data?.detail
    approveError.value = reason && te(key)
      ? t(key)
      : raw ? `${t('prDrawer.dismiss.failed')}: ${raw}` : (e?.data?.statusMessage || t('prDrawer.dismiss.failed'))
  } finally {
    approving.value = false
  }
}

// Only fetch the diff once the changes tab is opened
watch(activeTab, async (nextTab) => {
  if (nextTab !== 'changes' || diff.value !== null || !props.prNumber) return
  diffPending.value = true
  try {
    const res = await $fetch<{ diff: string; truncated: boolean }>(
      `/api/projects/${props.projectId}/pulls/${props.prNumber}/diff`,
    )
    diff.value = res.diff
    diffTruncated.value = res.truncated
  } catch (e: any) {
    diff.value = ''
    error.value = e?.data?.statusMessage || e?.message || t('prDrawer.diffLoadFailed')
  } finally {
    diffPending.value = false
  }
})

// Relative time (localized to the current language; falls back to the local date format past 7 days)
function rel(iso: string) {
  if (!iso) return ''
  const ts = new Date(iso).getTime()
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return t('prDrawer.time.justNow')
  if (s < 3600) return t('prDrawer.time.minutesAgo', { n: Math.floor(s / 60) })
  if (s < 86400) return t('prDrawer.time.hoursAgo', { n: Math.floor(s / 3600) })
  if (s < 86400 * 7) return t('prDrawer.time.daysAgo', { n: Math.floor(s / 86400) })
  return new Date(iso).toLocaleDateString(locale.value)
}

// Review states / event verbs: stored as i18n keys, resolved with t() in the template (falls back when missing)
const REVIEW_STATE: Record<string, string> = {
  approved: 'prDrawer.review.approved', changes_requested: 'prDrawer.review.changesRequested',
  commented: 'prDrawer.review.commented', dismissed: 'prDrawer.review.dismissed',
}
const VERB: Record<string, string> = {
  labeled: 'prDrawer.verb.labeled', unlabeled: 'prDrawer.verb.unlabeled', renamed: 'prDrawer.verb.renamed', referenced: 'prDrawer.verb.referenced',
  head_ref_force_pushed: 'prDrawer.verb.head_ref_force_pushed', head_ref_deleted: 'prDrawer.verb.head_ref_deleted', head_ref_restored: 'prDrawer.verb.head_ref_restored',
  closed: 'prDrawer.verb.closed', merged: 'prDrawer.verb.merged', reopened: 'prDrawer.verb.reopened', ready_for_review: 'prDrawer.verb.ready_for_review',
  convert_to_draft: 'prDrawer.verb.convert_to_draft', review_requested: 'prDrawer.verb.review_requested', review_request_removed: 'prDrawer.verb.review_request_removed',
  assigned: 'prDrawer.verb.assigned', unassigned: 'prDrawer.verb.unassigned', deployed: 'prDrawer.verb.deployed', milestoned: 'prDrawer.verb.milestoned',
}
// Translate known verbs, fall back to the raw verb string for unknown ones
function verbLabel(verb?: string) {
  const k = VERB[verb || '']
  return k ? t(k) : (verb || '')
}

// diff coloring
type DiffLine = { t: 'file' | 'hunk' | 'add' | 'del' | 'meta' | 'ctx'; text: string }
const diffLines = computed<DiffLine[]>(() => {
  if (!diff.value) return []
  return diff.value.split('\n').map((line): DiffLine => {
    if (line.startsWith('diff --git')) return { t: 'file', text: line.replace('diff --git ', '') }
    if (line.startsWith('@@')) return { t: 'hunk', text: line }
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('rename ') || line.startsWith('similarity ')) return { t: 'meta', text: line }
    if (line.startsWith('+')) return { t: 'add', text: line }
    if (line.startsWith('-')) return { t: 'del', text: line }
    return { t: 'ctx', text: line }
  })
})
const lineCls: Record<DiffLine['t'], string> = {
  file: 'text-highlighted font-medium bg-elevated px-3 py-1 mt-3 first:mt-0',
  hunk: 'text-dimmed px-3', add: 'text-success bg-success/10 px-3',
  del: 'text-error bg-error/10 px-3', meta: 'text-dimmed px-3', ctx: 'text-toned px-3',
}
</script>

<template>
  <USlideover v-model:open="open" :ui="{ content: 'w-[100vw] max-w-full min-w-0 md:w-[calc(100vw-15rem)] md:min-w-[640px] md:max-w-none' }">
    <template #content>
      <div class="h-full flex flex-col bg-default text-default">
        <!-- header -->
        <div class="px-6 py-5 border-b border-default shrink-0">
          <div v-if="detail" class="flex items-start justify-between gap-4">
            <div class="min-w-0">
              <div class="flex items-center flex-wrap gap-x-2 gap-y-0.5 text-xs text-dimmed">
                <span class="inline-block whitespace-nowrap text-[10px] uppercase tracking-wider px-2 py-0.5 border rounded-full" :class="prBadge(detail.state).cls">{{ $t(prBadge(detail.state).label) }}</span>
                <span v-if="reviewBadge(detail.reviewDecision)" class="inline-block whitespace-nowrap text-[10px] uppercase tracking-wider px-2 py-0.5 border rounded-full" :class="reviewBadge(detail.reviewDecision)!.cls">{{ $t(reviewBadge(detail.reviewDecision)!.label) }}</span>
                <span class="tabular-nums">#{{ detail.number }}</span>
                <span>·</span><span>{{ detail.author }}</span>
                <span>·</span><span class="font-mono break-all">{{ detail.branch }}</span>
              </div>
              <h2 class="text-lg font-medium mt-1 leading-snug">{{ detail.title }}</h2>
              <div class="text-xs text-dimmed mt-1 tabular-nums">
                {{ $t('prDrawer.filesCount', { count: detail.changedFiles }) }} ·
                <span class="text-success">+{{ detail.additions }}</span>
                <span class="text-error"> −{{ detail.deletions }}</span>
              </div>
            </div>
            <div class="flex items-center justify-end flex-wrap gap-x-3 gap-y-1 shrink-0 max-w-[60%] md:max-w-none">
              <!-- One button, two states: approve while nothing of ours stands, withdraw once it does -->
              <template v-if="confirming === 'approve'">
                <span class="text-xs text-dimmed whitespace-nowrap">{{ $t('prDrawer.approve.confirm') }}</span>
                <button class="text-xs bg-inverted text-inverted px-3 py-1 rounded hover:bg-inverted/90 disabled:opacity-40 whitespace-nowrap" :disabled="approving" @click="approve">{{ approving ? $t('prDrawer.approve.running') : $t('prDrawer.approve.yes') }}</button>
                <button class="text-xs text-dimmed hover:text-highlighted whitespace-nowrap" :disabled="approving" @click="confirming = ''">{{ $t('common.cancel') }}</button>
              </template>
              <template v-else-if="confirming === 'dismiss'">
                <!-- GitHub requires a reason and shows it on the PR timeline; empty falls back to the default sentence -->
                <input v-model="dismissReason" :placeholder="$t('prDrawer.dismiss.reasonPlaceholder')" :disabled="approving" class="text-xs bg-transparent border-b border-default focus:border-inverted outline-none py-0.5 w-40 md:w-56" @keydown.enter="dismiss" />
                <button class="text-xs border border-error/50 text-error rounded px-3 py-1 hover:bg-error/10 disabled:opacity-40 whitespace-nowrap" :disabled="approving" @click="dismiss">{{ approving ? $t('prDrawer.dismiss.running') : $t('prDrawer.dismiss.yes') }}</button>
                <button class="text-xs text-dimmed hover:text-highlighted whitespace-nowrap" :disabled="approving" @click="confirming = ''">{{ $t('common.cancel') }}</button>
              </template>
              <button v-else-if="canDismiss" class="text-xs border border-default rounded px-3 py-1 text-muted hover:text-error hover:border-error/50 whitespace-nowrap" :title="$t('prDrawer.dismiss.title')" @click="confirming = 'dismiss'">{{ $t('prDrawer.dismiss.button') }}</button>
              <button v-else-if="canApprove" class="text-xs border border-default rounded px-3 py-1 text-muted hover:text-highlighted hover:border-inverted whitespace-nowrap" :title="$t('prDrawer.approve.title')" @click="confirming = 'approve'">{{ $t('prDrawer.approve.button') }}</button>
              <a :href="detail.url" target="_blank" class="text-xs text-muted hover:text-highlighted whitespace-nowrap">{{ $t('prDrawer.openInGithub') }}</a>
              <button class="text-dimmed hover:text-highlighted text-lg leading-none" @click="open = false">✕</button>
            </div>
          </div>
          <div v-else class="flex items-center justify-between">
            <span class="text-sm text-dimmed">{{ pending ? $t('common.loading') : error || $t('prDrawer.title') }}</span>
            <button class="text-dimmed hover:text-highlighted text-lg leading-none" @click="open = false">✕</button>
          </div>
          <p v-if="approveError" class="text-xs text-error mt-2 whitespace-pre-wrap">{{ approveError }}</p>

          <!-- Per-instance automation switches: auto review / auto fix (override the project config; flipping one resets this PR's round count) -->
          <div v-if="detail" class="flex items-center flex-wrap gap-x-5 gap-y-1 mt-3 text-xs">
            <div class="flex items-center gap-2">
              <USwitch :model-value="reviewOnLocal" size="sm" @update:model-value="(v: boolean) => toggleAuto('reviewOn', v)" />
              <span class="select-none" :class="reviewOnLocal ? 'text-highlighted' : 'text-dimmed'">{{ $t('automation.prAutoReview') }}</span>
            </div>
            <div class="flex items-center gap-2">
              <USwitch :model-value="fixOnLocal" size="sm" @update:model-value="(v: boolean) => toggleAuto('fixOn', v)" />
              <span class="select-none" :class="fixOnLocal ? 'text-highlighted' : 'text-dimmed'">{{ $t('automation.prAutoFix') }}</span>
            </div>
            <span v-if="coolingMinLeft" class="text-warning">· {{ $t('automation.coolingHint', { n: coolingMinLeft }) }}</span>
            <span v-else-if="autoNoteText" class="text-highlighted">· {{ autoNoteText }}</span>
          </div>

          <!-- Sub-tabs: on mobile the 5 tabs exceed the drawer width → scroll horizontally (bleeding to
               the drawer edges) instead of stretching the whole page width (that would widen the mobile
               layout viewport, falsely trip the md breakpoint and break the entire layout) -->
          <div v-if="detail" class="flex gap-5 md:gap-6 mt-4 text-sm overflow-x-auto -mx-6 px-6 md:mx-0 md:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <button class="pb-1 border-b-2 transition-colors shrink-0 whitespace-nowrap" :class="activeTab === 'review' ? 'border-inverted text-highlighted' : 'border-transparent text-dimmed hover:text-default'" @click="activeTab = 'review'">{{ $t('prDrawer.tabReview') }}</button>
            <button class="pb-1 border-b-2 transition-colors shrink-0 whitespace-nowrap" :class="activeTab === 'fix' ? 'border-inverted text-highlighted' : 'border-transparent text-dimmed hover:text-default'" @click="activeTab = 'fix'">{{ $t('prDrawer.tabFix') }}</button>
            <button class="pb-1 border-b-2 transition-colors shrink-0 whitespace-nowrap" :class="activeTab === 'timeline' ? 'border-inverted text-highlighted' : 'border-transparent text-dimmed hover:text-default'" @click="activeTab = 'timeline'">{{ $t('prDrawer.tabTimeline') }}</button>
            <button class="pb-1 border-b-2 transition-colors shrink-0 whitespace-nowrap" :class="activeTab === 'changes' ? 'border-inverted text-highlighted' : 'border-transparent text-dimmed hover:text-default'" @click="activeTab = 'changes'">{{ $t('prDrawer.tabChanges') }} <span class="text-dimmed">{{ detail.changedFiles }}</span></button>
            <button class="pb-1 border-b-2 transition-colors shrink-0 whitespace-nowrap" :class="activeTab === 'workflow' ? 'border-inverted text-highlighted' : 'border-transparent text-dimmed hover:text-default'" @click="activeTab = 'workflow'">{{ $t('automation.tab') }}</button>
          </div>
        </div>

        <!-- ── AI review ── -->
        <ReviewPanel
          v-if="detail && activeTab === 'review' && prNumber"
          :project-id="projectId"
          :pr-number="prNumber"
          :review-id="reviewId"
          @created="emit('taskCreated')"
          @changed="emit('taskCreated')"
        />

        <!-- ── Fix PR ── -->
        <div v-if="detail && activeTab === 'fix' && prNumber" class="flex-1 min-h-0 flex flex-col px-6 py-4">
          <SessionView :run-id="fixId" workspace-type="pr_worktree" :project-id="projectId" :pr-number="prNumber" :active="activeTab === 'fix'" @changed="emit('taskCreated')" @created="emit('taskCreated')" @deleted="emit('taskCreated')" />
        </div>

        <!-- ── Timeline ── -->
        <div v-if="detail && activeTab === 'timeline'" class="flex-1 overflow-y-auto px-6 py-5">
          <ol class="relative border-l border-default ml-3 space-y-5">
            <!-- Opening entry: the PR description -->
            <li class="pl-6 relative">
              <span class="absolute -left-[7px] top-1.5 w-3 h-3 rounded-full bg-inverted" />
              <div class="text-xs text-dimmed mb-1">
                <span class="text-default font-medium">{{ detail.author }}</span> {{ $t('prDrawer.openedPr') }} · {{ rel(detail.createdAt) }}
              </div>
              <div class="border border-default rounded-md p-3">
                <MarkdownBody v-if="detail.body" :text="detail.body" />
                <span v-else class="text-sm text-dimmed">{{ $t('prDrawer.noDescription') }}</span>
              </div>
            </li>

            <li v-for="(n, i) in nodes" :key="i" class="pl-6 relative">
              <!-- Comment / review: card -->
              <template v-if="n.kind === 'comment' || n.kind === 'review'">
                <span class="absolute -left-[7px] top-1.5 w-3 h-3 rounded-full" :class="n.isBot ? 'bg-accented' : 'bg-inverted'" />
                <div class="text-xs text-dimmed mb-1">
                  <span class="text-default font-medium">{{ n.actor }}</span>
                  <span v-if="n.isBot" class="ml-1 text-[10px] uppercase border border-default rounded px-1 text-dimmed">bot</span>
                  <span v-if="n.kind === 'review'" class="ml-1">{{ $t(REVIEW_STATE[n.state || ''] || 'prDrawer.review.generic') }}</span>
                  <span v-else class="ml-1">{{ $t('prDrawer.commentLabel') }}</span>
                  · {{ rel(n.at) }}
                </div>
                <MarkdownBody v-if="n.body" :text="n.body" class="border border-default rounded-md p-3" />
              </template>

              <!-- commit -->
              <template v-else-if="n.kind === 'commit'">
                <span class="absolute -left-[6px] top-2 w-2.5 h-2.5 rounded-full bg-default border border-accented" />
                <div class="text-sm text-toned flex gap-2 items-baseline">
                  <span class="font-mono text-xs text-dimmed tabular-nums">{{ n.sha }}</span>
                  <span class="truncate">{{ n.message }}</span>
                </div>
              </template>

              <!-- Other events: compact grey line -->
              <template v-else>
                <span class="absolute -left-[5px] top-2 w-2 h-2 rounded-full bg-accented" />
                <div class="text-xs text-dimmed">
                  <span class="text-toned">{{ n.actor }}</span>
                  {{ verbLabel(n.verb) }}
                  <span v-if="n.detail" class="text-muted">{{ n.detail }}</span>
                  · {{ rel(n.at) }}
                </div>
              </template>
            </li>
          </ol>
        </div>

        <!-- ── Changes ── -->
        <div v-else-if="detail && activeTab === 'changes'" class="flex-1 overflow-y-auto">
          <section v-if="detail.files.length" class="px-6 py-4 border-b border-default">
            <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed mb-2">{{ $t('prDrawer.changedFiles', { count: detail.files.length }) }}</div>
            <div v-for="f in detail.files" :key="f.path" class="flex justify-between gap-4 text-sm py-1">
              <span class="font-mono text-xs text-default truncate">{{ f.path }}</span>
              <span class="text-xs tabular-nums shrink-0">
                <span class="text-success">+{{ f.additions }}</span>
                <span class="text-error ml-1">−{{ f.deletions }}</span>
              </span>
            </div>
          </section>
          <section class="px-6 py-3">
            <p v-if="diffPending" class="py-6 text-sm text-dimmed">{{ $t('prDrawer.loadingDiff') }}</p>
            <DiffView v-else :diff="diff || ''" :truncated="diffTruncated" />
          </section>
        </div>

        <!-- ── Automation workflow timeline ── -->
        <div v-else-if="detail && activeTab === 'workflow'" class="flex-1 overflow-y-auto px-6 py-5">
          <p v-if="!wfEvents.length" class="py-16 text-center text-xs text-dimmed">
            {{ wfPending ? $t('common.loading') : $t('automation.noEvents') }}
          </p>
          <ol v-else class="relative border-l border-default ml-3 space-y-4">
            <li v-for="ev in wfEvents" :key="ev.id" class="pl-6 relative">
              <span class="absolute -left-[6px] top-1.5 w-2.5 h-2.5 rounded-full" :class="WF_DOT[ev.kind] || 'bg-accented'" />
              <div class="text-sm text-toned">{{ wfLabel(ev) }}</div>
              <div class="text-[11px] text-dimmed mt-0.5">{{ rel(ev.ts) }}</div>
            </li>
          </ol>
        </div>
      </div>
    </template>
  </USlideover>
</template>

<style>
/* .md-body styles ship with MarkdownBody (unscoped) — this file used to carry a second copy of them. */
</style>
