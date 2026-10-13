import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'repo', include: ['tests/**/*.test.ts'], testTimeout: 60_000 } },
      'services/*/vitest.config.ts',
    ],
  },
});
