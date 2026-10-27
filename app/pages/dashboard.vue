<script setup lang="ts">
// Observability dashboard: cost / tokens / precision / recheck / automation over the runs tables. Read-only.
// Three groups: where the money goes, review quality, and the raw run list (paged server-side).
import type { Project } from '~core/db/schema'

const { t, locale } = useI18n()
const { data: projects } = await useFetch<Project[]>('/api/projects')

const ALL = 'all' // select sentinel: an empty-string item value is not allowed by the select primitive
const projectSel = ref<string>(ALL)
const projectId = computed(() => (projectSel.value === ALL ? '' : projectSel.value))
const range = ref<string>('30')
// Window start, rounded to local midnight and written by a watcher rather than a computed: the value is part of
// the useFetch key, so it must be identical on the server and on the client (hydration) and between two reads of a
// computed during SSR (computed getters are not cached there) — a millisecond timestamp was neither.
const from = ref('')
watch(range, (r) => {
  if (r === ALL) { from.value = ''; return }
  const d = new Date(); d.setDate(d.getDate() - Number(r)); d.setHours(0, 0, 0, 0); from.value = d.toISOString()
}, { immediate: true })
const projectItems = computed(() => [{ label: t('dashboard.allProjects'), value: ALL }, ...(projects.value ?? []).map((p) => ({ label: p.name, value: p.id }))])
const rangeItems = computed(() => [{ label: t('dashboard.last7'), value: '7' }, { label: t('dashboard.last30'), value: '30' }, { label: t('dashboard.all'), value: ALL }])

const { data, pending, refresh } = await useFetch<any>('/api/metrics/overview', {
  query: computed(() => ({ projectId: projectId.value || undefined, from: from.value || undefined })),
  watch: [projectId, from],
})

// Run list: its own endpoint so paging does not recompute the aggregates. The page is remembered together with
// the filter it was chosen under, so a filter change reads as page 1 in the same tick (a reset watcher would run
// after the useFetch key watcher and cost an extra request with the stale offset).
const RUNS_PER_PAGE = 20
const runsFilterKey = computed(() => `${projectId.value}|${from.value}`)
const runsPick = ref<{ key: string; page: number }>({ key: '', page: 1 })
const runsPage = computed(() => (runsPick.value.key === runsFilterKey.value ? runsPick.value.page : 1))
function setRunsPage(p: number) { runsPick.value = { key: runsFilterKey.value, page: p } }
const { data: runs, pending: runsPending, refresh: refreshRuns } = await useFetch<{ rows: any[]; total: number }>('/api/metrics/runs', {
  query: computed(() => ({ projectId: projectId.value || undefined, from: from.value || undefined, offset: (runsPage.value - 1) * RUNS_PER_PAGE, limit: RUNS_PER_PAGE })),
  watch: [projectId, from, runsPage],
})
async function refreshAll() { await Promise.all([refresh(), refreshRuns()]) }

const totals = computed(() => {
  const rows = data.value?.runsBySubkind ?? []
  const sum = (k: string) => rows.reduce((a: number, r: any) => a + Number(r[k] || 0), 0)
  const priced = rows.some((r: any) => r.cost_usd != null)
  return { runs: sum('runs'), errors: sum('errors'), cost: priced ? sum('cost_usd') : null, unpriced: sum('unpriced'), inTok: sum('input_tokens'), outTok: sum('output_tokens') }
})
const hasData = computed(() => totals.value.runs > 0)

function usd(v: number | null | undefined, digits = 2) { return v == null ? '—' : `$${Number(v).toFixed(digits)}` }
function pct(v: number | null | undefined) { return v == null ? '—' : `${(v * 100).toFixed(0)}%` }
function tok(n: number | null | undefined) { const v = Number(n || 0); return v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(v) }
function dur(ms: number | null | undefined) { if (!ms) return '—'; const s = Math.round(ms / 1000); return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s` }
function when(iso: string) { return new Date(iso).toLocaleString(locale.value, { hour12: false }) }
const th = 'text-[10px] uppercase tracking-[0.12em] text-dimmed font-normal text-left py-1.5 pr-4 whitespace-nowrap'
const td = 'py-1.5 pr-4 text-xs whitespace-nowrap'
const num = 'py-1.5 pr-4 text-xs whitespace-nowrap tabular-nums text-right'
const group = 'border border-default'
const head = 'px-4 py-3 border-b border-default'
const h2 = 'text-sm text-highlighted'
const hint = 'text-xs text-dimmed mt-0.5 leading-relaxed'
const h3 = 'text-[10px] uppercase tracking-[0.15em] text-dimmed'
const sub = 'text-[11px] text-dimmed leading-relaxed mt-0.5 mb-2'
const tile = 'bg-default p-3'
const tileLabel = 'text-[10px] uppercase tracking-[0.15em] text-dimmed'
</script>

<template>
  <div class="max-w-7xl mx-auto px-6 md:px-8 py-6 space-y-6">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-xl font-light tracking-tight">{{ $t('dashboard.title') }}</h1>
        <p class="text-xs text-dimmed mt-1">{{ $t('dashboard.subtitle') }}</p>
      </div>
      <div class="flex items-center gap-2">
        <USelect v-model="projectSel" :items="projectItems" size="sm" color="neutral" variant="outline" class="w-44" />
        <USelect v-model="range" :items="rangeItems" size="sm" color="neutral" variant="outline" class="w-32" />
        <UButton variant="outline" color="neutral" size="sm" icon="i-lucide-refresh-cw" :loading="pending || runsPending" :aria-label="$t('dashboard.refresh')" :title="$t('dashboard.refresh')" @click="refreshAll()" />
      </div>
    </div>

    <p v-if="!hasData && !pending" class="text-sm text-dimmed py-10">{{ $t('dashboard.noData') }}</p>

    <template v-else>
      <!-- headline tiles -->
      <div>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-px bg-default border border-default">
          <div :class="tile"><div :class="tileLabel">{{ $t('dashboard.runs') }}</div><div class="text-lg tabular-nums">{{ totals.runs }} <span class="text-xs text-dimmed">· {{ totals.errors }} {{ $t('dashboard.errors') }}</span></div></div>
          <div :class="tile"><div :class="tileLabel">{{ $t('dashboard.cost') }}</div><div class="text-lg tabular-nums">{{ usd(totals.cost) }} <span v-if="totals.unpriced" class="text-xs text-dimmed">· {{ $t('dashboard.unpriced', { n: totals.unpriced }) }}</span></div></div>
          <div :class="[tile, 'col-span-2']"><div :class="tileLabel">{{ $t('dashboard.tokens') }}</div><div class="text-lg tabular-nums">{{ tok(totals.inTok) }} / {{ tok(totals.outTok) }}</div></div>
        </div>
        <p class="text-[11px] text-dimmed mt-2">
          {{ $t('dashboard.tilesHint') }}
          {{ data?.pricing?.codexModelsPriced ? $t('dashboard.pricingNote', { n: data.pricing.codexModelsPriced, asOf: data.pricing.codexRatesAsOf || '?' }) : $t('dashboard.pricingMissing') }}
        </p>
      </div>

      <!-- 1. where the money goes -->
      <section :class="group">
        <div :class="head"><h2 :class="h2">{{ $t('dashboard.group.spend') }}</h2><p :class="hint">{{ $t('dashboard.hint.spend') }}</p></div>
        <div class="p-4 grid grid-cols-1 xl:grid-cols-2 gap-x-10 gap-y-6">
          <div>
            <div :class="h3">{{ $t('dashboard.bySubkind') }}</div><p :class="sub">{{ $t('dashboard.hint.bySubkind') }}</p>
            <div class="overflow-x-auto"><table class="w-full border-t border-default">
              <thead><tr><th :class="th">{{ $t('dashboard.col.kind') }}</th><th :class="th">{{ $t('dashboard.col.provider') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.col.runs') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.cost') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.tokens') }}</th></tr></thead>
              <tbody><tr v-for="r in data?.runsBySubkind ?? []" :key="r.subkind + r.provider" class="border-t border-default">
                <td :class="td">{{ r.subkind }}</td><td :class="td">{{ r.provider }}</td>
                <td :class="num">{{ r.runs }}<span v-if="r.errors" class="text-dimmed"> ({{ r.errors }} ✗)</span></td>
                <td :class="num">{{ usd(r.cost_usd, 3) }}<span v-if="r.unpriced" class="text-dimmed"> ·{{ r.unpriced }}?</span></td>
                <td :class="num">{{ tok(r.input_tokens) }} / {{ tok(r.output_tokens) }}</td>
              </tr></tbody>
            </table></div>
          </div>
          <div>
            <div :class="h3">{{ $t('dashboard.byModel') }}</div><p :class="sub">{{ $t('dashboard.hint.byModel') }}</p>
            <div class="overflow-x-auto"><table class="w-full border-t border-default">
              <thead><tr><th :class="th">{{ $t('dashboard.col.model') }}</th><th :class="th">{{ $t('dashboard.col.effort') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.col.runs') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.col.avgCost') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.col.p50Dur') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.col.p95Dur') }}</th></tr></thead>
              <tbody><tr v-for="r in data?.reviewRunsByModel ?? []" :key="r.provider + r.model + r.effort" class="border-t border-default">
                <td :class="td">{{ r.provider }} · {{ r.model || '—' }}</td><td :class="td">{{ r.effort || '—' }}</td>
                <td :class="num">{{ r.runs }}<span v-if="r.errors" class="text-dimmed"> ({{ r.errors }} ✗)</span></td>
                <td :class="num">{{ usd(r.avgCostUsd, 3) }}</td><td :class="num">{{ dur(r.p50DurationMs) }}</td><td :class="num">{{ dur(r.p95DurationMs) }}</td>
              </tr></tbody>
            </table></div>
          </div>
          <div class="xl:col-span-2">
            <div :class="h3">{{ $t('dashboard.byDay') }}</div><p :class="sub">{{ $t('dashboard.hint.byDay') }}</p>
            <div class="overflow-x-auto max-h-64 overflow-y-auto"><table class="w-full border-t border-default">
              <thead><tr><th :class="th">{{ $t('dashboard.col.day') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.col.runs') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.cost') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.tokens') }}</th></tr></thead>
              <tbody><tr v-for="r in data?.costByDay ?? []" :key="r.day" class="border-t border-default">
                <td :class="td">{{ r.day }}</td><td :class="num">{{ r.runs }}</td><td :class="num">{{ usd(r.cost_usd, 2) }}</td><td :class="num">{{ tok(r.input_tokens) }} / {{ tok(r.output_tokens) }}</td>
              </tr></tbody>
            </table></div>
          </div>
        </div>
      </section>

      <!-- 2. review quality -->
      <section :class="group">
        <div :class="head"><h2 :class="h2">{{ $t('dashboard.group.quality') }}</h2><p :class="hint">{{ $t('dashboard.hint.quality') }}</p></div>
        <div class="p-4 grid grid-cols-1 xl:grid-cols-2 gap-x-10 gap-y-6">
          <div class="xl:col-span-2">
            <div :class="h3">{{ $t('dashboard.precision') }}</div><p :class="sub">{{ $t('dashboard.hint.precision') }}</p>
            <div class="overflow-x-auto"><table class="w-full border-t border-default">
              <thead><tr><th :class="th">{{ $t('dashboard.col.skill') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.col.reviews') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.col.findings') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.col.accepted') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.col.machine') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.col.posted') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.col.precision') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.cost') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.col.costPerAccepted') }}</th></tr></thead>
              <tbody><tr v-for="r in data?.precisionBySkillVersion ?? []" :key="r.skill_version_id || 'default'" class="border-t border-default">
                <td :class="td">{{ r.skill_name ? `${r.skill_name} v${r.version}` : $t('dashboard.defaultSkill') }}</td>
                <td :class="num">{{ r.reviews }}</td><td :class="num">{{ r.findings }}</td><td :class="num">{{ r.human_accepted }}</td><td :class="num">{{ r.machine_checked }}</td><td :class="num">{{ r.posted }}</td>
                <td :class="num">{{ pct(r.precision) }}</td><td :class="num">{{ usd(r.cost_usd, 2) }}</td><td :class="num">{{ usd(r.costPerAccepted, 2) }}</td>
              </tr></tbody>
            </table></div>
            <p v-if="!(data?.precisionBySkillVersion ?? []).length" class="text-xs text-dimmed py-2">{{ $t('dashboard.noTriaged') }}</p>
          </div>
          <div>
            <div :class="h3">{{ $t('dashboard.recheck') }}</div><p :class="sub">{{ $t('dashboard.hint.recheck') }}</p>
            <div class="text-xs space-y-1">
              <div><span class="text-dimmed">{{ $t('dashboard.retractionRate') }}</span> <span class="tabular-nums">{{ pct(data?.recheck?.retractionRate) }}</span> · <span class="text-dimmed">{{ $t('dashboard.fixedRate') }}</span> <span class="tabular-nums">{{ pct(data?.recheck?.fixedRate) }}</span></div>
              <div class="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px]"><span v-for="(n, k) in data?.recheck?.byStatus ?? {}" :key="k">{{ k }} <b>{{ n }}</b></span><span v-if="!Object.keys(data?.recheck?.byStatus ?? {}).length" class="text-dimmed">—</span></div>
              <div class="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px]"><span class="text-dimmed">{{ $t('dashboard.stance') }}</span><span v-for="(n, k) in data?.recheck?.byStance ?? {}" :key="k">{{ k }} <b>{{ n }}</b></span><span v-if="!Object.keys(data?.recheck?.byStance ?? {}).length" class="text-dimmed">—</span></div>
            </div>
          </div>
          <div>
            <div :class="h3">{{ $t('dashboard.automation') }}</div><p :class="sub">{{ $t('dashboard.hint.automation') }}</p>
            <div class="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px]"><span v-for="(n, k) in data?.automation ?? {}" :key="k">{{ k }} <b>{{ n }}</b></span><span v-if="!Object.keys(data?.automation ?? {}).length" class="text-dimmed">—</span></div>
          </div>
          <div>
            <div :class="h3">{{ $t('dashboard.ratingData') }}</div><p :class="sub">{{ $t('dashboard.hint.ratingData') }}</p>
            <div class="text-xs tabular-nums">{{ $t('dashboard.ratingCounts', { live: data?.ratingData?.live ?? 0, labels: data?.ratingData?.labels ?? 0, orphaned: data?.ratingData?.orphaned ?? 0 }) }}</div>
          </div>
        </div>
      </section>

      <!-- 3. run list (paged) -->
      <section :class="group">
        <div :class="head"><h2 :class="h2">{{ $t('dashboard.recent') }} <span v-if="runs" class="text-dimmed">({{ runs.total }})</span></h2><p :class="hint">{{ $t('dashboard.hint.recent') }}</p></div>
        <div class="p-4">
          <div class="overflow-x-auto"><table class="w-full border-t border-default">
            <thead><tr><th :class="th">{{ $t('dashboard.col.when') }}</th><th :class="th">{{ $t('dashboard.col.project') }}</th><th :class="th">{{ $t('dashboard.col.kind') }}</th><th :class="th">{{ $t('dashboard.col.pr') }}</th><th :class="th">{{ $t('dashboard.col.model') }}</th><th :class="th">{{ $t('dashboard.col.status') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.cost') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.tokens') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.col.duration') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.col.skill') }}</th></tr></thead>
            <tbody><tr v-for="r in runs?.rows ?? []" :key="r.id" class="border-t border-default" :title="r.error || r.title || ''">
              <td :class="td">{{ when(r.created_at) }}</td><td :class="td">{{ r.project_name || '—' }}</td><td :class="td">{{ r.subkind }}</td><td :class="td">{{ r.pr_number ? '#' + r.pr_number : '—' }}</td>
              <td :class="td">{{ r.provider }} · {{ r.model || '—' }}<span v-if="r.effort" class="text-dimmed"> · {{ r.effort }}</span></td>
              <td :class="[td, r.status === 'error' ? 'text-error' : '']">{{ r.status }}</td>
              <td :class="num" :title="r.unpriced_turns ? `${r.unpriced_turns} unpriced turn(s) — total is a lower bound` : ''">{{ usd(r.cost_usd, 3) }}<span v-if="r.cost_source === 'estimated'" class="text-dimmed">~</span><span v-if="r.unpriced_turns" class="text-dimmed">+?</span></td>
              <td :class="num">{{ tok(r.input_tokens) }} / {{ tok(r.output_tokens) }}</td><td :class="num">{{ dur(r.duration_ms) }}</td><td :class="num">{{ r.skill_version != null ? 'v' + r.skill_version : '—' }}</td>
            </tr></tbody>
          </table></div>
          <PagerBar :total="runs?.total ?? 0" :per-page="RUNS_PER_PAGE" :page="runsPage" :disabled="runsPending" @update:page="setRunsPage" />
        </div>
      </section>
    </template>
  </div>
</template>
