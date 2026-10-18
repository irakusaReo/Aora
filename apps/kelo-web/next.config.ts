import type { NextConfig } from 'next';

const config: NextConfig = {
  // The shared packages are TypeScript source; Next compiles them with the app.
  transpilePackages: ['@aora/api-client', '@aora/ui'],
  poweredByHeader: false,
};

export default config;
