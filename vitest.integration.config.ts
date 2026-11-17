import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 180000,
    hookTimeout: 900000,
    fileParallelism: false
  }
})
