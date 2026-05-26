import { defineConfig } from 'vitest/config'

// Smoke harness for v4 ModelPreset migration / adapter wire / .bin round-trip.
// Run only when SMOKE_DB_PATH points at a user-supplied .bin export — otherwise
// the suite skips so plain `pnpm test` is unaffected.
//
// Usage:
//   SMOKE_DB_PATH=/path/to/your-export.bin pnpm exec vitest run --config vitest.config.smoke.ts
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/smoke/**/*.smoke.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    reporters: ['default'],
  },
})
