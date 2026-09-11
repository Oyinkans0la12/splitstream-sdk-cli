import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * The CLI imports `@splitstream/sdk`, whose package entrypoints point at
 * `dist/`. Tests resolve the package to its *source* instead, so `npm test`
 * works from a clean checkout without a prior build and always exercises the
 * SDK code in the working tree.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@splitstream/sdk': fileURLToPath(new URL('../sdk/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
