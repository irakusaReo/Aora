import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/platform/rate-limit.js';
import { type Harness, startHarness } from './support/harness.js';

let a: Harness;
let b: Harness;

beforeAll(async () => {
  a = await startHarness({ realRateLimits: true });
  // A second application instance on the same database, as two serverless instances would be.
  b = await startHarness({ realRateLimits: true, shareDatabaseOf: a });
});
afterAll(async () => {
  await b.close();
  await a.close();
});

const consume = (h: Harness, key: string): Promise<'ok' | 'limited'> =>
  h.app
    .get(RateLimiter)
    .consume('pin_step_up_account', key)
    .then(
      () => 'ok' as const,
      () => 'limited' as const,
    );

describe('rate limiting on a shared store', () => {
  it('allows exactly the limit under concurrent requests split across instances', async () => {
    const limit = a.config.rateLimits.pin_step_up_account.limit;
    const results = await Promise.all(
      Array.from({ length: limit * 4 }, (_, i) => consume(i % 2 ? a : b, 'account-1')),
    );
    expect(results.filter((result) => result === 'ok')).toHaveLength(limit);
    expect(results.filter((result) => result === 'limited')).toHaveLength(limit * 3);
  });

  it('counts each key separately', async () => {
    expect(await consume(a, 'account-2')).toBe('ok');
    expect(await consume(b, 'account-1')).toBe('limited');
  });

  it('opens a new window when the old one has passed', async () => {
    await a.owner((client) =>
      client.query(`update ops.rate_limit set window_start = window_start - interval '1 hour'`),
    );
    expect(await consume(a, 'account-1')).toBe('ok');
  });

  it('stores only a digest of the key', async () => {
    const rows = await a.owner((client) =>
      client.query<{ bucket: string }>(`select bucket from ops.rate_limit`),
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const row of rows.rows) expect(row.bucket).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is not readable or writable by the tenant role', async () => {
    await expect(
      a.db.withTenant(a.seed.tenantA, (tx) => tx.$queryRaw`select * from ops.rate_limit`),
    ).rejects.toThrow(/permission denied/);
  });

  it('limits PIN attempts through the API', async () => {
    const token = await a.signIn('adminB');
    const limit = a.config.rateLimits.pin_step_up_account.limit;
    const statuses: number[] = [];
    for (let i = 0; i < limit + 1; i += 1) {
      const response = await a
        .http()
        .post('/v1/auth/step-up')
        .set('Authorization', `Bearer ${token}`)
        .send({ pin: '482915' });
      statuses.push(response.status);
    }
    expect(statuses.slice(0, limit).every((status) => status === 409)).toBe(true);
    expect(statuses[limit]).toBe(429);
  });
});
