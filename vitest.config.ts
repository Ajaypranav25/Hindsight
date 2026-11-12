import { configDefaults, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

/** Wall-clock budgets: run by `npm run test:perf` (vitest.perf.config.ts), never under coverage. */
export const PERF_TESTS = '**/*.perf.test.{ts,tsx}'

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
    exclude: [...configDefaults.exclude, PERF_TESTS],
    environment: 'node',
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/studio/main.tsx', 'src/core/testing/**'],
      reporter: ['text-summary', 'text', 'html'],
      // Just under the levels reached; raise them as coverage grows, never lower them.
      thresholds: { lines: 95, statements: 94, functions: 93, branches: 89 },
    },
  },
})
