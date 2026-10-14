import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/platform/config.js';
import { type DarajaStub, startDarajaStub } from './support/daraja-stub.js';
import { type Harness, startHarness } from './support/harness.js';
import {
  type Caller,
  createIntent,
  exceptionTypes,
  ledgerFor,
  statusOf,
} from './support/payments.js';

let h: Harness;
let stub: DarajaStub;
let admin: Caller;
const PHONE = '+254708374149';

beforeAll(async () => {
  stub = await startDarajaStub();
  h = await startHarness({
    config: (config) => ({
      ...config,
      payments: { ...config.payments, maxStatusInquiries: 3 },
      daraja: {
        baseUrl: stub.baseUrl,
        consumerKey: stub.credentials.consumerKey,
        consumerSecret: stub.credentials.consumerSecret,
        shortcode: stub.credentials.shortcode,
        passkey: stub.credentials.passkey,
        testMsisdn: stub.credentials.testMsisdn,
        callbackSecret: 'c'.repeat(64),
        requestTimeoutMs: 1_000,
      },
    }),
  });
  admin = { token: await h.signIn('adminA'), workspace: h.seed.tenantA };
});
afterAll(async () => {
  await h.close();
  await stub.close();
});
beforeEach(() => {
  stub.pushBehaviours = [];
});

const collect = (body: Record<string, unknown> = {}) =>
  createIntent(h, admin, { amount_minor: '15000', currency: 'KES', payer_phone: PHONE, ...body });

async function started(
  body: Record<string, unknown> = {},
): Promise<{ id: string; push: Record<string, unknown> }> {
  const response = await collect(body);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  await h.settle();
  const push = stub.pushes.at(-1);
  if (!push) throw new Error('no push reached the provider');
  return { id: response.body.id as string, push };
}

const checkoutOf = (push: Record<string, unknown>): string => String(push['__checkout']);
const callbackUrl = (push: Record<string, unknown>): string =>
  new URL(String(push['CallBackURL'])).pathname;

function deliver(path: string, body: string) {
  return h.http().post(path).set('Content-Type', 'application/json').send(body);
}

async function inquire(): Promise<void> {
  await h.makeDelayedEventsDue();
  await h.settle();
}

describe('routing an M-Pesa collection', () => {
  it('sends a collection to Daraja, and a scripted sandbox scenario to the simulator', async () => {
    const real = await collect();
    expect(real.body.provider).toBe('daraja');
    const simulated = await createIntent(h, admin, {
      amount_minor: '15000',
      currency: 'KES',
      sandbox_scenario: 'success',
    });
    expect(simulated.body.provider).toBe('sandbox_sim');
  });

  it("needs the payer's phone number, and in the sandbox only the Daraja test number", async () => {
    const none = await createIntent(h, admin, { amount_minor: '15000', currency: 'KES' });
    expect(none.status).toBe(400);
    const real = await collect({ payer_phone: '+254712345678' });
    expect(real.status).toBe(400);
    expect(real.body.error.message).toMatch(/test number/i);
  });

  it('refuses part of a shilling: the M-Pesa amount is whole shillings', async () => {
    const response = await collect({ amount_minor: '15050' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_request');
  });

  it("keeps the payer's number off the payment intent and away from the tenant role", async () => {
    const { id } = await started();
    const intent = await h.owner((client) =>
      client.query(
        `select row_to_json(i)::text as row from payments.payment_intent i where id = $1`,
        [id],
      ),
    );
    expect(intent.rows[0].row).not.toContain('708374149');
    await expect(
      h.db.withTenant(h.seed.tenantA, (tx) => tx.provider_operation.findMany()),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('the STK push request', () => {
  it('is built as the Daraja documentation describes', async () => {
    const { id, push } = await started({ reference: 'ORDER-1234567890' });
    const timestamp = String(push['Timestamp']);
    expect(timestamp).toMatch(/^\d{14}$/);
    expect(push).toMatchObject({
      BusinessShortCode: '174379',
      TransactionType: 'CustomerPayBillOnline',
      Amount: '150',
      PartyA: '254708374149',
      PartyB: '174379',
      PhoneNumber: '254708374149',
      Password: Buffer.from(`174379${'a'.repeat(64)}${timestamp}`).toString('base64'),
    });
    expect(String(push['AccountReference']).length).toBeLessThanOrEqual(12);
    expect(String(push['TransactionDesc']).length).toBeLessThanOrEqual(13);
    expect(callbackUrl(push)).toMatch(new RegExp(`^/v1/webhooks/daraja/stk/${id}/[0-9a-f]{64}$`));
    expect(await statusOf(h, admin, id)).toBe('pending_provider');
  });

  it('reuses one access token across requests', async () => {
    const before = stub.tokenRequests;
    await started();
    await started();
    expect(stub.tokenRequests - before).toBe(0);
  });
});

describe('a callback is never trusted for money', () => {
  it('posts to the ledger only after a status query confirms success', async () => {
    const { id, push } = await started();
    const checkout = checkoutOf(push);
    const received = await deliver(callbackUrl(push), stub.callback(checkout, 'success', '150.00'));
    expect(received.status).toBe(200);
    // The query still says "processing": the callback alone changes nothing.
    await h.settle();
    expect(await statusOf(h, admin, id)).toBe('pending_provider');
    expect((await ledgerFor(h, id)).entries).toBe(0);

    stub.queryState.set(checkout, 'success');
    await inquire();
    expect(await statusOf(h, admin, id)).toBe('succeeded');
    expect(await ledgerFor(h, id)).toEqual({ entries: 1, credited: '15000' });
    const receipt = await h.owner((client) =>
      client.query(`select receipt from payments.provider_operation where operation_id = $1`, [id]),
    );
    expect(receipt.rows[0].receipt).toMatch(/^SBX/);
  });

  it('settles without any callback, because callbacks can be lost', async () => {
    const { id, push } = await started();
    stub.queryState.set(checkoutOf(push), 'success');
    await inquire();
    expect(await statusOf(h, admin, id)).toBe('succeeded');
  });

  it('keeps asking while the provider says "still processing", then gives up to an operator', async () => {
    const { id } = await started();
    for (let round = 0; round < 3; round += 1) await inquire();
    expect(await statusOf(h, admin, id)).toBe('reconciliation_required');
    expect(await exceptionTypes(h, id)).toContain('stuck_status_unknown');
  });

  it('fails a cancelled payment, with no ledger entry', async () => {
    const { id, push } = await started();
    stub.queryState.set(checkoutOf(push), 'cancelled');
    await deliver(callbackUrl(push), stub.callback(checkoutOf(push), 'cancelled'));
    await inquire();
    expect(await statusOf(h, admin, id)).toBe('failed');
    expect((await ledgerFor(h, id)).entries).toBe(0);
  });

  it('believes the query over a callback that contradicts it, and flags the difference', async () => {
    const { id, push } = await started();
    stub.queryState.set(checkoutOf(push), 'cancelled');
    await deliver(callbackUrl(push), stub.callback(checkoutOf(push), 'success', '150.00'));
    await inquire();
    expect(await statusOf(h, admin, id)).toBe('failed');
    expect((await ledgerFor(h, id)).entries).toBe(0);
    expect(await exceptionTypes(h, id)).toContain('provider_result_conflict');
  });

  it('sends a confirmed payment whose callback shows a different amount to an operator', async () => {
    const { id, push } = await started();
    await deliver(callbackUrl(push), stub.callback(checkoutOf(push), 'success', '151.00'));
    await h.settle();
    stub.queryState.set(checkoutOf(push), 'success');
    await inquire();
    expect(await statusOf(h, admin, id)).toBe('reconciliation_required');
    expect(await exceptionTypes(h, id)).toContain('amount_mismatch');
    expect((await ledgerFor(h, id)).entries).toBe(0);
  });

  it('flags a callback that arrives after the query and contradicts it', async () => {
    const { id, push } = await started();
    stub.queryState.set(checkoutOf(push), 'success');
    await inquire();
    expect(await statusOf(h, admin, id)).toBe('succeeded');
    await deliver(callbackUrl(push), stub.callback(checkoutOf(push), 'cancelled'));
    await h.settle();
    expect(await statusOf(h, admin, id)).toBe('succeeded');
    expect(await exceptionTypes(h, id)).toContain('provider_result_conflict');
  });

  it('sends a settled payment to an operator when a late callback shows another amount', async () => {
    const { id, push } = await started();
    stub.queryState.set(checkoutOf(push), 'success');
    await inquire();
    await deliver(callbackUrl(push), stub.callback(checkoutOf(push), 'success', '149.00'));
    await h.settle();
    expect(await statusOf(h, admin, id)).toBe('reconciliation_required');
    expect(await exceptionTypes(h, id)).toContain('amount_mismatch');
  });

  it('handles a repeated callback once', async () => {
    const { id, push } = await started();
    const body = stub.callback(checkoutOf(push), 'success', '150.00');
    stub.queryState.set(checkoutOf(push), 'success');
    for (let i = 0; i < 3; i += 1)
      expect((await deliver(callbackUrl(push), body)).status).toBe(200);
    await inquire();
    expect(await ledgerFor(h, id)).toEqual({ entries: 1, credited: '15000' });
    const stored = await h.owner((client) =>
      client.query(
        `select count(*)::int as n from payments.webhook_event where provider = 'daraja' and provider_event_id like $1`,
        [`%${checkoutOf(push)}%`],
      ),
    );
    expect(stored.rows[0].n).toBe(1);
  });

  it('refuses a callback without the right token, and stores nothing', async () => {
    const { id, push } = await started();
    const forged = `/v1/webhooks/daraja/stk/${id}/${'0'.repeat(64)}`;
    const otherIntent = callbackUrl(push).replace(id, randomUUID());
    for (const path of [forged, otherIntent, `/v1/webhooks/daraja/stk/${id}/short`]) {
      const response = await deliver(path, stub.callback(checkoutOf(push), 'success'));
      expect(response.status, path).toBe(401);
    }
    const stored = await h.owner((client) =>
      client.query(
        `select count(*)::int as n from payments.webhook_event where provider = 'daraja' and provider_event_id like $1`,
        [`%${checkoutOf(push)}%`],
      ),
    );
    expect(stored.rows[0].n).toBe(0);
  });
});

describe('unknown outcomes are never sent again', () => {
  it('a push that times out becomes status_unknown, is never pushed again, and ends with an operator', async () => {
    const before = stub.pushes.length;
    stub.pushBehaviours = ['timeout'];
    const response = await collect();
    const id = response.body.id as string;
    await h.settle();
    expect(await statusOf(h, admin, id)).toBe('status_unknown');
    for (let round = 0; round < 4; round += 1) await inquire();
    expect(stub.pushes.length - before).toBe(1);
    expect(await statusOf(h, admin, id)).toBe('reconciliation_required');
  });

  it('a push refused by the rate limiter fails cleanly and is not retried', async () => {
    const before = stub.pushes.length;
    stub.pushBehaviours = ['busy_429'];
    const response = await collect();
    await h.settle();
    const view = await h
      .http()
      .get(`/v1/payment-intents/${response.body.id as string}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Aora-Workspace-Id', admin.workspace);
    expect(view.body).toMatchObject({ status: 'failed', failure_code: 'provider_busy' });
    expect(stub.pushes.length - before).toBe(1);
  });

  it('a push refused for an invalid access token is retried once with a fresh token', async () => {
    const pushesBefore = stub.pushes.length;
    const tokensBefore = stub.tokenRequests;
    stub.pushBehaviours = ['invalid_token_once'];
    const { id } = await started();
    expect(await statusOf(h, admin, id)).toBe('pending_provider');
    expect(stub.pushes.length - pushesBefore).toBe(2);
    expect(stub.tokenRequests - tokensBefore).toBe(1);
  });

  it('a push the provider rejects as invalid fails, with no retry', async () => {
    const before = stub.pushes.length;
    stub.pushBehaviours = ['reject_400'];
    const response = await collect();
    await h.settle();
    expect(await statusOf(h, admin, response.body.id as string)).toBe('failed');
    expect(stub.pushes.length - before).toBe(1);
  });
});

describe('secrets and tokens stay out of logs', () => {
  it('never logs a callback token, the consumer secret, the passkey or the payer number', async () => {
    const { push } = await started();
    const token = callbackUrl(push).split('/').at(-1) ?? '';
    await deliver(callbackUrl(push), stub.callback(checkoutOf(push), 'success'));
    await deliver(callbackUrl(push).replace(token, 'f'.repeat(64)), '{"not":"a callback"}');
    await deliver(callbackUrl(push), 'not json at all');
    await inquire();
    const output = h.logs.join('\n');
    for (const secret of [
      token,
      stub.credentials.consumerSecret,
      stub.credentials.passkey,
      '708374149',
    ]) {
      expect(output.includes(secret), `logs must not contain ${secret.slice(0, 4)}…`).toBe(false);
    }
  });
});

describe('configuration', () => {
  const base = {
    AORA_MODE: 'sandbox',
    DATABASE_URL_APP: 'postgresql://aora_app@127.0.0.1:54329/x',
    DATABASE_URL_PLATFORM: 'postgresql://aora_platform@127.0.0.1:54329/x',
    SANDBOX_SIM_WEBHOOK_SECRET: 's'.repeat(32),
    PIN_PEPPER: 'p'.repeat(64),
    AUTH_PROVIDER: 'sandbox',
    CLERK_WEBHOOK_SIGNING_SECRET: 'whsec_x',
  };
  const daraja = {
    DARAJA_CONSUMER_KEY: 'k'.repeat(24),
    DARAJA_CONSUMER_SECRET: 's'.repeat(24),
    DARAJA_SHORTCODE: '174379',
    DARAJA_PASSKEY: 'a'.repeat(64),
    DARAJA_TEST_MSISDN: '254708374149',
    DARAJA_CALLBACK_SECRET: 'c'.repeat(64),
  };

  it('uses the simulator when Daraja is not configured, and Daraja when it fully is', () => {
    expect(loadConfig(base).daraja).toBeNull();
    expect(loadConfig({ ...base, ...daraja }).daraja?.baseUrl).toBe(
      'https://sandbox.safaricom.co.ke',
    );
  });

  it('refuses a partial Daraja configuration, naming the missing variable only', () => {
    expect(() => loadConfig({ ...base, DARAJA_CONSUMER_KEY: 'k'.repeat(24) })).toThrow(
      /DARAJA_CONSUMER_SECRET/,
    );
  });

  it('refuses any Daraja address other than the sandbox (or this machine, for tests)', () => {
    expect(() =>
      loadConfig({ ...base, ...daraja, DARAJA_BASE_URL: 'https://api.safaricom.co.ke' }),
    ).toThrow(/sandbox/);
  });
});
