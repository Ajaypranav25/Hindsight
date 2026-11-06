// Wall-clock budgets (`npm run test:perf`): one file at a time and without coverage, so timings
// are not distorted by instrumentation or by other test files competing for the CPU.
import { defineConfig } from 'vitest/config'
import { PERF_TESTS } from './vitest.config'

export default defineConfig({
  test: {
    include: [`src/${PERF_TESTS}`, `tests/${PERF_TESTS}`],
    environment: 'node',
    testTimeout: 60_000,
    fileParallelism: false,
  },
})
