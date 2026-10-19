import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MERCHANT_PAYMENT_TRANSITIONS } from '../src/modules/chiwo/merchant-payments.service.js';
import { type Harness, startHarness } from './support/harness.js';
import { balanceOf, trialBalance } from './support/money.js';
import { newUser } from './support/users.js';

/**
 * Journey J12, first part (phase 7A): a consumer signs up to CHIWO and pays a
 * KONY merchant by M-Pesa. Personal and business contexts never mix; fees and
 * timing are shown before authorising. Written before the code.
 */

let h: Harness;
let adminA: string;
let cashierA: string;
let code: string;

type Who = { token: string; workspace?: string };
const call = (who: Who, method: 'get' | 'post', path: string, body: object = {}) => {
  let r = h.http()[method](path).set('Authorization', `Bearer ${who.token}`);
  if (who.workspace) r = r.set('Aora-Workspace-Id', who.workspace);
  return method === 'post' ? r.send(body) : r;
};

async function consumer(name: string, options: { phone?: boolean } = {}): Promise<Who> {
  const user = await newUser(h, name, options);
  if (options.phone === false) return { token: user.token };
  const terms = await h.http().get('/v1/terms/chiwo_terms');
  const signUp = await call({ token: user.token }, 'post', '/v1/chiwo/sign-up', {
    terms_version: terms.body.version as string,
  });
  expect(signUp.status).toBe(201);
  return { token: user.token };
}

async function quote(who: Who, amount: string, payCode = code): Promise<Response> {
  return call(who, 'post', '/v1/chiwo/payments/quote', {
    pay_code: payCode,
    amount_minor: amount,
    currency: 'KES',
  });
}

async function pay(
  who: Who,
  amount: string,
  options: { scenario?: string; key?: string; fee?: string; total?: string; payCode?: string } = {},
): Promise<Response> {
  const q = await quote(who, amount, options.payCode);
  return call(who, 'post', '/v1/chiwo/payments', {
    pay_code: options.payCode ?? code,
    amount_minor: amount,
    currency: 'KES',
    expected_fee_minor: options.fee ?? (q.body.fee_minor as string | undefined) ?? '0',
    expected_total_minor: options.total ?? (q.body.total_minor as string | undefined) ?? amount,
    sandbox_scenario: options.scenario ?? 'success',
  }).set('Idempotency-Key', options.key ?? randomUUID());
}

beforeAll(async () => {
  h = await startHarness();
  adminA = await h.signIn('adminA');
  cashierA = await h.signIn('cashierA');
  const created = await call({ token: adminA, workspace: h.seed.tenantA }, 'post', '/v1/pay-codes');
  expect(created.status).toBe(201);
  code = created.body.code as string;
});

afterAll(async () => {
  await h.close();
});

describe('merchant payment state machine', () => {
  it('moves only forward, with being_checked able to resolve either way', () => {
    expect(MERCHANT_PAYMENT_TRANSITIONS).toEqual({
      submitted: ['succeeded', 'failed', 'being_checked', 'reconciliation_required'],
      being_checked: ['succeeded', 'failed', 'reconciliation_required'],
      succeeded: ['reconciliation_required'],
      failed: ['reconciliation_required'],
      reconciliation_required: [],
    });
  });
});

describe('CHIWO sign-up and the personal context', () => {
  it('needs a phone number and the current terms version, and is idempotent', async () => {
    const noPhone = await newUser(h, 'Nophone', { phone: false });
    const terms = await h.http().get('/v1/terms/chiwo_terms');
    expect(terms.status).toBe(200);
    const version = terms.body.version as string;

    const before = await call({ token: noPhone.token }, 'get', '/v1/chiwo/me');
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ signed_up: false, phone_on_file: false, mode: 'sandbox' });

    const refused = await call({ token: noPhone.token }, 'post', '/v1/chiwo/sign-up', {
      terms_version: version,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('phone_required');

    const user = await newUser(h, 'Wanjiru');
    const stale = await call({ token: user.token }, 'post', '/v1/chiwo/sign-up', {
      terms_version: '0.0.0',
    });
    expect(stale.status).toBe(400);
    expect(stale.body.error.code).toBe('invalid_request');

    const ok = await call({ token: user.token }, 'post', '/v1/chiwo/sign-up', {
      terms_version: version,
    });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ signed_up: true, phone_on_file: true });
    const again = await call({ token: user.token }, 'post', '/v1/chiwo/sign-up', {
      terms_version: version,
    });
    expect(again.status).toBe(200);
    const consents = await h.owner(
      async (client) =>
        (
          await client.query(
            `select c.capacity, t.key from consent.consent_record c
               join consent.terms_document t on t.id = c.terms_document_id
              where c.account_id = $1`,
            [user.accountId],
          )
        ).rows,
    );
    expect(consents).toEqual([{ capacity: 'personal', key: 'chiwo_terms' }]);
  });

  it('refuses any CHIWO request that names a workspace', async () => {
    const me = await call({ token: adminA, workspace: h.seed.tenantA }, 'get', '/v1/chiwo/me');
    expect(me.status).toBe(400);
    expect(me.body.error.code).toBe('context_mismatch');
  });

  it('gives a workspace member nothing in CHIWO until they sign up themself', async () => {
    const lookup = await call({ token: adminA }, 'get', `/v1/chiwo/merchants/${code}`);
    expect(lookup.status).toBe(403);
    expect(lookup.body.error.code).toBe('sign_up_required');
    const payment = await pay({ token: adminA }, '10000');
    expect(payment.status).toBe(403);
  });

  it('requires a session', async () => {
    expect((await h.http().get('/v1/chiwo/me')).status).toBe(401);
  });
});

describe('merchant pay codes', () => {
  it('are created by an admin only', async () => {
    const refused = await call(
      { token: cashierA, workspace: h.seed.tenantA },
      'post',
      '/v1/pay-codes',
    );
    expect(refused.status).toBe(403);
    const list = await call({ token: adminA, workspace: h.seed.tenantA }, 'get', '/v1/pay-codes');
    expect(list.status).toBe(200);
    expect((list.body.data as { code: string }[]).map((c) => c.code)).toContain(code);
    expect(code).toMatch(/^[2-9A-HJ-NP-Z]{8}$/);
  });

  it('reveal only the trading name and the sandbox label to a consumer', async () => {
    const who = await consumer('Otieno');
    const found = await call(who, 'get', `/v1/chiwo/merchants/${code}`);
    expect(found.status).toBe(200);
    expect(Object.keys(found.body as object).sort()).toEqual(['code', 'mode', 'trading_name']);
    expect(found.body.mode).toBe('sandbox');
    expect((await call(who, 'get', '/v1/chiwo/merchants/ZZZZZZZZ')).status).toBe(404);
  });

  it('stop working once deactivated', async () => {
    const admin = { token: adminA, workspace: h.seed.tenantA };
    const extra = (await call(admin, 'post', '/v1/pay-codes')).body.code as string;
    expect((await call(admin, 'post', `/v1/pay-codes/${extra}/deactivate`)).status).toBe(200);
    const who = await consumer('Akinyi');
    expect((await call(who, 'get', `/v1/chiwo/merchants/${extra}`)).status).toBe(404);
    expect((await pay(who, '10000', { payCode: extra })).status).toBe(404);
  });
});

describe('paying a merchant', () => {
  it('shows the amount, the fee the consumer pays, the total and the timing before authorising', async () => {
    const who = await consumer('Mwangi');
    const q = await quote(who, '150000');
    expect(q.status).toBe(200);
    expect(q.body).toMatchObject({
      amount_minor: '150000',
      fee_minor: '0',
      total_minor: '150000',
      currency: 'KES',
      rail: 'mpesa',
      mode: 'sandbox',
    });
    expect(typeof q.body.timing).toBe('string');
    expect(q.body.timing.length).toBeGreaterThan(10);
    expect(q.body.payer_number).toBe('sandbox_test_number');
  });

  it('refuses a payment whose fee or total differs from the quote', async () => {
    const who = await consumer('Njeri');
    const r = await pay(who, '20000', { fee: '5' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('fee_changed');
    const t = await pay(who, '20000', { total: '20001' });
    expect(t.status).toBe(409);
  });

  it('becomes the merchant collection with gross, fee and net, and succeeds for the consumer', async () => {
    const who = await consumer('Kamau');
    const pendingBefore = await balanceOf(h, h.seed.tenantA, 'merchant_collections_pending');
    const r = await pay(who, '250000');
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'submitted', amount_minor: '250000', mode: 'sandbox' });
    expect(r.body).not.toHaveProperty('tenant_id');
    await h.settle();

    const mine = await call(who, 'get', `/v1/chiwo/payments/${r.body.id as string}`);
    expect(mine.body.status).toBe('succeeded');
    // The consumer never sees the merchant's intent.
    expect(mine.body).not.toHaveProperty('payment_intent_id');

    const intents = await call(
      { token: adminA, workspace: h.seed.tenantA },
      'get',
      '/v1/payment-intents',
    );
    const [row] = await h.owner(
      async (client) =>
        (
          await client.query<{
            intent_id: string;
            channel: string;
            fee_amount: string;
            amount: string;
          }>(
            `select m.intent_id, i.channel, i.fee_amount::text, i.amount::text
               from chiwo.merchant_payment m join payments.payment_intent i on i.id = m.intent_id
              where m.id = $1`,
            [r.body.id],
          )
        ).rows,
    );
    expect(row?.channel).toBe('chiwo');
    const listed = (
      intents.body.data as { id: string; net_minor: string; fee_minor: string }[]
    ).find((i) => i.id === row?.intent_id);
    expect(listed).toBeDefined();
    expect(BigInt(listed?.fee_minor ?? '-1') + BigInt(listed?.net_minor ?? '0')).toBe(250000n);
    const pendingAfter = await balanceOf(h, h.seed.tenantA, 'merchant_collections_pending');
    expect(pendingAfter - pendingBefore).toBe(BigInt(listed?.net_minor ?? '0'));
    expect(await trialBalance(h)).toBe(0n);
  });

  it('follows a declined payment to failed and an unanswered one to being_checked', async () => {
    const who = await consumer('Chebet');
    const declined = await pay(who, '30000', { scenario: 'decline' });
    const slow = await pay(who, '31000', { scenario: 'timeout_then_success' });
    await h.settle();
    expect(
      (await call(who, 'get', `/v1/chiwo/payments/${declined.body.id as string}`)).body.status,
    ).toBe('failed');
    expect(
      (await call(who, 'get', `/v1/chiwo/payments/${slow.body.id as string}`)).body.status,
    ).toBe('being_checked');
    await h.makeDelayedEventsDue();
    await h.settle();
    expect(
      (await call(who, 'get', `/v1/chiwo/payments/${slow.body.id as string}`)).body.status,
    ).toBe('succeeded');
  });

  it('replays a repeated request and refuses a reused key with a different body', async () => {
    const who = await consumer('Wafula');
    const key = randomUUID();
    const first = await pay(who, '12000', { key });
    const second = await pay(who, '12000', { key });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    const other = await pay(who, '12001', { key });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('idempotency_key_reused');
  });

  it('makes exactly one payment and one intent from concurrent duplicates', async () => {
    const who = await consumer('Kiprop');
    const key = randomUUID();
    const results = await Promise.all([1, 2, 3, 4].map(() => pay(who, '13000', { key })));
    const ids = new Set(results.map((r) => r.body.id as string));
    expect(ids.size).toBe(1);
    const [count] = await h.owner(
      async (client) =>
        (
          await client.query<{ n: string }>(
            `select count(*)::text as n from chiwo.merchant_payment where idempotency_key = $1`,
            [key],
          )
        ).rows,
    );
    expect(count?.n).toBe('1');
  });

  it('refuses a payment above the configured per-payment limit', async () => {
    const who = await consumer('Achieng');
    const limit = await h.owner(
      async (client) =>
        (
          await client.query<{ per_payment_max: string }>(
            `select per_payment_max::text from chiwo.consumer_limit
              where operation = 'merchant_payment' and asset_code = 'KES'
              order by effective_from desc limit 1`,
          )
        ).rows[0]?.per_payment_max,
    );
    expect(limit).toBeDefined();
    const over = (BigInt(limit ?? '0') + 100n).toString();
    const r = await pay(who, over);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('limit_exceeded');
  });

  it('sends the consumer one receipt email and the merchant no per-person alert', async () => {
    const user = await newUser(h, 'Muthoni');
    const terms = await h.http().get('/v1/terms/chiwo_terms');
    await call({ token: user.token }, 'post', '/v1/chiwo/sign-up', {
      terms_version: terms.body.version as string,
    });
    const r = await pay({ token: user.token }, '14000');
    await h.settle();
    const rows = await h.owner(
      async (client) =>
        (
          await client.query<{ type: string; account_id: string }>(
            `select type, account_id from notifications.notification where dedupe_key like $1`,
            [`%${r.body.id as string}%`],
          )
        ).rows,
    );
    expect(rows).toEqual([{ type: 'chiwo.payment.receipt', account_id: user.accountId }]);
    const [intent] = await h.owner(
      async (client) =>
        (
          await client.query<{ intent_id: string }>(
            `select intent_id from chiwo.merchant_payment where id = $1`,
            [r.body.id],
          )
        ).rows,
    );
    const alerts = await h.owner(
      async (client) =>
        (
          await client.query(`select 1 from notifications.notification where dedupe_key = $1`, [
            `payment.received:${intent?.intent_id ?? ''}`,
          ])
        ).rows,
    );
    expect(alerts).toEqual([]);
  });

  it('gives a receipt and an activity list with masked parties', async () => {
    const who = await consumer('Odhiambo');
    const r = await pay(who, '15000');
    await h.settle();
    const receipt = await call(
      who,
      'get',
      `/v1/chiwo/receipts/merchant_payment/${r.body.id as string}`,
    );
    expect(receipt.status).toBe(200);
    expect(receipt.body).toMatchObject({
      kind: 'merchant_payment',
      status: 'succeeded',
      amount_minor: '15000',
      fee_minor: '0',
      currency: 'KES',
      mode: 'sandbox',
    });
    expect(receipt.body.merchant.trading_name).toBeTruthy();
    expect(JSON.stringify(receipt.body)).not.toMatch(/\+999/);
    const activity = await call(who, 'get', '/v1/chiwo/activity');
    expect((activity.body.data as { id: string }[]).map((a) => a.id)).toContain(r.body.id);
  });
});

describe('consumer isolation', () => {
  it('hides one consumer’s payments from another and from every workspace', async () => {
    const a = await consumer('Zawadi');
    const b = await consumer('Baraka');
    const r = await pay(a, '16000');
    expect((await call(b, 'get', `/v1/chiwo/payments/${r.body.id as string}`)).status).toBe(404);
    expect(
      (await call(b, 'get', `/v1/chiwo/receipts/merchant_payment/${r.body.id as string}`)).status,
    ).toBe(404);
    const bAccount = (await call(b, 'get', '/v1/me')).body.account_id as string;
    const seenByB = await h.db.withConsumer(
      bAccount,
      (tx) => tx.$queryRaw<{ id: string }[]>`select id from chiwo.merchant_payment`,
    );
    expect(seenByB.map((row) => row.id)).not.toContain(r.body.id);
    const seenByTenant = await h.db.withTenant(
      h.seed.tenantA,
      (tx) => tx.$queryRaw<{ id: string }[]>`select id from chiwo.merchant_payment`,
    );
    expect(seenByTenant).toEqual([]);
    const consumersSeenByTenant = await h.db.withTenant(
      h.seed.tenantA,
      (tx) => tx.$queryRaw<{ account_id: string }[]>`select account_id from chiwo.consumer`,
    );
    expect(consumersSeenByTenant).toEqual([]);
  });
});
