import { defineConfig } from 'vitest/config'

// Separate from vite.config.ts: vitest bundles its own Vite, so its config type stays out of the app build.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
