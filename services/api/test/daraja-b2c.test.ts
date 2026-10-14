import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DarajaStub, startDarajaStub } from './support/daraja-stub.js';
import { type Harness, startHarness } from './support/harness.js';
import { balanceOf, trialBalance } from './support/money.js';
import { type Caller, createIntent } from './support/payments.js';

let h: Harness;
let stub: DarajaStub;
let admin: Caller;
let recipient: string;
const TEST_NUMBER = '+254708374149';

const call = (method: 'get' | 'post', path: string) =>
  h
    .http()
    [method](path)
    .set('Authorization', `Bearer ${admin.token}`)
    .set('Aora-Workspace-Id', admin.workspace);

async function pay(amount: string) {
  const quote = await call('post', '/v1/payouts/preview').send({
    recipient_id: recipient,
    amount_minor: amount,
    currency: 'KES',
  });
  const response = await call('post', '/v1/payouts').set('Idempotency-Key', randomUUID()).send({
    recipient_id: recipient,
    amount_minor: amount,
    currency: 'KES',
    expected_fee_minor: quote.body.fee_minor,
    tariff_version_id: quote.body.tariff_version_id,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  await h.settle();
  return { id: response.body.id as string, request: stub.b2cRequests.at(-1) ?? {} };
}

const statusOf = async (id: string): Promise<string> =>
  (await call('get', `/v1/payouts/${id}`)).body.status as string;
const resultPath = (request: Record<string, unknown>, field = 'ResultURL'): string =>
  new URL(String(request[field])).pathname;
const deliver = (path: string, body: string) =>
  h.http().post(path).set('Content-Type', 'application/json').send(body);

beforeAll(async () => {
  stub = await startDarajaStub();
  h = await startHarness({
    config: (config) => ({
      ...config,
      payments: { ...config.payments, maxStatusInquiries: 2 },
      daraja: {
        baseUrl: stub.baseUrl,
        consumerKey: stub.credentials.consumerKey,
        consumerSecret: stub.credentials.consumerSecret,
        shortcode: stub.credentials.shortcode,
        passkey: stub.credentials.passkey,
        testMsisdn: stub.credentials.testMsisdn,
        callbackSecret: 'c'.repeat(64),
        requestTimeoutMs: 1_000,
        b2c: { shortcode: '600986', initiatorName: 'testapi', initiatorPassword: 'Sandbox#Pass1' },
      },
    }),
  });
  admin = { token: await h.signIn('adminA'), workspace: h.seed.tenantA };
  await h.stepUp(admin.token);
  for (let i = 0; i < 2; i += 1) {
    await createIntent(h, admin, {
      amount_minor: '5000000',
      currency: 'KES',
      sandbox_scenario: 'success',
    });
  }
  await h.settle();
  await h
    .http()
    .get('/v1/internal/cron/settlement')
    .set('Authorization', `Bearer ${h.config.cronSecret ?? ''}`);
  const created = await call('post', '/v1/payout-recipients').send({
    phone: TEST_NUMBER,
    label: 'Daraja test number',
  });
  recipient = created.body.id as string;
  await call('post', `/v1/payout-recipients/${recipient}/confirmation`).send({
    phone: TEST_NUMBER,
  });
  await h.owner((client) =>
    client.query(`update payments.payout_recipient set confirmed_at = now() - interval '1 day'`),
  );
});
afterAll(async () => {
  await h.close();
  await stub.close();
});

describe('payouts through Daraja B2C (sandbox)', () => {
  it('refuses a recipient other than the Daraja test number in the sandbox', async () => {
    const other = await call('post', '/v1/payout-recipients').send({
      phone: '+254711111111',
      label: 'Someone',
    });
    expect(other.status).toBe(400);
  });

  it('builds the B2C request as documented, with an encrypted credential and token result URLs', async () => {
    const { id, request } = await pay('100000');
    expect(request).toMatchObject({
      OriginatorConversationID: id,
      InitiatorName: 'testapi',
      CommandID: 'BusinessPayment',
      Amount: '1000',
      PartyA: '600986',
      PartyB: '254708374149',
    });
    // RSA-encrypted with the sandbox certificate: never the password itself.
    expect(String(request['SecurityCredential'])).not.toContain('Sandbox#Pass1');
    expect(String(request['SecurityCredential']).length).toBeGreaterThan(300);
    expect(resultPath(request)).toMatch(new RegExp(`^/v1/webhooks/daraja/b2c/${id}/[0-9a-f]{64}$`));
    expect(await statusOf(id)).toBe('pending_provider');
  });

  it('settles on a matching result and records the receipt; a repeat changes nothing', async () => {
    const inFlightBefore = await balanceOf(h, h.seed.tenantA, 'merchant_payouts_in_flight');
    const { id, request } = await pay('100000');
    const body = stub.b2cResult(id, 'success', '1000');
    for (let i = 0; i < 2; i += 1)
      expect((await deliver(resultPath(request), body)).status).toBe(200);
    await h.settle();
    expect(await statusOf(id)).toBe('succeeded');
    expect(await balanceOf(h, h.seed.tenantA, 'merchant_payouts_in_flight')).toBe(inFlightBefore);
    expect(await trialBalance(h)).toBe(0n);
  });

  it('fails cleanly and gives the money back on a failed result', async () => {
    const before = await balanceOf(h, h.seed.tenantA, 'merchant_available');
    const { id, request } = await pay('100000');
    await deliver(resultPath(request), stub.b2cResult(id, 'failed'));
    await h.settle();
    expect(await statusOf(id)).toBe('failed');
    expect(await balanceOf(h, h.seed.tenantA, 'merchant_available')).toBe(before);
  });

  it('sends a result with a different amount to an operator', async () => {
    const { id, request } = await pay('100000');
    await deliver(resultPath(request), stub.b2cResult(id, 'success', '999'));
    await h.settle();
    expect(await statusOf(id)).toBe('reconciliation_required');
  });

  it('refuses a result without the right token', async () => {
    const { id } = await pay('100000');
    const forged = `/v1/webhooks/daraja/b2c/${id}/${'0'.repeat(64)}`;
    expect((await deliver(forged, stub.b2cResult(id, 'success', '1000'))).status).toBe(401);
    expect(await statusOf(id)).toBe('pending_provider');
  });

  it('asks Transaction Status when no result arrives, and applies its answer', async () => {
    const { id } = await pay('100000');
    await h.makeDelayedEventsDue();
    await h.settle();
    const query = stub.statusRequests.at(-1) ?? {};
    expect(query).toMatchObject({
      CommandID: 'TransactionStatusQuery',
      OriginalConversationID: id,
      IdentifierType: '4',
    });
    await deliver(resultPath(query), stub.statusResult(id, 'Completed', '1000'));
    await h.settle();
    expect(await statusOf(id)).toBe('succeeded');
  });

  it('never sends a payout twice when its outcome is unknown', async () => {
    const before = stub.b2cRequests.length;
    stub.b2cBehaviours = ['timeout'];
    const quote = await call('post', '/v1/payouts/preview').send({
      recipient_id: recipient,
      amount_minor: '100000',
      currency: 'KES',
    });
    const response = await call('post', '/v1/payouts').set('Idempotency-Key', randomUUID()).send({
      recipient_id: recipient,
      amount_minor: '100000',
      currency: 'KES',
      expected_fee_minor: quote.body.fee_minor,
      tariff_version_id: quote.body.tariff_version_id,
    });
    await h.settle();
    const id = response.body.id as string;
    expect(await statusOf(id)).toBe('status_unknown');
    for (let round = 0; round < 3; round += 1) {
      await h.makeDelayedEventsDue();
      await h.settle();
    }
    expect(stub.b2cRequests.length - before).toBe(1);
    expect(await statusOf(id)).toBe('reconciliation_required');
  });

  it('keeps the initiator password and callback tokens out of the logs', () => {
    const output = h.logs.join('\n');
    expect(output).not.toContain('Sandbox#Pass1');
    expect(output).not.toMatch(/\/v1\/webhooks\/daraja\/b2c\/[0-9a-f-]{36}\/[0-9a-f]{64}/);
  });
});
