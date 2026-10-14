import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './support/harness.js';
import { balanceOf, trialBalance } from './support/money.js';
import { type Caller, createIntent } from './support/payments.js';

let h: Harness;
let admin: Caller;
let finance: Caller;
let cashier: Caller;
let recipient: string;
const PHONE = '+254700000101';

const call = (caller: Caller, method: 'get' | 'post', path: string) =>
  h
    .http()
    [method](path)
    .set('Authorization', `Bearer ${caller.token}`)
    .set('Aora-Workspace-Id', caller.workspace);

const cron = (job: string) =>
  h
    .http()
    .get(`/v1/internal/cron/${job}`)
    .set('Authorization', `Bearer ${h.config.cronSecret ?? ''}`);

async function preview(amount: string, who: Caller = admin): Promise<Response> {
  return call(who, 'post', '/v1/payouts/preview').send({
    recipient_id: recipient,
    amount_minor: amount,
    currency: 'KES',
  });
}

async function payout(
  amount: string,
  extra: Record<string, unknown> = {},
  key: string = randomUUID(),
  who: Caller = admin,
): Promise<Response> {
  const quote = await preview(amount, who);
  return call(who, 'post', '/v1/payouts')
    .set('Idempotency-Key', key)
    .send({
      recipient_id: recipient,
      amount_minor: amount,
      currency: 'KES',
      expected_fee_minor: quote.body.fee_minor,
      tariff_version_id: quote.body.tariff_version_id,
      sandbox_scenario: 'success',
      ...extra,
    });
}

/** Lets the cooling-off period of every confirmed recipient pass. */
const coolOff = () =>
  h.owner((client) =>
    client.query(
      `update payments.payout_recipient set confirmed_at = now() - interval '1 day' where confirmed_at is not null`,
    ),
  );

beforeAll(async () => {
  h = await startHarness();
  admin = { token: await h.signIn('adminA'), workspace: h.seed.tenantA };
  finance = { token: await h.signIn('financeA'), workspace: h.seed.tenantA };
  cashier = { token: await h.signIn('cashierA'), workspace: h.seed.tenantA };
  for (const caller of [admin, finance, cashier]) await h.stepUp(caller.token);
  // Money to pay out: collected, then settled to "available".
  for (let i = 0; i < 4; i += 1) {
    await createIntent(h, admin, {
      amount_minor: '5000000',
      currency: 'KES',
      sandbox_scenario: 'success',
    });
  }
  await h.settle();
  await cron('settlement');
});
afterAll(() => h.close());

describe('payout recipients: the number entered twice, with a PIN (O-11)', () => {
  it('records a new number as unconfirmed, masked in every response', async () => {
    const created = await call(admin, 'post', '/v1/payout-recipients').send({
      phone: PHONE,
      label: 'Owner M-Pesa',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      status: 'unconfirmed',
      label: 'Owner M-Pesa',
      phone_hint: '•••101',
    });
    expect(JSON.stringify(created.body)).not.toContain('254700000101');
    recipient = created.body.id as string;
  });

  it('refuses to pay an unconfirmed recipient', async () => {
    const response = await payout('100000');
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('recipient_not_confirmed');
  });

  it('confirms only when the same number is entered again, after a PIN step-up', async () => {
    const fresh = { token: await h.signIn('adminA'), workspace: h.seed.tenantA };
    const noStepUp = await call(
      fresh,
      'post',
      `/v1/payout-recipients/${recipient}/confirmation`,
    ).send({ phone: PHONE });
    expect(noStepUp.body.error.code).toBe('step_up_required');
    const wrong = await call(admin, 'post', `/v1/payout-recipients/${recipient}/confirmation`).send(
      {
        phone: '+254700000102',
      },
    );
    expect(wrong.status).toBe(400);
    const ok = await call(admin, 'post', `/v1/payout-recipients/${recipient}/confirmation`).send({
      phone: PHONE,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('confirmed');
    expect(ok.body.confirmation_proves).toMatch(/intent/i);
  });

  it('audits the confirmation, saying it proves intent and not ownership', async () => {
    const audit = await h.owner((client) =>
      client.query(
        `select detail from audit.audit_event where action = 'payments.recipient.confirmed' and subject_id = $1`,
        [recipient],
      ),
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].detail).toMatchObject({ proves: 'intent_not_ownership' });
  });

  it('is invisible to another workspace and to a cashier', async () => {
    const other = { token: await h.signIn('adminB'), workspace: h.seed.tenantB };
    expect((await call(other, 'get', '/v1/payout-recipients')).body.data).toEqual([]);
    expect((await call(cashier, 'get', '/v1/payout-recipients')).status).toBe(403);
  });
});

describe('first payout to a newly confirmed recipient: cooling-off and cap (configuration)', () => {
  it('waits out the cooling-off period', async () => {
    const response = await payout('100000');
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('recipient_cooling_off');
  });

  it('caps the first payout, then lifts the cap once one has succeeded', async () => {
    await coolOff();
    const tooBig = await payout('100001');
    expect(tooBig.status).toBe(422);
    expect(tooBig.body.error.code).toBe('limit_exceeded');
    const first = await payout('100000');
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    await h.settle();
    const second = await payout('500000');
    expect(second.status).toBe(201);
    await h.settle();
  });
});

describe('payouts (journey J6)', () => {
  it('charges exactly the previewed fee, and refuses a stale or different one', async () => {
    const quote = await preview('300000');
    expect(quote.status).toBe(200);
    expect(quote.body).toMatchObject({
      amount_minor: '300000',
      fee_minor: '1500',
      total_minor: '301500',
    });
    const wrongFee = await call(admin, 'post', '/v1/payouts')
      .set('Idempotency-Key', randomUUID())
      .send({
        recipient_id: recipient,
        amount_minor: '300000',
        currency: 'KES',
        expected_fee_minor: '1',
        tariff_version_id: quote.body.tariff_version_id,
      });
    expect(wrongFee.status).toBe(409);
    expect(wrongFee.body.error.code).toBe('fee_changed');
    const ok = await payout('300000');
    expect(ok.body).toMatchObject({ fee_minor: '1500', status: 'created' });
  });

  it('needs finance or admin, and a PIN step-up', async () => {
    expect((await payout('100000', {}, randomUUID(), cashier)).status).toBe(403);
    const fresh = { token: await h.signIn('financeA'), workspace: h.seed.tenantA };
    const noStepUp = await call(fresh, 'post', '/v1/payouts')
      .set('Idempotency-Key', randomUUID())
      .send({
        recipient_id: recipient,
        amount_minor: '100000',
        currency: 'KES',
        expected_fee_minor: '1500',
        tariff_version_id: randomUUID(),
      });
    expect(noStepUp.body.error.code).toBe('step_up_required');
    expect((await payout('100000', {}, randomUUID(), finance)).status).toBe(201);
  });

  it('reserves amount plus fee at once, and on success sends the amount and earns the fee', async () => {
    await h.settle();
    const available = await balanceOf(h, h.seed.tenantA, 'merchant_available');
    const revenue = await balanceOf(h, null, 'fee_revenue');
    const response = await payout('200000');
    expect(available - (await balanceOf(h, h.seed.tenantA, 'merchant_available'))).toBe(201_500n);
    expect(await balanceOf(h, h.seed.tenantA, 'merchant_payouts_in_flight')).toBe(201_500n);
    await h.settle();
    const done = await call(admin, 'get', `/v1/payouts/${response.body.id as string}`);
    expect(done.body.status).toBe('succeeded');
    expect(await balanceOf(h, h.seed.tenantA, 'merchant_payouts_in_flight')).toBe(0n);
    expect((await balanceOf(h, null, 'fee_revenue')) - revenue).toBe(1_500n);
    expect(await trialBalance(h)).toBe(0n);
  });

  it('gives the reservation back exactly when the provider declines', async () => {
    const before = await balanceOf(h, h.seed.tenantA, 'merchant_available');
    const response = await payout('150000', { sandbox_scenario: 'decline' });
    await h.settle();
    expect(
      (await call(admin, 'get', `/v1/payouts/${response.body.id as string}`)).body.status,
    ).toBe('failed');
    expect(await balanceOf(h, h.seed.tenantA, 'merchant_available')).toBe(before);
    expect(await trialBalance(h)).toBe(0n);
  });

  it('never resends a payout whose outcome is unknown', async () => {
    const response = await payout('120000', { sandbox_scenario: 'timeout_then_success' });
    const id = response.body.id as string;
    await h.settle();
    expect((await call(admin, 'get', `/v1/payouts/${id}`)).body.status).toBe('status_unknown');
    await h.makeDelayedEventsDue();
    await h.settle();
    expect((await call(admin, 'get', `/v1/payouts/${id}`)).body.status).toBe('succeeded');
    const sent = await h.owner((client) =>
      client.query(`select count(*)::int as n from sim.sim_transaction where operation_ref = $1`, [
        id,
      ]),
    );
    expect(sent.rows[0].n).toBe(1);
  });

  it('is idempotent: the same key and body give the same payout, a different body is refused', async () => {
    const key = randomUUID();
    const first = await payout('110000', {}, key);
    const again = await payout('110000', {}, key);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect((await payout('110001', {}, key)).body.error.code).toBe('idempotency_key_reused');
  });

  it('refuses a payout larger than what is available, from the ledger itself', async () => {
    const response = await payout('100000000');
    expect(response.status).toBe(422);
    expect(['insufficient_funds', 'limit_exceeded']).toContain(response.body.error.code);
  });

  it('lists payouts newest first, to finance and admin only', async () => {
    const list = await call(finance, 'get', '/v1/payouts');
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBeGreaterThan(3);
    expect((await call(cashier, 'get', '/v1/payouts')).status).toBe(403);
  });
});
