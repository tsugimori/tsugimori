import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('./ui', import.meta.url)),
  envDir: false,
  plugins: [svelte({ configFile: false })],
  build: {
    outDir: '../dist/ui',
    emptyOutDir: true,
    manifest: true,
  },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: process.env.TSUGIMORI_UI_GATEWAY ?? 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
});
