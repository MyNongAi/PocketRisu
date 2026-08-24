import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Pure TypeScript/browser-state tests that do not compile .svelte files. This
// small config is also useful on portable installs whose dependency directory
// is read-only: the Svelte optimizer cache is not needed for data-layer tests.
export default defineConfig({
  resolve: {
    alias: { src: path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'src') },
  },
  test: {
    environment: 'happy-dom',
    setupFiles: ['vitest.setup.ts'],
    include: [
      'src/ts/storage/chatStorage.test.ts',
      'src/lib/UI/Virtual/virtualWindow.test.ts',
    ],
  },
})
