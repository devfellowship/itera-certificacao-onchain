import { defineConfig } from 'vitest/config';

// Allows running the evaluator-owned hidden tests from inside fixture/ (which has the only
// node_modules install) during local/manual verification. The real runner (T11) will do this
// copy-and-mount step itself instead of relying on this include pattern.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', '../evaluator/hidden/**/*.test.ts'],
  },
});
