// A thin, typed client for the AORA API. It holds no business logic: every
// rule lives in the API (CLAUDE.md). It runs on the server side of the web
// apps and on the device in the mobile apps, with the signed-in person's
// session token.

export class AoraApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null,
  ) {
    super(message);
  }
}

/**
 * The request may or may not have reached the API: it timed out or no answer
 * came back. Its outcome is unknown, never "failed" (CLAUDE.md rule 6). A money
 * action is checked or repeated with the same idempotency key, never with a new one.
 */
export class AoraNetworkError extends Error {
  constructor(readonly reason: 'timeout' | 'network') {
    super(reason === 'timeout' ? 'The request timed out.' : 'The request got no answer.');
  }
}

export interface ClientOptions {
  readonly baseUrl: string;
  readonly token: string | null;
  readonly workspaceId?: string;
  /** Default 15 seconds. */
  readonly timeoutMs?: number;
}

/** `AbortSignal.timeout` is missing on some React Native engines. */
function timeoutSignal(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, ms);
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
    },
  };
}

type Query = Record<string, string | number | undefined>;

export class AoraApi {
  constructor(private readonly options: ClientOptions) {}

  forWorkspace(workspaceId: string): AoraApi {
    return new AoraApi({ ...this.options, workspaceId });
  }

  get<T>(path: string, query: Query = {}): Promise<T> {
    return this.request<T>('GET', path, { query });
  }

  post<T>(path: string, body: unknown = {}, idempotencyKey?: string): Promise<T> {
    return this.request<T>('POST', path, { body, ...(idempotencyKey ? { idempotencyKey } : {}) });
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PUT', path, { body });
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, { body });
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path, {});
  }

  private async request<T>(
    method: string,
    path: string,
    options: { query?: Query; body?: unknown; idempotencyKey?: string },
  ): Promise<T> {
    const url = new URL(path, this.options.baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.options.token) headers['authorization'] = `Bearer ${this.options.token}`;
    if (this.options.workspaceId) headers['aora-workspace-id'] = this.options.workspaceId;
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
    if (options.body !== undefined && method !== 'GET')
      headers['content-type'] = 'application/json';

    const timeout = timeoutSignal(this.options.timeoutMs ?? 15_000);
    let response: Response;
    let text: string;
    try {
      response = await fetch(url, {
        method,
        headers,
        cache: 'no-store',
        ...(options.body !== undefined && method !== 'GET'
          ? { body: JSON.stringify(options.body) }
          : {}),
        signal: timeout.signal,
      });
      text = await response.text();
    } catch {
      throw new AoraNetworkError(timeout.signal.aborted ? 'timeout' : 'network');
    } finally {
      timeout.clear();
    }
    const json: unknown = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const error = (json as { error?: { code?: string; message?: string; request_id?: string } })
        .error;
      throw new AoraApiError(
        response.status,
        error?.code ?? 'internal_error',
        error?.message ?? 'The request failed.',
        error?.request_id ?? null,
      );
    }
    return json as T;
  }
}
