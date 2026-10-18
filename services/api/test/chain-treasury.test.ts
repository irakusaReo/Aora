import { randomUUID } from 'node:crypto';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE_SEPOLIA } from '../src/modules/chain/config.js';
import { type Anvil, startBaseSepoliaStandIn, TEST_KEYS, TOKEN_ABI } from './support/anvil.js';
import { type Harness, startHarness } from './support/harness.js';
import { balanceOf, trialBalance } from './support/money.js';

const USDC = BASE_SEPOLIA.usdc.address;
const WALLET = privateKeyToAccount(TEST_KEYS[0]).address;
const ONE = 1_000_000n;

let anvil: Anvil;
let h: Harness;
let tokens: Record<'adminA' | 'financeA' | 'cashierA' | 'adminB' | 'operator', string>;

const as = (who: keyof typeof tokens, workspace?: string) => {
  const ws = workspace ?? (who === 'adminB' ? h.seed.tenantB : h.seed.tenantA);
  return {
    get: (path: string) =>
      h.http().get(path).set('Authorization', `Bearer ${tokens[who]}`).set('Aora-Workspace-Id', ws),
    post: (path: string, key?: string) => {
      const req = h
        .http()
        .post(path)
        .set('Authorization', `Bearer ${tokens[who]}`)
        .set('Aora-Workspace-Id', ws);
      return key ? req.set('Idempotency-Key', key) : req;
    },
  };
};

const cron = () =>
  h
    .http()
    .get('/v1/internal/cron/chain')
    .set('Authorization', `Bearer ${h.config.cronSecret ?? ''}`);

/** Registers an external address for a workspace by signing the challenge with its key. */
async function register(
  key: Hex,
  who: 'adminA' | 'adminB' = 'adminA',
): Promise<{ status: number; body: Record<string, unknown> }> {
  const account = privateKeyToAccount(key);
  const challenge = await as(who).post('/v1/treasury/address-challenges').send({});
  expect(challenge.status).toBe(201);
  const signature = await account.signMessage({ message: challenge.body.message as string });
  const res = await as(who)
    .post('/v1/treasury/addresses')
    .send({ challenge_id: challenge.body.id, address: account.address, signature, label: 'test' });
  return { status: res.status, body: res.body as Record<string, unknown> };
}

async function deposit(fromKey: Hex, amount: bigint): Promise<Hex> {
  return anvil.transfer(USDC, fromKey, WALLET, amount);
}

/** Mines past the confirmation policy and runs the chain job. */
async function settleChain(blocks = 61): Promise<void> {
  await anvil.mine(blocks);
  const res = await cron();
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  anvil = await startBaseSepoliaStandIn();
  await anvil.fundEth(WALLET, 10n ** 20n);
  for (const key of TEST_KEYS.slice(1)) {
    await anvil.mint(USDC, privateKeyToAccount(key).address, 1_000n * ONE);
  }
  h = await startHarness({
    config: (config) => ({
      ...config,
      chain: {
        rpcUrl: anvil.rpcUrl,
        signerPrivateKey: TEST_KEYS[0],
        scanBlockRange: 500,
        requestTimeoutMs: 5_000,
        unknownAfterSeconds: 3_600,
      },
    }),
  });
  tokens = {
    adminA: await h.signIn('adminA'),
    financeA: await h.signIn('financeA'),
    cashierA: await h.signIn('cashierA'),
    adminB: await h.signIn('adminB'),
    operator: await h.signIn('operator'),
  };
  await h.stepUp(tokens.adminA);
  await h.stepUp(tokens.financeA);
  await h.stepUp(tokens.adminB);
});

afterAll(async () => {
  await h.close();
  await anvil.stop();
});

describe('treasury view', () => {
  it('shows the sandbox wallet, Base Sepolia and USDC balances kept apart from KES', async () => {
    const res = await as('financeA').get('/v1/treasury');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      network: { name: 'base-sepolia', chain_id: 84532 },
      deposit_address: WALLET,
      wallet_label: 'AORA sandbox testnet wallet',
      asset: { code: 'USDC', decimals: 6, contract: USDC },
      balances: { available_minor: '0', withdrawals_in_flight_minor: '0' },
      mode: 'sandbox',
    });
  });

  it('is not available to a cashier', async () => {
    expect((await as('cashierA').get('/v1/treasury')).status).toBe(403);
  });
});

describe('registering a deposit address (P5-5)', () => {
  it('registers an address proved by its signature', async () => {
    const result = await register(TEST_KEYS[2]);
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({
      address: privateKeyToAccount(TEST_KEYS[2]).address,
      status: 'active',
    });
    const list = await as('financeA').get('/v1/treasury/addresses');
    expect(list.body.data).toHaveLength(1);
  });

  it('refuses a signature from another key, a reused challenge and an expired one', async () => {
    const challenge = await as('adminA').post('/v1/treasury/address-challenges').send({});
    const claimed = privateKeyToAccount(generatePrivateKey()).address;
    const wrong = await privateKeyToAccount(generatePrivateKey()).signMessage({
      message: challenge.body.message as string,
    });
    const refused = await as('adminA')
      .post('/v1/treasury/addresses')
      .send({ challenge_id: challenge.body.id, address: claimed, signature: wrong });
    expect(refused.status).toBe(401);
    expect(refused.body.error.code).toBe('invalid_signature');

    const key = generatePrivateKey();
    const fresh = await as('adminA').post('/v1/treasury/address-challenges').send({});
    const signature = await privateKeyToAccount(key).signMessage({
      message: fresh.body.message as string,
    });
    const body = {
      challenge_id: fresh.body.id,
      address: privateKeyToAccount(key).address,
      signature,
    };
    expect((await as('adminA').post('/v1/treasury/addresses').send(body)).status).toBe(201);
    const reused = await as('adminA').post('/v1/treasury/addresses').send(body);
    expect(reused.status).toBe(409);

    const late = await as('adminA').post('/v1/treasury/address-challenges').send({});
    await h.owner((c) =>
      c.query(
        `update chain.address_challenge set expires_at = now() - interval '1 minute' where id = $1`,
        [late.body.id],
      ),
    );
    const lateKey = generatePrivateKey();
    const expired = await as('adminA')
      .post('/v1/treasury/addresses')
      .send({
        challenge_id: late.body.id,
        address: privateKeyToAccount(lateKey).address,
        signature: await privateKeyToAccount(lateKey).signMessage({
          message: late.body.message as string,
        }),
      });
    expect(expired.status).toBe(409);
  });

  it('never lets one address credit two workspaces', async () => {
    const result = await register(TEST_KEYS[2], 'adminB');
    expect(result.status).toBe(409);
  });

  it('is for admins with a step-up only', async () => {
    expect((await as('financeA').post('/v1/treasury/address-challenges').send({})).status).toBe(
      403,
    );
    expect((await as('cashierA').post('/v1/treasury/address-challenges').send({})).status).toBe(
      403,
    );
  });

  it('puts no workspace identifier in the signed message', async () => {
    const challenge = await as('adminA').post('/v1/treasury/address-challenges').send({});
    const message = challenge.body.message as string;
    expect(message).toContain('SANDBOX');
    expect(message).toContain('Base Sepolia');
    expect(message).not.toContain(h.seed.tenantA);
  });
});

describe('crediting deposits', () => {
  it('credits a confirmed deposit from a registered address, once', async () => {
    const hash = await deposit(TEST_KEYS[2], 25n * ONE);
    await settleChain();
    await settleChain(1);
    const res = await as('financeA').get('/v1/treasury');
    expect(res.body.balances.available_minor).toBe('25000000');
    expect(await balanceOf(h, h.seed.tenantA, 'merchant_usdc_available')).toBe(25n * ONE);
    expect(await balanceOf(h, null, 'chain_wallet_usdc')).toBe(25n * ONE);
    expect(await trialBalance(h)).toBe(0n);
    const transfers = await as('financeA').get('/v1/treasury/transfers');
    expect(transfers.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          direction: 'in',
          tx_hash: hash.toLowerCase(),
          amount_minor: '25000000',
          status: 'credited',
        }),
      ]),
    );
  });

  it('never credits a deposit from an unregistered address, and opens an exception', async () => {
    const stranger = TEST_KEYS[1];
    const hash = await deposit(stranger, 3n * ONE);
    await settleChain();
    const row = await h.owner((c) =>
      c.query<{ status: string }>(`select status from chain.observed_transfer where tx_hash = $1`, [
        hash.toLowerCase(),
      ]),
    );
    expect(row.rows[0]?.status).toBe('unattributed');
    const exceptions = await h.owner((c) =>
      c.query<{ type: string }>(
        `select type from payments.reconciliation_exception where subject_ref like $1`,
        [`${hash.toLowerCase()}%`],
      ),
    );
    expect(exceptions.rows.map((e) => e.type)).toEqual(['unattributed_deposit']);
    expect(await balanceOf(h, h.seed.tenantA, 'merchant_usdc_available')).toBe(25n * ONE);
  });

  it('does not credit a deposit observed before its sender was registered', async () => {
    const key = TEST_KEYS[3];
    const hash = await deposit(key, 2n * ONE);
    await anvil.mine(1);
    await cron();
    expect((await register(key)).status).toBe(201);
    await settleChain();
    const row = await h.owner((c) =>
      c.query<{ status: string }>(`select status from chain.observed_transfer where tx_hash = $1`, [
        hash.toLowerCase(),
      ]),
    );
    expect(row.rows[0]?.status).toBe('unattributed');
  });
});

describe('withdrawals need two people (P5-9)', () => {
  const destination = privateKeyToAccount(generatePrivateKey()).address;
  const onChain = () =>
    anvil.client.readContract({
      address: USDC,
      abi: TOKEN_ABI,
      functionName: 'balanceOf',
      args: [destination],
    });

  it('reserves funds on request, and the requester cannot approve', async () => {
    const created = await as('financeA', h.seed.tenantA)
      .post('/v1/treasury/withdrawals', randomUUID())
      .send({ amount_minor: '4000000', destination });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('requested');
    expect(await balanceOf(h, h.seed.tenantA, 'merchant_usdc_available')).toBe(21n * ONE);
    expect(await balanceOf(h, h.seed.tenantA, 'merchant_usdc_withdrawals_in_flight')).toBe(
      4n * ONE,
    );

    const self = await as('financeA')
      .post(`/v1/treasury/withdrawals/${created.body.id as string}/approval`)
      .send({});
    expect(self.status).toBe(403);
  });

  it('sends after a second admin approves, and completes after confirmation', async () => {
    const created = await as('financeA')
      .post('/v1/treasury/withdrawals', randomUUID())
      .send({ amount_minor: '6000000', destination });
    const approved = await as('adminA')
      .post(`/v1/treasury/withdrawals/${created.body.id as string}/approval`)
      .send({});
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('submitted');
    expect(approved.body.tx_hash).toMatch(/^0x[0-9a-f]{64}$/);

    await settleChain();
    const done = await as('financeA').get('/v1/treasury/withdrawals');
    const record = (done.body.data as { id: string; status: string }[]).find(
      (w) => w.id === created.body.id,
    );
    expect(record?.status).toBe('completed');
    expect(await onChain()).toBe(6n * ONE);
    expect(await balanceOf(h, null, 'chain_wallet_usdc')).toBe(19n * ONE);
    expect(await trialBalance(h)).toBe(0n);
  });

  it('releases the reserve when a withdrawal is rejected', async () => {
    const before = await balanceOf(h, h.seed.tenantA, 'merchant_usdc_available');
    const created = await as('financeA')
      .post('/v1/treasury/withdrawals', randomUUID())
      .send({ amount_minor: '1000000', destination });
    const rejected = await as('adminA')
      .post(`/v1/treasury/withdrawals/${created.body.id as string}/rejection`)
      .send({ reason: 'not expected' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe('rejected');
    expect(await balanceOf(h, h.seed.tenantA, 'merchant_usdc_available')).toBe(before);
  });

  it('refuses more than is available, more than the tier allows, and bad destinations', async () => {
    const tooMuch = await as('financeA')
      .post('/v1/treasury/withdrawals', randomUUID())
      .send({ amount_minor: '999000000', destination });
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.error.code).toBe('insufficient_funds');

    const zero = await as('financeA')
      .post('/v1/treasury/withdrawals', randomUUID())
      .send({ amount_minor: '1000000', destination: '0x0000000000000000000000000000000000000000' });
    expect(zero.body.error.code).toBe('invalid_destination');

    const contract = await as('financeA')
      .post('/v1/treasury/withdrawals', randomUUID())
      .send({ amount_minor: '1000000', destination: USDC });
    expect(contract.body.error.code).toBe('invalid_destination');

    expect(
      (
        await as('financeA')
          .post('/v1/treasury/withdrawals', randomUUID())
          .send({ amount_minor: '1.5', destination })
      ).status,
    ).toBe(400);
  });

  it('is idempotent per key', async () => {
    const key = randomUUID();
    const first = await as('financeA')
      .post('/v1/treasury/withdrawals', key)
      .send({ amount_minor: '1000000', destination });
    const again = await as('financeA')
      .post('/v1/treasury/withdrawals', key)
      .send({ amount_minor: '1000000', destination });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
  });

  it('is not open to a cashier, and needs a step-up', async () => {
    expect(
      (
        await as('cashierA')
          .post('/v1/treasury/withdrawals', randomUUID())
          .send({ amount_minor: '1000000', destination })
      ).status,
    ).toBe(403);
    const fresh = await h.signIn('financeA', { sessionId: 'no-step-up' });
    const res = await h
      .http()
      .post('/v1/treasury/withdrawals')
      .set('Authorization', `Bearer ${fresh}`)
      .set('Aora-Workspace-Id', h.seed.tenantA)
      .set('Idempotency-Key', randomUUID())
      .send({ amount_minor: '1000000', destination });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('step_up_required');
  });
});

describe('tenant isolation of treasury data', () => {
  it('shows another workspace nothing of tenant A', async () => {
    const view = await as('adminB').get('/v1/treasury');
    expect(view.body.balances.available_minor).toBe('0');
    expect((await as('adminB').get('/v1/treasury/addresses')).body.data).toEqual([]);
    expect((await as('adminB').get('/v1/treasury/withdrawals')).body.data).toEqual([]);
    expect((await as('adminB').get('/v1/treasury/transfers')).body.data).toEqual([]);
  });

  it('cannot approve another workspace’s withdrawal', async () => {
    const created = await as('financeA')
      .post('/v1/treasury/withdrawals', randomUUID())
      .send({
        amount_minor: '1000000',
        destination: privateKeyToAccount(generatePrivateKey()).address,
      });
    const res = await as('adminB')
      .post(`/v1/treasury/withdrawals/${created.body.id as string}/approval`)
      .send({});
    expect(res.status).toBe(404);
  });

  it('forces row-level security on the new treasury tables', async () => {
    const rows = await h.owner((c) =>
      c.query<{ relname: string }>(
        `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'chain' and c.relkind = 'r' and c.relforcerowsecurity
         and c.relname in ('registered_address', 'address_challenge', 'withdrawal')`,
      ),
    );
    expect(rows.rows.map((r) => r.relname).sort()).toEqual([
      'address_challenge',
      'registered_address',
      'withdrawal',
    ]);
  });
});
