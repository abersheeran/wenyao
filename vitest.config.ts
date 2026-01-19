import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/test/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    // Run tests serially to avoid database conflicts
    fileParallelism: false
  }
})

