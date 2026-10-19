import Constants from 'expo-constants';
import { randomUUID } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { IntentKeys, type KeyValueStore } from './intent-keys';

// The device side of the shared pieces: secure storage, random identifiers and
// app configuration. Kept apart from the rest so tests never load a native module.

/** Keychain on iOS, Keystore-backed storage on Android (ADR 0016 rule 4). */
export const secureStore: KeyValueStore = {
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) => SecureStore.setItemAsync(key, value),
  deleteItem: (key) => SecureStore.deleteItemAsync(key),
};

export function deviceIntentKeys(): IntentKeys {
  return new IntentKeys(secureStore, randomUUID);
}

export interface AppConfig {
  apiUrl: string;
  clerkPublishableKey: string;
  webUrl: string;
}

/**
 * Read from `extra`, which each app's app.config.ts fills from the repository's
 * .env.local (phase-9 P9-5). A live Clerk key is refused (CLAUDE.md rule 10).
 */
export function appConfig(): AppConfig {
  const extra = (Constants.expoConfig?.extra ?? {}) as Partial<AppConfig>;
  const { apiUrl, clerkPublishableKey, webUrl } = extra;
  if (!apiUrl || !clerkPublishableKey || !webUrl) {
    throw new Error('App configuration is missing. See docs/operations/mobile.md.');
  }
  if (!clerkPublishableKey.startsWith('pk_test_')) {
    throw new Error('Only a Clerk development key (pk_test_) may be used. This is a sandbox.');
  }
  return { apiUrl, clerkPublishableKey, webUrl };
}
