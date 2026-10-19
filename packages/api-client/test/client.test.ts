import { afterEach, describe, expect, it, vi } from 'vitest';
import { AoraApi, AoraApiError, AoraNetworkError } from '../src';

// A request whose outcome is unknown must never look like a refusal
// (CLAUDE.md rule 6, ADR 0016 rule 3, phase-9 P9-9).

/** A fetch that never answers until its signal aborts. */
function hangingFetch(): typeof fetch {
  return (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('api client outcomes', () => {
  it('turns a timeout into AoraNetworkError, not a refusal', async () => {
    vi.stubGlobal('fetch', hangingFetch());
    const api = new AoraApi({ baseUrl: 'http://127.0.0.1:9', token: null, timeoutMs: 20 });
    const error = await api.post('/v1/payouts', {}, 'key-1').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AoraNetworkError);
    expect(error).not.toBeInstanceOf(AoraApiError);
    expect((error as AoraNetworkError).reason).toBe('timeout');
  });

  it('times out on a device where AbortSignal.timeout does not exist', async () => {
    vi.stubGlobal('fetch', hangingFetch());
    const original = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
    Object.defineProperty(AbortSignal, 'timeout', { value: undefined, configurable: true });
    try {
      const api = new AoraApi({ baseUrl: 'http://127.0.0.1:9', token: null, timeoutMs: 20 });
      const error = await api.get('/v1/me').catch((caught: unknown) => caught);
      expect((error as AoraNetworkError).reason).toBe('timeout');
    } finally {
      if (original) Object.defineProperty(AbortSignal, 'timeout', original);
    }
  });

  it('turns a network failure into AoraNetworkError', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Network request failed')));
    const api = new AoraApi({ baseUrl: 'http://127.0.0.1:9', token: null });
    const error = await api.get('/v1/me').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AoraNetworkError);
    expect((error as AoraNetworkError).reason).toBe('network');
  });

  it('still reports a refusal with its code and the idempotency key it sent', async () => {
    const seen: Record<string, string>[] = [];
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      seen.push(init.headers as Record<string, string>);
      return Promise.resolve(
        new Response(JSON.stringify({ error: { code: 'step_up_required', message: 'PIN' } }), {
          status: 403,
        }),
      );
    });
    const api = new AoraApi({ baseUrl: 'http://127.0.0.1:9', token: 't' });
    const error = await api.post('/v1/payouts', {}, 'key-7').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AoraApiError);
    expect((error as AoraApiError).code).toBe('step_up_required');
    expect(seen[0]?.['idempotency-key']).toBe('key-7');
  });
});
