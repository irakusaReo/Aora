// A thin, typed client for the AORA API. It holds no business logic: every
// rule lives in the API (CLAUDE.md). It runs on the server side of the web
// apps, with the signed-in person's session token.

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

export interface ClientOptions {
  readonly baseUrl: string;
  readonly token: string | null;
  readonly workspaceId?: string;
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

    const response = await fetch(url, {
      method,
      headers,
      cache: 'no-store',
      ...(options.body !== undefined && method !== 'GET'
        ? { body: JSON.stringify(options.body) }
        : {}),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
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
