import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Mongo-backed suites skip themselves unless MONGO_TEST_URI is set, so the
    // default run is pure and works with nothing else running.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
