import tailwindcss from '@tailwindcss/vite';

import { primeVueComponents } from './app/lib/primevue.ts';

export default defineNuxtConfig({
  compatibilityDate: '2026-11-27',
  telemetry: false,
  devtools: { enabled: false },
  app: {
    head: {
      htmlAttrs: { lang: 'en' },
      titleTemplate: '%s · tsugimori',
      script: [{ src: '/theme.js', tagPriority: 'critical' }],
    },
  },
  modules: ['@primevue/nuxt-module'],
  css: [
    '@fontsource-variable/noto-sans/wght.css',
    '@fontsource-variable/noto-sans-tc',
    '~/assets/css/main.css',
    '~/assets/css/generated.css',
  ],
  features: { inlineStyles: false },
  experimental: {
    entryImportMap: false,
    renderJsonPayloads: false,
    payloadExtraction: false,
  },
  primevue: {
    loadStyles: false,
    options: { theme: 'none' },
    components: { include: [...primeVueComponents] },
    directives: { include: [] },
  },
  devServer: { host: '127.0.0.1' },
  vite: {
    server: {
      // The gateway applies its normal loopback policy to these requests.
      proxy: {
        '^/api(?:/|$)': {
          target: process.env.TSUGIMORI_UI_GATEWAY ?? 'http://127.0.0.1:8787',
          changeOrigin: true,
        },
      },
    },
    build: { assetsInlineLimit: 0 },
    plugins: [
      tailwindcss(),
      {
        // Theme and structural CSS ship as files. Remove the runtime injector
        // used by PrimeVue components, including their internal icons.
        name: 'primevue-static-css',
        enforce: 'pre',
        transform(_code: string, id: string) {
          if (!id.endsWith('/@primevue/core/usestyle/index.mjs')) return;
          return {
            code: 'export function useStyle() { return { load() {}, unload() {} }; }',
            map: { mappings: '' },
          };
        },
      },
    ],
  },
  nitro: {
    prerender: {
      concurrency: 2,
      crawlLinks: false,
      routes: ['/', '/tasks', '/task', '/chat', '/ops'],
    },
  },
});
