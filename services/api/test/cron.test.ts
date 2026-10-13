import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './support/harness.js';
import {
  type Caller,
  createIntent,
  exceptionTypes,
  ledgerFor,
  statusOf,
} from './support/payments.js';

// Vercel Cron delivery is best effort: a run can be missed, delivered twice, or
// overlap the next one, and failures are not retried (ADR 0013). Every job must
// therefore be authenticated, idempotent, bounded in time, and "process
// everything due" rather than "process this tick".

let h: Harness;
let admin: Caller;

beforeAll(async () => {
  h = await startHarness();
  admin = { token: await h.signIn('adminA'), workspace: h.seed.tenantA };
});
afterAll(() => h.close());

const cron = (job: string, secret: string | null = h.config.cronSecret) => {
  const call = h.http().get(`/v1/internal/cron/${job}`);
  return secret === null ? call : call.set('Authorization', `Bearer ${secret}`);
};

describe('cron jobs', () => {
  it.each(['outbox', 'sim-webhooks', 'reconciliation'])(
    '%s requires the cron secret',
    async (job) => {
      expect((await cron(job, null)).status).toBe(401);
      expect((await cron(job, 'x'.repeat(64))).status).toBe(401);
      expect((await cron(job, `${h.config.cronSecret ?? ''}x`)).status).toBe(401);
      expect(
        (
          await h
            .http()
            .get(`/v1/internal/cron/${job}`)
            .set('Authorization', `Bearer ${admin.token}`)
        ).status,
      ).toBe(401);
    },
  );

  it('take a payment to success using only cron-triggered work', async () => {
    const created = await createIntent(h, admin, { amount_minor: '8800', currency: 'KES' });
    const id = created.body.id as string;
    const first = await cron('outbox');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ job: 'outbox', handled: 1, mode: 'sandbox' });
    expect((await cron('sim-webhooks')).body).toMatchObject({ delivered: 1 });
    expect((await cron('outbox')).body).toMatchObject({ handled: 1 });
    expect(await statusOf(h, admin, id)).toBe('succeeded');
    expect(await ledgerFor(h, id)).toEqual({ entries: 1, credited: '8800' });
  });

  it('have no further effect when delivered again, or many times at once', async () => {
    const before = await h.owner((client) =>
      client.query(`select count(*) as n from ledger.posting`),
    );
    const again = await Promise.all([
      cron('outbox'),
      cron('outbox'),
      cron('sim-webhooks'),
      cron('sim-webhooks'),
      cron('outbox'),
    ]);
    for (const response of again) expect(response.status).toBe(200);
    const after = await h.owner((client) =>
      client.query(`select count(*) as n from ledger.posting`),
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('process everything due in one run, so a missed tick loses nothing', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const created = await createIntent(h, admin, { amount_minor: '100', currency: 'KES' });
      ids.push(created.body.id as string);
    }
    expect((await cron('outbox')).body.handled).toBe(7);
    expect((await cron('sim-webhooks')).body.delivered).toBe(7);
    expect((await cron('outbox')).body.handled).toBe(7);
    for (const id of ids) expect(await statusOf(h, admin, id)).toBe('succeeded');
  });

  it('stop when the time budget is spent and leave the rest for the next run', async () => {
    const tight = await startHarness({
      shareDatabaseOf: h,
      config: (config) => ({
        ...config,
        cronSecret: h.config.cronSecret,
        jobs: { ...config.jobs, budgetMs: 0 },
      }),
    });
    await createIntent(h, admin, { amount_minor: '100', currency: 'KES' });
    const response = await tight
      .http()
      .get('/v1/internal/cron/outbox')
      .set('Authorization', `Bearer ${h.config.cronSecret ?? ''}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ handled: 0, budget_exhausted: true });
    await tight.close();
    expect((await cron('outbox')).body.handled).toBe(1);
    await h.settle();
  });

  it('never run two reconciliations at once', async () => {
    const results = await Promise.all([
      cron('reconciliation'),
      cron('reconciliation'),
      cron('reconciliation'),
    ]);
    const ran = results.filter((response) => response.body.skipped !== true);
    const skipped = results.filter((response) => response.body.skipped === true);
    expect(results.every((response) => response.status === 200)).toBe(true);
    expect(ran).toHaveLength(1);
    expect(skipped).toHaveLength(2);
    expect(skipped[0]?.body.reason).toBe('already_running');
    expect(await exceptionTypes(h)).toEqual([]);
    // The lease is released, so the next run proceeds.
    expect((await cron('reconciliation')).body.skipped).toBeUndefined();
  });
});
