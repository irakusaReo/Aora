import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'api',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/support/global-setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Integration tests share one PostgreSQL database, so files run one at a time.
    fileParallelism: false,
  },
});
