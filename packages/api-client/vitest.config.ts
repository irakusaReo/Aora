import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { name: 'api-client', include: ['test/**/*.test.ts'] } });
