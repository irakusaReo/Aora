// Test helpers for the native apps (`@aora/mobile/testing`): a fake API that
// records every call, in-memory secure storage, and a render with services.
// Never imported by app code.
import { AoraApi } from '@aora/api-client';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactNode } from 'react';
import { IntentKeys, type KeyValueStore } from './intent-keys';
import { ServicesProvider, type Services } from './services';

/** In-memory stand-in for secure storage; it outlives a render, like the device's. */
export function memoryStore(): KeyValueStore & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => Promise.resolve(entries.get(key) ?? null),
    setItem: (key, value) => {
      entries.set(key, value);
      return Promise.resolve();
    },
    deleteItem: (key) => {
      entries.delete(key);
      return Promise.resolve();
    },
  };
}

export interface Call {
  method: string;
  path: string;
  query?: Record<string, string | number | undefined>;
  body: unknown;
  idempotencyKey: string | undefined;
  workspaceId: string | undefined;
}

export type Handler = (call: Call) => unknown;

/**
 * An AoraApi whose requests go to `handler` instead of the network. A handler
 * returns the response body, or throws the error the client would throw.
 */
export function fakeApi(handler: Handler, workspaceId?: string): AoraApi & { calls: Call[] } {
  const calls: Call[] = [];
  const api = new AoraApi({ baseUrl: 'http://api.test', token: 'test-token' });
  const respond = <T,>(call: Call): Promise<T> => {
    calls.push(call);
    return new Promise<T>((resolve) => {
      resolve(handler(call) as T);
    });
  };
  return Object.assign(api, {
    calls,
    forWorkspace: (id: string) => fakeApi(handler, id),
    get: <T,>(path: string, query: Record<string, string | number | undefined> = {}) =>
      respond<T>({
        method: 'GET',
        path,
        query,
        body: undefined,
        idempotencyKey: undefined,
        workspaceId,
      }),
    post: <T,>(path: string, body: unknown = {}, idempotencyKey?: string) =>
      respond<T>({ method: 'POST', path, body, idempotencyKey, workspaceId }),
    put: <T,>(path: string, body: unknown) =>
      respond<T>({ method: 'PUT', path, body, idempotencyKey: undefined, workspaceId }),
    patch: <T,>(path: string, body: unknown) =>
      respond<T>({ method: 'PATCH', path, body, idempotencyKey: undefined, workspaceId }),
    delete: <T,>(path: string) =>
      respond<T>({
        method: 'DELETE',
        path,
        body: undefined,
        idempotencyKey: undefined,
        workspaceId,
      }),
  });
}

let ids = 0;

export function services(
  api: AoraApi,
  store: KeyValueStore = memoryStore(),
  overrides: Partial<Services> = {},
): Services {
  return {
    api: () => Promise.resolve(api),
    intents: new IntentKeys(store, () => `key-${String(++ids)}`),
    webUrl: 'https://web.test',
    signOut: () => Promise.resolve(),
    ...overrides,
  };
}

export function renderWith(value: Services, node: ReactNode): RenderResult {
  return render(<ServicesProvider value={value}>{node}</ServicesProvider>);
}
