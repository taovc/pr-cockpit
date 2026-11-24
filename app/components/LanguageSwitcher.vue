<script setup lang="ts">
import type { Ref } from 'vue'
import type { DropdownMenuItem } from '@nuxt/ui'

// @nuxtjs/i18n adds locales/setLocale to vue-i18n's Composer, but typecheck does not always load that augmentation → declare the types explicitly
type LocaleItem = { code: string; name?: string }
type I18nWithLocales = ReturnType<typeof useI18n> & {
  locales: Ref<LocaleItem[]>
  setLocale: (code: string) => Promise<void>
}

// Three-language switcher; the preference is persisted by @nuxtjs/i18n's cookie (mr-locale)
const { locale, locales, setLocale, t } = useI18n() as unknown as I18nWithLocales

// Build the dropdown items from the configured locales, with a check mark on the current language
const items = computed<DropdownMenuItem[]>(() =>
  locales.value.map((l) => ({
    label: l.name ?? l.code,
    icon: l.code === locale.value ? 'i-lucide-check' : undefined,
    onSelect: () => setLocale(l.code),
  })),
)
</script>

<template>
  <!-- ClientOnly + fallback prevents an SSR hydration mismatch (the server does not know the persisted preference) -->
  <ClientOnly>
    <UDropdownMenu :items="items" :content="{ align: 'end' }">
      <button
        class="text-dimmed hover:text-highlighted transition-colors flex items-center justify-center size-6"
        :title="t('switcher.label')"
        :aria-label="t('switcher.label')"
      >
        <UIcon name="i-lucide-globe" class="size-4" />
      </button>
    </UDropdownMenu>
    <template #fallback>
      <div class="size-6" />
    </template>
  </ClientOnly>
</template>
