import { defineConfig } from 'vitest/config';

// Screens render in jsdom through react-native-web, so they are tested in CI
// without a device (phase-9 P9-11). Native-only behaviour is checked on a phone.
export default defineConfig({
  resolve: { alias: { 'react-native': 'react-native-web' } },
  test: {
    name: 'mobile',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'jsdom',
  },
});
