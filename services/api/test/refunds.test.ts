import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './support/harness.js';
import { balanceOf, trialBalance } from './support/money.js';
import { type Caller, createIntent } from './support/payments.js';

let h: Harness;
let admin: Caller;
let cashier: Caller;
let paid: string;

const refund = (
  intentId: string,
  amount: string,
  extra: Record<string, unknown> = {},
  key: string = randomUUID(),
  who: Caller = admin,
): Promise<Response> =>
  h
    .http()
    .post(`/v1/payment-intents/${intentId}/refunds`)
    .set('Authorization', `Bearer ${who.token}`)
    .set('Aora-Workspace-Id', who.workspace)
    .set('Idempotency-Key', key)
    .send({ amount_minor: amount, sandbox_scenario: 'success', ...extra });

const getRefund = (id: string) =>
  h
    .http()
    .get(`/v1/refunds/${id}`)
    .set('Authorization', `Bearer ${admin.token}`)
    .set('Aora-Workspace-Id', admin.workspace);

beforeAll(async () => {
  h = await startHarness();
  admin = { token: await h.signIn('adminA'), workspace: h.seed.tenantA };
  cashier = { token: await h.signIn('cashierA'), workspace: h.seed.tenantA };
  await h.stepUp(admin.token);
  await h.stepUp(cashier.token);
  const intent = await createIntent(h, admin, {
    // Gross KES 1,000.00; the merchant holds 990.00 after the 1 % fee.
    amount_minor: '100000',
    currency: 'KES',
    sandbox_scenario: 'success',
  });
  paid = intent.body.id as string;
  await h.settle();
});
afterAll(() => h.close());

describe('refunds (journey J6)', () => {
  it('refunds part of a collection with a compensating entry, and keeps the ledger balanced', async () => {
    const pending = await balanceOf(h, h.seed.tenantA, 'merchant_collections_pending');
    const response = await refund(paid, '20000');
    expect(response.status).toBe(201);
    await h.settle();
    expect((await getRefund(response.body.id as string)).body.status).toBe('succeeded');
    expect(pending - (await balanceOf(h, h.seed.tenantA, 'merchant_collections_pending'))).toBe(
      20_000n,
    );
    expect(await trialBalance(h)).toBe(0n);
  });

  it('never refunds more than the collection, even under concurrent requests', async () => {
    const attempts = await Promise.all(Array.from({ length: 4 }, () => refund(paid, '50000')));
    const accepted = attempts.filter((response) => response.status === 201);
    // 20 000 already refunded + 50 000 = 70 000 ≤ 100 000; a second 50 000 would exceed it.
    expect(accepted).toHaveLength(1);
    for (const response of attempts.filter((r) => r.status !== 201)) {
      expect(response.body.error.code).toBe('refund_exceeds_collection');
    }
    await h.settle();
  });

  it('frees the amount again when a refund fails', async () => {
    const declined = await refund(paid, '10000', { sandbox_scenario: 'decline' });
    await h.settle();
    expect((await getRefund(declined.body.id as string)).body.status).toBe('failed');
    expect((await refund(paid, '10000')).status).toBe(201);
    await h.settle();
  });

  it('refuses a collection that did not succeed, or belongs to another workspace', async () => {
    const failed = await createIntent(h, admin, {
      amount_minor: '5000',
      currency: 'KES',
      sandbox_scenario: 'decline',
    });
    await h.settle();
    expect((await refund(failed.body.id as string, '1000')).status).toBe(409);
    const other = { token: await h.signIn('adminB'), workspace: h.seed.tenantB };
    await h.stepUp(other.token);
    expect((await refund(paid, '1000', {}, randomUUID(), other)).status).toBe(404);
  });

  it('needs finance or admin and a PIN step-up', async () => {
    expect((await refund(paid, '100', {}, randomUUID(), cashier)).status).toBe(403);
  });

  it('is idempotent on its key', async () => {
    const second = await createIntent(h, admin, {
      amount_minor: '8000',
      currency: 'KES',
      sandbox_scenario: 'success',
    });
    await h.settle();
    const key = randomUUID();
    const a = await refund(second.body.id as string, '1000', {}, key);
    const b = await refund(second.body.id as string, '1000', {}, key);
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
  });

  it('refuses any write past the cap at the database too', async () => {
    await expect(
      h.owner((client) =>
        client.query(
          `insert into payments.refund (tenant_id, idempotency_key, request_hash, intent_id, amount, asset_code, provider, created_by)
           select tenant_id, 'raw', 'x', id, 999999, asset_code, provider, created_by from payments.payment_intent where id = $1`,
          [paid],
        ),
      ),
    ).rejects.toThrow(/exceed/);
  });
});
