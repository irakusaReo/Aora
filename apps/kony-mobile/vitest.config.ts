import { defineConfig } from 'vitest/config';

// Screens render in jsdom through react-native-web, with a fake API (phase-9 P9-11).
export default defineConfig({
  resolve: { alias: { 'react-native': 'react-native-web' } },
  test: {
    name: 'kony-mobile',
    include: ['test/**/*.test.tsx'],
    environment: 'jsdom',
    setupFiles: ['test/setup.ts'],
  },
});
