import { fileURLToPath } from 'node:url'

const coreDir = fileURLToPath(new URL('./core', import.meta.url))

export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  devtools: { enabled: true },
  modules: ['@nuxt/ui', '@nuxtjs/i18n'],
  css: ['~~/assets/css/main.css'],
  ssr: true,
  // Follows the system preference, manual switching supported (persisted); minimal monochrome style
  colorMode: { preference: 'system', fallback: 'light', storageKey: 'mr-color-mode' },
  // Three languages: Chinese (the original) + French + English. No URL prefix (internal tool); picked automatically from the browser language and persisted
  i18n: {
    strategy: 'no_prefix',
    defaultLocale: 'en',
    langDir: 'locales',
    lazy: true,
    locales: [
      { code: 'fr', name: 'Français', language: 'fr-FR', file: 'fr.json' },
      { code: 'en', name: 'English', language: 'en-US', file: 'en.json' },
      { code: 'zh', name: '中文', language: 'zh-CN', file: 'zh.json' },
    ],
    detectBrowserLanguage: {
      useCookie: true,
      cookieKey: 'mr-locale',
      redirectOn: 'root',
      fallbackLocale: 'en',
    },
    bundle: { optimizeTranslationDirective: false },
    // Some hint strings contain inline tags like <b>/<br> (static copy we maintain, rendered with v-html in templates)
    compilation: { strictMessage: false },
  },
  typescript: { strict: true },
  alias: { '~core': coreDir },
  runtimeConfig: {
    // agent / inference
    inferenceProvider: process.env.INFERENCE_PROVIDER || 'claude',
    anthropicModel: process.env.ANTHROPIC_MODEL || 'sonnet',
    codexModel: process.env.CODEX_MODEL || '',
    recheckModel: process.env.RECHECK_MODEL || process.env.ANTHROPIC_MODEL || 'sonnet',
    // Model for posting rewrites; empty = the project's own model at low effort.
    translateModel: process.env.TRANSLATE_MODEL || '',
    // Default effort for the (global) assistant: it belongs to no project, so there is no project.effort to read; this central default is the backstop (overridable per session)
    globalEffort: process.env.GLOBAL_EFFORT || 'high',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    // github (defaults to local `gh` CLI auth; token optional)
    githubToken: process.env.GITHUB_TOKEN || '',
    defaultRepo: process.env.DEFAULT_REPO || '',
    // local infra
    dbPath: process.env.DB_PATH || './data/cockpit.db',
    worktreeLocation: process.env.WORKTREE_LOCATION || 'repo',
    reposDir: process.env.REPOS_DIR || './data/worktrees',
    maxConcurrency: Number(process.env.MAX_CONCURRENCY || 3),
    // PR automation engine (the resident polling for auto review / auto fix). AUTOMATION_ENABLED=false shuts the whole thing down.
    automationEnabled: process.env.AUTOMATION_ENABLED !== 'false',
    automationIntervalMs: Number(process.env.AUTOMATION_INTERVAL_MS || 45000),
    // The engine is timer-driven with no requesting-user context, so it can't read the locale from a cookie; this central default decides the working language for auto review/fix.
    automationLang: process.env.AUTOMATION_LANG || 'en',
    public: {
      appName: 'PR Cockpit',
    },
  },
  nitro: {
    // Electron packaging: use the node-server output (.output/server/index.mjs), spawned by the main process
    preset: process.env.NITRO_PRESET || 'node-server',
    alias: { '~core': coreDir },
    experimental: { asyncContext: true },
  },
  vite: {
    optimizeDeps: { exclude: ['better-sqlite3'] },
  },
})
