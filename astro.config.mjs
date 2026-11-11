import { defineConfig } from 'astro/config';

export default defineConfig({
  // Never inline scripts: the Worker's CSP only allows script files from this origin.
  vite: { build: { assetsInlineLimit: 0 } },
});
