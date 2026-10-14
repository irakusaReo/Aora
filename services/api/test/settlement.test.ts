import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './support/harness.js';
import { balanceOf, trialBalance } from './support/money.js';
import { type Caller, createIntent } from './support/payments.js';

let h: Harness;
let admin: Caller;
let cashier: Caller;

const cron = (job: string) =>
  h
    .http()
    .get(`/v1/internal/cron/${job}`)
    .set('Authorization', `Bearer ${h.config.cronSecret ?? ''}`);

beforeAll(async () => {
  h = await startHarness();
  admin = { token: await h.signIn('adminA'), workspace: h.seed.tenantA };
  cashier = { token: await h.signIn('cashierA'), workspace: h.seed.tenantA };
});
afterAll(() => h.close());

describe('settlement (sandbox assumption M-4, ADR 0021)', () => {
  it('moves succeeded collections, net of fee, from pending to available in one batch', async () => {
    for (const amount of ['15000', '25000', '5000']) {
      await createIntent(h, admin, {
        amount_minor: amount,
        currency: 'KES',
        sandbox_scenario: 'success',
      });
    }
    await createIntent(h, admin, {
      amount_minor: '7000',
      currency: 'KES',
      sandbox_scenario: 'decline',
    });
    await h.settle();
    const pendingBefore = await balanceOf(h, h.seed.tenantA, 'merchant_collections_pending');

    const run = await cron('settlement');
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ job: 'settlement', batches: 1 });

    // 15000 → 14850, 25000 → 24750, 5000 → 5000 (free band).
    expect(await balanceOf(h, h.seed.tenantA, 'merchant_available')).toBe(44_600n);
    expect(
      pendingBefore - (await balanceOf(h, h.seed.tenantA, 'merchant_collections_pending')),
    ).toBe(44_600n);
    expect(await trialBalance(h)).toBe(0n);
  });

  it('settles nothing twice, however often the job runs', async () => {
    const again = await cron('settlement');
    expect(again.body.batches).toBe(0);
    expect(await balanceOf(h, h.seed.tenantA, 'merchant_available')).toBe(44_600n);
  });

  it('never settles a collection under review', async () => {
    await createIntent(h, admin, {
      amount_minor: '9000',
      currency: 'KES',
      sandbox_scenario: 'amount_mismatch',
    });
    await h.settle();
    expect((await cron('settlement')).body.batches).toBe(0);
  });

  it('shows the batch with gross, fee, net and count to finance, not to a cashier', async () => {
    const list = await h
      .http()
      .get('/v1/settlements')
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Aora-Workspace-Id', admin.workspace);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({
      currency: 'KES',
      gross_minor: '45000',
      fee_minor: '400',
      net_minor: '44600',
      collections: 3,
    });
    const denied = await h
      .http()
      .get('/v1/settlements')
      .set('Authorization', `Bearer ${cashier.token}`)
      .set('Aora-Workspace-Id', cashier.workspace);
    expect(denied.status).toBe(403);
  });

  it('marks each collection with its batch', async () => {
    const rows = await h.owner((client) =>
      client.query(
        `select count(*)::int as n from payments.payment_intent where settlement_batch_id is not null`,
      ),
    );
    expect(rows.rows[0].n).toBe(3);
  });
});
