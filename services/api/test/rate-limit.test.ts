import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

const start = (h: Harness, phone: string) => h.http().post('/v1/auth/challenges').send({ phone });

describe('rate limiting on a shared store', () => {
  it('allows exactly the limit under concurrent requests split across instances', async () => {
    const limit = a.config.rateLimits.sign_in_start_phone.limit;
    const responses = await Promise.all(
      Array.from({ length: limit * 4 }, (_, i) => start(i % 2 ? a : b, '+99900000001')),
    );
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 201)).toHaveLength(limit);
    expect(statuses.filter((status) => status === 429)).toHaveLength(limit * 3);
    const blocked = responses.find((response) => response.status === 429);
    expect(blocked?.body.error.code).toBe('too_many_attempts');
  });

  it('counts each phone number separately', async () => {
    expect((await start(a, '+99900000002')).status).toBe(201);
    expect((await start(b, '+99900000001')).status).toBe(429);
  });

  it('applies to numbers without an account too, so the limit reveals nothing', async () => {
    const limit = a.config.rateLimits.sign_in_start_phone.limit;
    const statuses: number[] = [];
    for (let i = 0; i < limit + 1; i += 1) statuses.push((await start(a, '+99977700000')).status);
    expect(statuses).toEqual([...Array<number>(limit).fill(201), 429]);
  });

  it('opens a new window when the old one has passed', async () => {
    await a.owner((client) =>
      client.query(`update ops.rate_limit set window_start = window_start - interval '1 hour'`),
    );
    expect((await start(a, '+99900000001')).status).toBe(201);
  });

  it('stores no phone number or address, only a digest', async () => {
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
});
