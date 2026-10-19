import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import type { ExpoConfig } from 'expo/config';

// Configuration comes from the repository's .env.local (phase-9 P9-5): the
// Clerk development instance's publishable key (public by design) and the API
// URL, staging by default. The file is parsed, not loaded, so its secrets never
// enter this process's environment, and only these two values are read.
// Expo evaluates this file with the app's folder as the working directory.
function readLocalEnv(): Record<string, string | undefined> {
  try {
    return parseEnv(readFileSync('../../.env.local', 'utf8'));
  } catch {
    // No .env.local (CI bundle check): the app then stops at start with a message.
    return {};
  }
}

const env = { ...readLocalEnv(), ...(process.env as Record<string, string | undefined>) };

const config: ExpoConfig = {
  name: 'KONY (sandbox)',
  slug: 'aora-kony',
  scheme: 'aora-kony',
  version: '0.0.0',
  orientation: 'portrait',
  userInterfaceStyle: 'light',
  plugins: ['expo-router', 'expo-secure-store', '@clerk/expo'],
  extra: {
    apiUrl: env['AORA_MOBILE_API_URL'] ?? 'https://aora-api.vercel.app',
    clerkPublishableKey: env['CLERK_PUBLISHABLE_KEY'] ?? '',
    webUrl: 'https://kony-web.vercel.app',
  },
};

export default config;
