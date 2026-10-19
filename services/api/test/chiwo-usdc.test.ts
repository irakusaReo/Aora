import { randomUUID } from 'node:crypto';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PAYMENT_REQUEST_TRANSITIONS } from '../src/modules/chiwo/requests.service.js';
import { BASE_SEPOLIA } from '../src/modules/chain/config.js';
import { type Anvil, startBaseSepoliaStandIn, TEST_KEYS, TOKEN_ABI } from './support/anvil.js';
import { type Harness, startHarness } from './support/harness.js';
import { trialBalance } from './support/money.js';
import { newUser } from './support/users.js';

/**
 * Journey J12, second part (phase 7B): personal USDC on Base Sepolia. Receive
 * from a registered address, send to another CHIWO consumer, withdraw on chain
 * to one's own address, and payment requests that cannot be paid twice.
 * Written before the code.
 */

const USDC = BASE_SEPOLIA.usdc.address;
const WALLET = privateKeyToAccount(TEST_KEYS[0]).address;
const ONE = 1_000_000n;

let anvil: Anvil;
let h: Harness;

interface Person {
  token: string;
  accountId: string;
  phone: string;
}
let ama: Person;
let baraka: Person;
let chebet: Person;
let amaKey: Hex;
let phoneCounter = 0;

const call = (who: Person, method: 'get' | 'post', path: string, body: object = {}) => {
  const r = h.http()[method](path).set('Authorization', `Bearer ${who.token}`);
  return method === 'post' ? r.send(body) : r;
};
const keyed = (who: Person, path: string, body: object, key = randomUUID()) =>
  call(who, 'post', path, body).set('Idempotency-Key', key);
const cron = () =>
  h
    .http()
    .get('/v1/internal/cron/chain')
    .set('Authorization', `Bearer ${h.config.cronSecret ?? ''}`);

async function person(name: string): Promise<Person> {
  const user = await newUser(h, name, { phone: false });
  phoneCounter += 1;
  const phone = `+999777${String(phoneCounter).padStart(5, '0')}`;
  expect(
    (
      await h
        .http()
        .put('/v1/me/phone')
        .set('Authorization', `Bearer ${user.token}`)
        .send({ phone })
    ).status,
  ).toBe(200);
  const terms = await h.http().get('/v1/terms/chiwo_terms');
  const who = { token: user.token, accountId: user.accountId, phone };
  expect(
    (await call(who, 'post', '/v1/chiwo/sign-up', { terms_version: terms.body.version as string }))
      .status,
  ).toBe(201);
  await h.stepUp(user.token);
  return who;
}

async function registerAddress(who: Person, key: Hex): Promise<string> {
  const challenge = await call(who, 'post', '/v1/chiwo/usdc/address-challenges');
  expect(challenge.status).toBe(201);
  const account = privateKeyToAccount(key);
  const signature = await account.signMessage({ message: challenge.body.message as string });
  const res = await call(who, 'post', '/v1/chiwo/usdc/addresses', {
    challenge_id: challenge.body.id,
    address: account.address,
    signature,
  });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function settleChain(blocks = 61): Promise<void> {
  await anvil.mine(blocks);
  expect((await cron()).status).toBe(200);
}

async function balance(who: Person): Promise<bigint> {
  const res = await call(who, 'get', '/v1/chiwo/usdc');
  return BigInt(res.body.balances.available_minor as string);
}

async function confirmedRecipient(from: Person, to: Person): Promise<string> {
  const added = await call(from, 'post', '/v1/chiwo/recipients', { phone: to.phone });
  expect([200, 201]).toContain(added.status);
  const confirmed = await call(
    from,
    'post',
    `/v1/chiwo/recipients/${added.body.id as string}/confirm`,
  );
  expect(confirmed.status).toBe(200);
  return added.body.id as string;
}

beforeAll(async () => {
  anvil = await startBaseSepoliaStandIn();
  await anvil.fundEth(WALLET, 10n ** 20n);
  amaKey = TEST_KEYS[1];
  await anvil.mint(USDC, privateKeyToAccount(amaKey).address, 1_000n * ONE);
  h = await startHarness({
    config: (config) => ({
      ...config,
      chain: {
        rpcUrl: anvil.rpcUrl,
        signerPrivateKey: TEST_KEYS[0],
        scanBlockRange: 500,
        scanStartBlock: null,
        requestTimeoutMs: 5_000,
        unknownAfterSeconds: 3_600,
      },
    }),
  });
  ama = await person('Ama');
  baraka = await person('Baraka');
  chebet = await person('Chebet');
});

afterAll(async () => {
  await h.close();
  await anvil.stop();
});

describe('payment request state machine', () => {
  it('ends in paid, cancelled or expired, with no way out', () => {
    expect(PAYMENT_REQUEST_TRANSITIONS).toEqual({
      open: ['paid', 'cancelled', 'expired'],
      paid: [],
      cancelled: [],
      expired: [],
    });
  });
});

describe('personal USDC: receiving on chain', () => {
  it('shows the sandbox wallet and personal balances, apart from any workspace', async () => {
    const res = await call(ama, 'get', '/v1/chiwo/usdc');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      network: { name: 'base-sepolia', chain_id: 84532 },
      deposit_address: WALLET,
      asset: { code: 'USDC', decimals: 6, contract: USDC },
      balances: { available_minor: '0', withdrawals_in_flight_minor: '0' },
      addresses: [],
      mode: 'sandbox',
    });
  });

  it('credits a confirmed deposit from the consumer’s registered address, to that consumer only', async () => {
    await registerAddress(ama, amaKey);
    await anvil.transfer(USDC, amaKey, WALLET, 300n * ONE);
    await settleChain(10);
    expect(await balance(ama)).toBe(0n); // not yet past the confirmation policy
    await settleChain();
    expect(await balance(ama)).toBe(300n * ONE);
    expect(await balance(baraka)).toBe(0n);
    expect(await trialBalance(h)).toBe(0n);
    const activity = await call(ama, 'get', '/v1/chiwo/activity');
    expect((activity.body.data as { kind: string }[]).map((a) => a.kind)).toContain('deposit');
  });
});

describe('sending to another CHIWO consumer (O-11 c)', () => {
  it('finds a recipient by phone and shows only a masked name', async () => {
    const res = await call(ama, 'post', '/v1/chiwo/recipients', { phone: baraka.phone });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ confirmed: false });
    expect(res.body.display_name).not.toBe('Baraka');
    expect(res.body.display_name).toMatch(/^B/);
    expect(JSON.stringify(res.body)).not.toContain(baraka.accountId);
    expect(JSON.stringify(res.body)).not.toContain(baraka.phone);
    expect(
      (await call(ama, 'post', '/v1/chiwo/recipients', { phone: '+999000999999' })).status,
    ).toBe(404);
    expect((await call(ama, 'post', '/v1/chiwo/recipients', { phone: ama.phone })).status).toBe(
      400,
    );
  });

  it('refuses a transfer to a recipient not yet confirmed', async () => {
    const added = await call(ama, 'post', '/v1/chiwo/recipients', { phone: chebet.phone });
    const r = await keyed(ama, '/v1/chiwo/transfers', {
      recipient_id: added.body.id,
      amount_minor: ONE.toString(),
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('recipient_not_confirmed');
  });

  it('moves the exact amount between the two consumers, once', async () => {
    const recipient = await confirmedRecipient(ama, baraka);
    const before = { ama: await balance(ama), baraka: await balance(baraka) };
    const key = randomUUID();
    const body = { recipient_id: recipient, amount_minor: (25n * ONE).toString() };
    const first = await keyed(ama, '/v1/chiwo/transfers', body, key);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      status: 'posted',
      direction: 'out',
      amount_minor: '25000000',
    });
    const again = await keyed(ama, '/v1/chiwo/transfers', body, key);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    const reused = await keyed(ama, '/v1/chiwo/transfers', { ...body, amount_minor: '1' }, key);
    expect(reused.status).toBe(409);
    expect(await balance(ama)).toBe(before.ama - 25n * ONE);
    expect(await balance(baraka)).toBe(before.baraka + 25n * ONE);
    expect(await trialBalance(h)).toBe(0n);

    await h.settle();
    const mail = await h.owner(
      async (client) =>
        (
          await client.query<{ type: string }>(
            `select type from notifications.notification where account_id = $1 and dedupe_key like $2`,
            [baraka.accountId, `%${first.body.id as string}%`],
          )
        ).rows,
    );
    expect(mail).toEqual([{ type: 'chiwo.usdc.received' }]);

    const receipt = await call(
      baraka,
      'get',
      `/v1/chiwo/receipts/transfer/${first.body.id as string}`,
    );
    expect(receipt.status).toBe(200);
    expect(receipt.body).toMatchObject({
      kind: 'transfer',
      direction: 'in',
      amount_minor: '25000000',
    });
    expect(
      (await call(chebet, 'get', `/v1/chiwo/receipts/transfer/${first.body.id as string}`)).status,
    ).toBe(404);
  });

  it('needs a step-up, enough funds and a transfer within the limit', async () => {
    const recipient = await confirmedRecipient(baraka, chebet);
    const poor = await keyed(baraka, '/v1/chiwo/transfers', {
      recipient_id: recipient,
      amount_minor: (999n * ONE).toString(),
    });
    expect(poor.status).toBe(422);
    expect(poor.body.error.code).toBe('insufficient_funds');
    const huge = await keyed(baraka, '/v1/chiwo/transfers', {
      recipient_id: recipient,
      amount_minor: (100_000n * ONE).toString(),
    });
    expect(huge.status).toBe(422);
    expect(huge.body.error.code).toBe('limit_exceeded');

    const fresh = await person('Dalia');
    const added = await call(fresh, 'post', '/v1/chiwo/recipients', { phone: ama.phone });
    // A new sign-in without a step-up cannot confirm a recipient.
    const lapsed = h.sandboxAuth.issue(
      (await h.owner(
        async (c) =>
          (
            await c.query<{ clerk_user_id: string }>(
              'select clerk_user_id from identity.user_account where id = $1',
              [fresh.accountId],
            )
          ).rows[0]?.clerk_user_id,
      )) ?? '',
    );
    const refused = await h
      .http()
      .post(`/v1/chiwo/recipients/${added.body.id as string}/confirm`)
      .set('Authorization', `Bearer ${lapsed}`);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('step_up_required');
  });
});

describe('payment requests (P7-12)', () => {
  it('a named payer pays once; a second payment is refused', async () => {
    const created = await call(baraka, 'post', '/v1/chiwo/requests', {
      amount_minor: (5n * ONE).toString(),
      note: 'Lunch',
      payer_phone: ama.phone,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'open', role: 'requester' });
    const received = await call(ama, 'get', '/v1/chiwo/requests');
    expect(
      (received.body.data as { id: string; role: string }[]).find((r) => r.id === created.body.id),
    ).toMatchObject({ role: 'payer' });
    expect(
      (await call(chebet, 'get', `/v1/chiwo/requests/${created.body.id as string}`)).status,
    ).toBe(404);

    const before = await balance(baraka);
    const paid = await keyed(ama, `/v1/chiwo/requests/${created.body.id as string}/pay`, {});
    expect(paid.status).toBe(200);
    expect(paid.body.status).toBe('paid');
    expect(await balance(baraka)).toBe(before + 5n * ONE);
    const twice = await keyed(ama, `/v1/chiwo/requests/${created.body.id as string}/pay`, {});
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('invalid_state_transition');
    expect(await balance(baraka)).toBe(before + 5n * ONE);
  });

  it('makes exactly one transfer when paid concurrently with different keys', async () => {
    const created = await call(baraka, 'post', '/v1/chiwo/requests', {
      amount_minor: (2n * ONE).toString(),
    });
    expect(created.body.payer).toBeNull();
    const results = await Promise.all(
      [1, 2, 3, 4].map(() => keyed(ama, `/v1/chiwo/requests/${created.body.id as string}/pay`, {})),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const [count] = await h.owner(
      async (client) =>
        (
          await client.query<{ n: string }>(
            'select count(*)::text as n from chiwo.transfer where request_id = $1',
            [created.body.id],
          )
        ).rows,
    );
    expect(count?.n).toBe('1');
    expect(await trialBalance(h)).toBe(0n);
  });

  it('cannot be paid once cancelled or expired, or by its own requester', async () => {
    const cancelled = await call(baraka, 'post', '/v1/chiwo/requests', { amount_minor: '1000' });
    expect(
      (await call(ama, 'post', `/v1/chiwo/requests/${cancelled.body.id as string}/cancel`)).status,
    ).toBe(404);
    expect(
      (await call(baraka, 'post', `/v1/chiwo/requests/${cancelled.body.id as string}/cancel`))
        .status,
    ).toBe(200);
    expect(
      (await keyed(ama, `/v1/chiwo/requests/${cancelled.body.id as string}/pay`, {})).status,
    ).toBe(409);

    const own = await call(baraka, 'post', '/v1/chiwo/requests', { amount_minor: '1000' });
    expect(
      (await keyed(baraka, `/v1/chiwo/requests/${own.body.id as string}/pay`, {})).status,
    ).toBe(400);

    const old = await call(baraka, 'post', '/v1/chiwo/requests', { amount_minor: '1000' });
    await h.owner(async (client) => {
      await client.query('begin');
      await client.query('set local session_replication_role = replica');
      await client.query(
        `update chiwo.payment_request set expires_at = now() - interval '1 minute' where id = $1`,
        [old.body.id],
      );
      await client.query('commit');
    });
    const late = await keyed(ama, `/v1/chiwo/requests/${old.body.id as string}/pay`, {});
    expect(late.status).toBe(409);
    expect(
      (await call(baraka, 'get', `/v1/chiwo/requests/${old.body.id as string}`)).body.status,
    ).toBe('expired');
  });
});

describe('withdrawing on chain to one’s own address (P7-11)', () => {
  it('refuses an address the consumer did not register', async () => {
    const r = await keyed(ama, '/v1/chiwo/usdc/withdrawals', {
      amount_minor: ONE.toString(),
      address_id: randomUUID(),
    });
    expect(r.status).toBe(404);
  });

  it('reserves, sends once and completes after confirmation', async () => {
    const view = await call(ama, 'get', '/v1/chiwo/usdc');
    const addressId = (view.body.addresses as { id: string }[])[0]?.id ?? '';
    const before = await balance(ama);
    const target = privateKeyToAccount(amaKey).address;
    const onChainBefore = await anvil.client.readContract({
      address: USDC,
      abi: TOKEN_ABI,
      functionName: 'balanceOf',
      args: [target],
    });
    const r = await keyed(ama, '/v1/chiwo/usdc/withdrawals', {
      amount_minor: (10n * ONE).toString(),
      address_id: addressId,
    });
    expect(r.status).toBe(201);
    expect(['submitted', 'completed']).toContain(r.body.status);
    expect(r.body.tx_hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await balance(ama)).toBe(before - 10n * ONE);
    await settleChain();
    const done = await call(ama, 'get', `/v1/chiwo/receipts/withdrawal/${r.body.id as string}`);
    expect(done.body.status).toBe('completed');
    const onChainAfter = await anvil.client.readContract({
      address: USDC,
      abi: TOKEN_ABI,
      functionName: 'balanceOf',
      args: [target],
    });
    expect(onChainAfter - onChainBefore).toBe(10n * ONE);
    const view2 = await call(ama, 'get', '/v1/chiwo/usdc');
    expect(view2.body.balances.withdrawals_in_flight_minor).toBe('0');
    expect(await trialBalance(h)).toBe(0n);
  });
});

describe('consumer isolation', () => {
  it('hides transfers, requests and balances from other consumers and from workspaces', async () => {
    const seen = await h.db.withConsumer(
      chebet.accountId,
      (tx) => tx.$queryRaw<{ id: string }[]>`select id from chiwo.transfer`,
    );
    const chebetIds = new Set(seen.map((row) => row.id));
    const amaTransfers = await h.db.withConsumer(
      ama.accountId,
      (tx) =>
        tx.$queryRaw<
          { id: string; sender_account_id: string }[]
        >`select id, sender_account_id from chiwo.transfer`,
    );
    for (const row of amaTransfers) expect(chebetIds.has(row.id)).toBe(false);
    const byTenant = await h.db.withTenant(
      h.seed.tenantA,
      (tx) => tx.$queryRaw<{ id: string }[]>`select id from chiwo.payment_request`,
    );
    expect(byTenant).toEqual([]);
  });
});
