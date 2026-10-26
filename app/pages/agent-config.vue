<script setup lang="ts">
// Agent configuration transparency (global page). One provider at a time (Claude / Codex, picked in the header of the
// first block): PR Cockpit's own switches, then what that provider reads and reports for the chosen directory —
// files read into the startup context, the startup context itself, MCP servers with their tools, commands / skills.
// Everything below the switches is the CLI's own report (see core/host/config.ts / core/codex/describe.ts).
import type { Project } from '~core/db/schema'
import type { AgentConfigReport, ConfigFile } from '~core/host/config'

const { t, locale } = useI18n()
const { data: projects } = await useFetch<Project[]>('/api/projects')
const SERVER = 'server' // select sentinel: an empty-string item value is not allowed by the select primitive
const cwdSel = ref<string>(SERVER)
const projectId = computed(() => (cwdSel.value === SERVER ? '' : cwdSel.value))
const cwdItems = computed(() => [{ label: t('agentConfig.serverCwd'), value: SERVER }, ...(projects.value ?? []).map((p) => ({ label: p.name, value: p.id }))])
const refreshFlag = ref(0)
const { data, pending, error, refresh } = await useFetch<AgentConfigReport>('/api/agent/config', {
  query: computed(() => ({ projectId: projectId.value || undefined, refresh: refreshFlag.value ? '1' : undefined })),
  watch: [projectId],
  lazy: true,
})
async function reprobe() { refreshFlag.value = 1; await refresh(); refreshFlag.value = 0 }

type Provider = 'claude' | 'codex'
const PROVIDERS: Provider[] = ['claude', 'codex']
const provider = ref<Provider>('claude')
onMounted(() => { try { const v = localStorage.getItem('mr.agentConfig.provider'); if (v === 'codex') provider.value = 'codex' } catch { /* ignore */ } })
watch(provider, (v) => { try { localStorage.setItem('mr.agentConfig.provider', v) } catch { /* ignore */ } })
const isClaude = computed(() => provider.value === 'claude')

// ── the switch PR Cockpit owns ──
const savedAt = ref('')
const saveError = ref('')
const saving = ref(false)
const chrome = ref(false)
watch(data, (d) => { if (d) chrome.value = d.agent.chrome }, { immediate: true })
// One save at a time (the controls are disabled meanwhile); a failed save snaps the switches back to what the server holds.
async function save(patch: { chrome?: boolean }) {
  if (saving.value) return
  saving.value = true
  saveError.value = ''
  try {
    const r = await $fetch<{ chrome: boolean }>('/api/agent/config', { method: 'PATCH', body: patch })
    chrome.value = r.chrome
    savedAt.value = new Date().toLocaleTimeString(locale.value, { hour12: false })
    if (data.value) data.value = { ...data.value, agent: r }
  } catch (e: any) {
    saveError.value = e?.data?.statusMessage || e?.message || String(e)
    if (data.value) chrome.value = data.value.agent.chrome
  } finally { saving.value = false }
}

// ── formatting ──
const kb = (n: number) => n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`
const num = (n: number) => n.toLocaleString(locale.value)
// Explicit locale + hour12 so the server and the browser format identically (hydration).
const at = (iso: string) => new Date(iso).toLocaleString(locale.value, { hour12: false })
const tilde = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+/, '~')

// ── per-provider views ──
const probe = computed(() => data.value?.claude.probe ?? null)
const codex = computed(() => data.value?.codex.report ?? null)
const SCOPES = ['user', 'project', 'local', 'managed'] as const
const files = computed<ConfigFile[]>(() => (isClaude.value ? data.value?.claude.files : data.value?.codex.files) ?? [])
const filesByScope = computed(() => SCOPES.map((scope) => ({ scope, files: files.value.filter((f) => f.scope === scope) })).filter((g) => g.files.length))
const probeAt = computed(() => (isClaude.value ? probe.value && { at: probe.value.at, ms: probe.value.ms } : codex.value && { at: codex.value.at, ms: codex.value.ms }))
const probeError = computed(() => (isClaude.value ? probe.value?.error : codex.value?.error) ?? null)

// Startup context (Claude only: the CLI reports it per category and per file / tool / skill).
const ctx = computed(() => probe.value?.context ?? null)
const norm = (s: string) => s.replace(/[^a-zA-Z0-9]/g, '') // mcpTools.serverName is the tool-name form of the server name (plugin_Notion_notion vs plugin:Notion:notion; hyphens kept) — compare letters and digits only
const mcpTokensByServer = computed(() => {
  const m = new Map<string, number>()
  for (const tool of ctx.value?.mcpTools ?? []) m.set(norm(tool.serverName), (m.get(norm(tool.serverName)) ?? 0) + tool.tokens)
  return m
})
const skillsBySource = computed(() => {
  const by = new Map<string, { name: string; tokens: number }[]>()
  for (const s of ctx.value?.skills ?? []) { const k = s.source === 'plugin' && s.pluginName ? `${t('agentConfig.skillSource.plugin')} · ${s.pluginName}` : t(`agentConfig.skillSource.${s.source}`, s.source); const l = by.get(k) ?? []; l.push({ name: s.name, tokens: s.tokens }); by.set(k, l) }
  return [...by.entries()].map(([label, items]) => ({ label, items, tokens: items.reduce((a, i) => a + i.tokens, 0) }))
})
// Codex: no token figure exists; show the instruction files it injects with their size instead.
const codexInstructionFiles = computed(() => files.value.filter((f) => f.kind === 'memory' && f.loaded && !f.count))

// MCP servers: one catalogue row per server, the tool list (with read-only / destructive annotations) behind the row.
const annot = (x: { readOnly?: boolean; destructive?: boolean }) => (x.destructive ? ` (${t('agentConfig.destructive')})` : x.readOnly ? ` (${t('agentConfig.readOnly')})` : '')
const mcpGroups = computed(() => {
  const items = isClaude.value
    ? (probe.value?.mcp ?? []).map((s) => ({
        id: s.name, name: s.name, muted: s.status !== 'connected',
        description: [s.status, s.scope, s.transport, s.version, s.error].filter(Boolean).join(' · ') + (s.tools.length ? ` · ${t('agentConfig.toolCount', { n: s.tools.length })}` : '') + (mcpTokensByServer.value.get(norm(s.name)) ? ` · ${num(mcpTokensByServer.value.get(norm(s.name))!)} tokens` : ''),
        detail: s.tools.map((x) => x.name + annot(x)).join(' · ') || undefined,
      }))
    : (codex.value?.mcpServers ?? []).map((s) => ({
        id: s.name, name: s.name, muted: s.authStatus === 'notLoggedIn',
        description: [s.authStatus, s.version, t('agentConfig.toolCount', { n: s.tools.length })].filter(Boolean).join(' · '),
        detail: s.tools.map((x) => x.name + annot(x)).join(' · ') || undefined,
      }))
  return [{ key: 'mcp', label: t('agentConfig.groups.mcp'), open: true, items }] // a handful of servers: keep the list visible, only the tool lists fold
})

// Commands / skills: Claude's slash commands by origin, Codex's skills by plugin prefix — all groups closed by default.
const ORIGINS = ['custom', 'plugin', 'builtin'] as const
const commandGroups = computed(() => ORIGINS.map((origin) => ({
  key: origin, label: t(`agentConfig.cmdOrigin.${origin}`), open: false,
  items: (probe.value?.commands ?? []).filter((c) => c.origin === origin).map((c) => ({
    id: c.name, name: `/${c.name}`, description: c.description.replace(/\s*\((user|project)\)\s*$/, ''), // the CLI's origin suffix is already the group
    meta: origin === 'plugin' ? c.name.split(':')[0] : undefined,
    detail: [c.argumentHint && `${t('agentConfig.args')}: ${c.argumentHint}`, c.aliases.length && `${t('agentConfig.aliases')}: ${c.aliases.join(', ')}`].filter(Boolean).join(' · ') || undefined,
  })),
})))
const skillGroups = computed(() => {
  const by = new Map<string, { id: string; name: string; description: string; meta: string; detail: string; muted: boolean }[]>()
  for (const s of codex.value?.skills ?? []) {
    const i = s.name.indexOf(':')
    const key = i > 0 ? s.name.slice(0, i) : ''
    const list = by.get(key) ?? []
    list.push({ id: s.path || s.name, name: i > 0 ? s.name.slice(i + 1) : s.name, description: s.description, meta: s.enabled ? s.scope : `${s.scope} · ${t('agentConfig.disabled')}`, detail: `/${s.name} · ${tilde(s.path)}`, muted: !s.enabled })
    by.set(key, list)
  }
  return [...by.entries()]
    .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
    .map(([key, items]) => ({ key: key || '_', label: key || t('agentConfig.skillGroupLocal'), open: false, items }))
})
const catalogCount = computed(() => (isClaude.value ? probe.value?.commands.length : codex.value?.skills.length) ?? 0)

const th = 'text-left font-normal text-dimmed px-2 py-1 whitespace-nowrap text-[10px] uppercase tracking-[0.12em]'
const td = 'px-2 py-1 align-top'
const box = 'border border-default'
const head = 'px-4 py-3 border-b border-default'
const h2 = 'text-sm text-highlighted'
const hint = 'text-xs text-dimmed mt-0.5 leading-relaxed'
const h3 = 'text-[10px] uppercase tracking-[0.15em] text-dimmed'
const sub = 'text-[11px] text-dimmed leading-relaxed mt-0.5 mb-2'
const card = 'border border-default p-3'
</script>

<template>
  <div class="max-w-6xl mx-auto px-6 py-6 space-y-6">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-lg text-highlighted">{{ t('agentConfig.title') }}</h1>
        <p class="text-xs text-dimmed mt-1 max-w-2xl">{{ t('agentConfig.subtitle') }}</p>
      </div>
      <div class="flex items-center gap-2 text-xs">
        <span class="text-dimmed">{{ t('agentConfig.cwd') }}</span>
        <USelect v-model="cwdSel" :items="cwdItems" size="sm" color="neutral" variant="outline" class="w-44" />
        <UButton variant="outline" color="neutral" size="sm" icon="i-lucide-refresh-cw" :loading="pending" @click="reprobe">{{ pending ? t('agentConfig.probing') : t('agentConfig.refreshProbe') }}</UButton>
      </div>
    </div>

    <p v-if="error" class="text-sm text-highlighted border border-default p-3">{{ (error as any)?.data?.statusMessage || (error as any)?.statusMessage || error.message }}</p>
    <div v-if="data" class="text-xs text-dimmed font-mono break-all">
      {{ data.cwd }}<template v-if="isClaude"> · {{ t('agentConfig.memoryDir') }}: ~/.claude/projects/{{ data.projectDirName }}</template>
    </div>

    <!-- 1. the switches PR Cockpit owns + the provider picker that drives everything below -->
    <section v-if="data" :class="box">
      <div :class="[head, 'flex flex-wrap items-start justify-between gap-3']">
        <div>
          <h2 :class="h2">{{ t('agentConfig.groups.switches') }} <span v-if="savedAt" class="text-xs text-dimmed">· {{ t('agentConfig.saved') }} {{ savedAt }}</span><span v-if="saveError" class="text-xs text-highlighted"> · {{ saveError }}</span></h2>
          <p :class="hint">{{ t('agentConfig.groups.switchesHint') }}</p>
        </div>
        <div class="inline-flex border border-default rounded overflow-hidden self-start shrink-0">
          <button v-for="(p, i) in PROVIDERS" :key="p" class="px-3 py-1.5 text-sm" :class="[i < PROVIDERS.length - 1 ? 'border-r border-default' : '', provider === p ? 'bg-muted text-highlighted' : 'hover:bg-muted']" @click="provider = p">{{ t(`agentConfig.provider.${p}`) }}</button>
        </div>
      </div>
      <div v-if="isClaude" class="p-4 grid md:grid-cols-2 gap-4">
        <div :class="card">
          <div class="flex items-start justify-between gap-4">
            <div class="text-sm">{{ t('agentConfig.chrome') }}<span class="block text-xs text-dimmed mt-0.5 leading-relaxed">{{ t('agentConfig.chromeHint') }}</span></div>
            <USwitch :model-value="chrome" :disabled="saving" @update:model-value="(v: boolean) => save({ chrome: v })" />
          </div>
        </div>
      </div>
    </section>

    <template v-if="data">
      <p v-if="probeError" class="text-xs text-highlighted border border-default p-3">{{ t('agentConfig.probeError', { msg: probeError }) }}</p>
      <p class="text-xs text-dimmed"><template v-if="probeAt">{{ t('agentConfig.probeTime', { at: at(probeAt.at), ms: probeAt.ms }) }}</template><template v-else>{{ t('agentConfig.noProbe') }}</template></p>

      <!-- 2. files read into the startup context -->
      <section :class="box">
        <div :class="head"><h2 :class="h2">{{ t('agentConfig.groups.files') }}</h2><p :class="hint">{{ t(isClaude ? 'agentConfig.groups.filesHintClaude' : 'agentConfig.groups.filesHintCodex') }}</p></div>
        <div class="p-4 space-y-5">
          <div class="overflow-x-auto">
            <table class="text-xs w-full">
              <thead><tr><th :class="th">{{ t('agentConfig.kind') }}</th><th :class="th">{{ t('agentConfig.path') }}</th><th :class="th">{{ t('agentConfig.size') }}</th><th :class="th">{{ t('agentConfig.count') }}</th><th :class="th">{{ t('agentConfig.loaded') }}</th><th v-if="isClaude" :class="[th, 'text-right']">{{ t('agentConfig.tokens') }}</th></tr></thead>
              <tbody v-for="g in filesByScope" :key="g.scope">
                <tr class="border-t border-default"><td colspan="6" :class="[td, 'pt-2 text-[10px] uppercase tracking-[0.12em] text-dimmed']">{{ t(`agentConfig.scopeLabel.${g.scope}`) }}</td></tr>
                <tr v-for="f in g.files" :key="f.path" class="border-t border-default" :class="f.exists ? '' : 'text-dimmed'">
                  <td :class="[td, 'whitespace-nowrap']">{{ f.kind }}</td><td :class="[td, 'font-mono break-all']">{{ tilde(f.path) }}</td>
                  <td :class="[td, 'whitespace-nowrap']">{{ f.exists ? kb(f.bytes) : t('agentConfig.missing') }}</td><td :class="td">{{ f.count ?? '' }}</td>
                  <td :class="[td, 'whitespace-nowrap']" :title="f.loaded == null ? t('agentConfig.loadedNaHint') : ''">
                    <template v-if="!f.exists">—</template>
                    <span v-else-if="f.loaded === true" class="text-highlighted">{{ t('agentConfig.loadedYes') }}</span>
                    <span v-else-if="f.loaded === false">{{ t('agentConfig.loadedNo') }}</span>
                    <span v-else class="text-dimmed">{{ t('agentConfig.loadedNa') }}</span>
                  </td>
                  <td v-if="isClaude" :class="[td, 'text-right tabular-nums whitespace-nowrap']">{{ f.tokens != null ? num(f.tokens) : '' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="grid md:grid-cols-2 gap-4 text-xs">
            <div :class="card">
              <div :class="h3">{{ t('agentConfig.plugins') }} ({{ isClaude ? (probe?.plugins.length ?? 0) : (codex?.plugins.length ?? 0) }})</div><p :class="sub">{{ t('agentConfig.pluginsHint') }}</p>
              <template v-if="isClaude">
                <div v-for="p in probe?.plugins ?? []" :key="p.name" class="font-mono">{{ p.name }}<span class="text-dimmed"> · {{ p.version || '—' }}<template v-if="p.source"> · {{ p.source }}</template></span></div>
                <div v-if="!probe?.plugins.length" class="text-dimmed">{{ t('agentConfig.none') }}</div>
              </template>
              <template v-else>
                <div v-for="p in codex?.plugins ?? []" :key="p.id" class="font-mono" :class="p.enabled ? '' : 'text-dimmed'">{{ p.name }}<span class="text-dimmed"> · {{ p.version || '—' }} · {{ p.marketplace }}<template v-if="p.sourceType"> · {{ p.sourceType }}</template><template v-if="!p.enabled"> · {{ t('agentConfig.disabled') }}</template></span></div>
                <div v-if="!codex?.plugins.length" class="text-dimmed">{{ t('agentConfig.none') }}</div>
              </template>
            </div>
            <div :class="card">
              <template v-if="isClaude">
                <div :class="h3">{{ t('agentConfig.settingsLayers') }}</div><p :class="sub">{{ t('agentConfig.settingsLayersHint') }}</p>
                <div v-for="s in probe?.settingsSources ?? []" :key="s" class="font-mono">{{ s }}</div>
                <div v-if="!probe?.settingsSources.length" class="text-dimmed">{{ t('agentConfig.none') }}</div>
              </template>
              <template v-else>
                <div :class="h3">{{ t('agentConfig.configLayers') }}</div><p :class="sub">{{ t('agentConfig.configLayersHint') }}</p>
                <div v-for="(l, i) in codex?.configLayers ?? []" :key="i" class="font-mono">{{ l.type }}<span v-if="l.file" class="text-dimmed"> · {{ tilde(l.file) }}</span></div>
                <div v-if="!codex?.configLayers?.length" class="text-dimmed">{{ t('agentConfig.none') }}</div>
                <div :class="[h3, 'mt-3']">{{ t('agentConfig.hooks') }} ({{ codex?.hooks.length ?? 0 }})</div>
                <div v-for="(h, i) in codex?.hooks ?? []" :key="i" class="font-mono" :class="h.enabled ? '' : 'text-dimmed'">{{ h.event }} · {{ h.source }}<span v-if="h.command" class="text-dimmed break-all"> · {{ h.command }}</span></div>
                <div v-if="!codex?.hooks.length" class="text-dimmed">{{ t('agentConfig.none') }}</div>
              </template>
            </div>
          </div>
        </div>
      </section>

      <!-- 3. startup context -->
      <section :class="box">
        <div :class="head">
          <h2 :class="h2">{{ t('agentConfig.groups.context') }}<span v-if="isClaude && ctx" class="text-xs text-dimmed"> · {{ t('agentConfig.contextTotal', { total: num(ctx.total), max: num(ctx.max), pct: ctx.percentage }) }}</span></h2>
          <p :class="hint">{{ t(isClaude ? 'agentConfig.groups.contextHintClaude' : 'agentConfig.groups.contextHintCodex') }}</p>
        </div>
        <div class="p-4 text-xs">
          <template v-if="isClaude">
            <div v-if="!ctx" class="text-dimmed">{{ t('agentConfig.none') }}</div>
            <div v-else class="grid md:grid-cols-2 gap-4">
              <div :class="card">
                <div :class="h3">{{ t('agentConfig.categories') }}</div>
                <div v-for="c in ctx.categories" :key="c.name" class="flex justify-between gap-3 font-mono mt-1"><span>{{ c.name }}<span v-if="c.deferred" class="text-dimmed"> ({{ t('agentConfig.deferred') }})</span></span><span class="tabular-nums">{{ num(c.tokens) }}</span></div>
                <div v-if="ctx.slashCommands" class="flex justify-between gap-3 font-mono mt-1 text-dimmed"><span>{{ t('agentConfig.slashCommands', { included: ctx.slashCommands.included, total: ctx.slashCommands.total }) }}</span><span class="tabular-nums">{{ num(ctx.slashCommands.tokens) }}</span></div>
              </div>
              <div :class="card">
                <div :class="h3">{{ t('agentConfig.ctxMemory') }} ({{ ctx.memoryFiles.length }})</div>
                <div v-for="m in ctx.memoryFiles" :key="m.path" class="flex justify-between gap-3 font-mono mt-1"><span class="truncate" :title="m.path">{{ tilde(m.path) }} <span class="text-dimmed">{{ m.type }}</span></span><span class="tabular-nums shrink-0">{{ num(m.tokens) }}</span></div>
                <div :class="[h3, 'mt-3']">{{ t('agentConfig.ctxSkills') }} ({{ ctx.skills.length }})</div>
                <details v-for="g in skillsBySource" :key="g.label" class="mt-1">
                  <summary class="cursor-pointer flex justify-between gap-3 font-mono"><span>{{ g.label }} ({{ g.items.length }})</span><span class="tabular-nums">{{ num(g.tokens) }}</span></summary>
                  <div v-for="i in g.items" :key="i.name" class="flex justify-between gap-3 font-mono pl-3 text-dimmed"><span>{{ i.name }}</span><span class="tabular-nums">{{ num(i.tokens) }}</span></div>
                </details>
              </div>
            </div>
          </template>
          <template v-else>
            <p class="text-dimmed mb-2">{{ t('agentConfig.codexNoTokens') }}</p>
            <div v-for="f in codexInstructionFiles" :key="f.path" class="flex justify-between gap-3 font-mono"><span>{{ tilde(f.path) }}</span><span class="tabular-nums">{{ kb(f.bytes) }}</span></div>
            <div v-if="!codexInstructionFiles.length" class="text-dimmed">{{ t('agentConfig.none') }}</div>
          </template>
        </div>
      </section>

      <!-- 4. MCP servers -->
      <section :class="box">
        <div :class="head"><h2 :class="h2">{{ t('agentConfig.groups.mcp') }} ({{ mcpGroups[0]!.items.length }})</h2><p :class="hint">{{ t(isClaude ? 'agentConfig.groups.mcpHintClaude' : 'agentConfig.groups.mcpHintCodex') }}</p></div>
        <div class="p-4"><CatalogList :groups="mcpGroups" /></div>
      </section>

      <!-- 5. commands / skills -->
      <section :class="box">
        <div :class="head"><h2 :class="h2">{{ t(isClaude ? 'agentConfig.groups.commands' : 'agentConfig.groups.skills') }} ({{ catalogCount }})</h2><p :class="hint">{{ t(isClaude ? 'agentConfig.groups.commandsHint' : 'agentConfig.groups.skillsHint') }}</p></div>
        <div class="p-4"><CatalogList :groups="isClaude ? commandGroups : skillGroups" /></div>
      </section>
    </template>
  </div>
</template>
