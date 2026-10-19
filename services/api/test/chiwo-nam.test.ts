import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type Address, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { namUsdcVaultAbi } from '../src/modules/chain/abi/NamUsdcVault.js';
import { BASE_SEPOLIA } from '../src/modules/chain/config.js';
import {
  type Anvil,
  startBaseSepoliaStandIn,
  TEST_KEYS,
  testContractCode,
} from './support/anvil.js';
import { type Harness, startHarness } from './support/harness.js';
import { balanceOf, trialBalance } from './support/money.js';

/**
 * Journey J13, CHIWO side (phase 7C): the NAM Vault inside CHIWO, with a
 * personal investor profile kept apart from the same person's business
 * profile in KONY. Written before the code.
 */

const USDC = BASE_SEPOLIA.usdc.address;
const WALLET = privateKeyToAccount(TEST_KEYS[0]).address;
const PERSONAL = TEST_KEYS[3];
const BUSINESS = TEST_KEYS[2];
const ONE = 1_000_000n;

let anvil: Anvil;
let h: Harness;
let vault: Address;
let admin: string;

const personal = {
  get: (path: string) => h.http().get(path).set('Authorization', `Bearer ${admin}`),
  post: (path: string, body: object = {}) =>
    h
      .http()
      .post(path)
      .set('Authorization', `Bearer ${admin}`)
      .set('Idempotency-Key', randomUUID())
      .send(body),
};
const business = {
  get: (path: string) =>
    h
      .http()
      .get(path)
      .set('Authorization', `Bearer ${admin}`)
      .set('Aora-Workspace-Id', h.seed.tenantA),
  post: (path: string, body: object = {}) =>
    h
      .http()
      .post(path)
      .set('Authorization', `Bearer ${admin}`)
      .set('Aora-Workspace-Id', h.seed.tenantA)
      .set('Idempotency-Key', randomUUID())
      .send(body),
};
const cron = () =>
  h
    .http()
    .get('/v1/internal/cron/chain')
    .set('Authorization', `Bearer ${h.config.cronSecret ?? ''}`);
async function settle(blocks = 61): Promise<void> {
  await anvil.mine(blocks);
  expect((await cron()).status).toBe(200);
}
async function settleAll(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await settle();
}
const personalUsdc = async (): Promise<bigint> =>
  BigInt((await personal.get('/v1/chiwo/usdc')).body.balances.available_minor as string);

async function registerAndDeposit(
  who: typeof personal,
  challengePath: string,
  addressPath: string,
  key: `0x${string}`,
  amount: bigint,
): Promise<void> {
  const challenge = await who.post(challengePath);
  expect(challenge.status).toBe(201);
  const account = privateKeyToAccount(key);
  const registered = await who.post(addressPath, {
    challenge_id: challenge.body.id,
    address: account.address,
    signature: await account.signMessage({ message: challenge.body.message as string }),
  });
  expect(registered.status).toBe(201);
  await anvil.transfer(USDC, key, WALLET, amount);
}

beforeAll(async () => {
  anvil = await startBaseSepoliaStandIn();
  await anvil.fundEth(WALLET, 10n ** 20n);
  await anvil.mint(USDC, privateKeyToAccount(PERSONAL).address, 1_000n * ONE);
  await anvil.mint(USDC, privateKeyToAccount(BUSINESS).address, 1_000n * ONE);
  const deployer = createWalletClient({
    account: privateKeyToAccount(TEST_KEYS[0]),
    transport: http(anvil.rpcUrl),
  });
  const hash = await deployer.deployContract({
    abi: namUsdcVaultAbi,
    bytecode: testContractCode('NamUsdcVaultCreation'),
    args: [USDC, WALLET],
    chain: null,
  });
  await anvil.mine(1);
  vault = (await anvil.client.getTransactionReceipt({ hash })).contractAddress as Address;
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
        namVault: vault,
      },
    }),
  });
  // The same person: an admin of workspace A, and a CHIWO consumer in their own right.
  admin = await h.signIn('adminA');
  await h.stepUp(admin);
  const terms = await h.http().get('/v1/terms/chiwo_terms');
  expect(
    (await personal.post('/v1/chiwo/sign-up', { terms_version: terms.body.version as string }))
      .status,
  ).toBe(201);
  await registerAndDeposit(
    personal,
    '/v1/chiwo/usdc/address-challenges',
    '/v1/chiwo/usdc/addresses',
    PERSONAL,
    50n * ONE,
  );
  await registerAndDeposit(
    business,
    '/v1/treasury/address-challenges',
    '/v1/treasury/addresses',
    BUSINESS,
    80n * ONE,
  );
  await settle();
  expect(await personalUsdc()).toBe(50n * ONE);
  expect(await balanceOf(h, h.seed.tenantA, 'merchant_usdc_available')).toBe(80n * ONE);
});

afterAll(async () => {
  await h.close();
  await anvil.stop();
});

describe('NAM inside CHIWO', () => {
  it('shows the product, the disclosure and a personal holding, labelled sandbox', async () => {
    const res = await personal.get('/v1/chiwo/nam');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      product: { name: 'NAM USDC Vault (sandbox)', returns_claimed: false },
      disclosure: { key: 'nam_vault_disclosure_personal', version: '1' },
      holding: { shares: '0', current_value_minor: '0' },
      funding_pending_minor: '0',
      mode: 'sandbox',
    });
    const body = JSON.stringify(res.body);
    // Personal wording: nothing here speaks of a workspace.
    expect(body).not.toMatch(/workspace/i);
    expect(body).not.toMatch(/\b(apy|apr|yield|interest)\b/i);
    const page = readFileSync(
      new URL('../../../apps/chiwo-web/app/nam/page.tsx', import.meta.url),
      'utf8',
    );
    expect(page).not.toMatch(/\b(apy|apr|yield|interest)\b/i);
  });

  it('refuses a workspace header, and anyone without a CHIWO account', async () => {
    const mixed = await business.get('/v1/chiwo/nam');
    expect(mixed.status).toBe(400);
    expect(mixed.body.error.code).toBe('context_mismatch');
    const other = await h.signIn('financeA');
    const refused = await h
      .http()
      .post('/v1/chiwo/nam/orders')
      .set('Authorization', `Bearer ${other}`)
      .set('Idempotency-Key', randomUUID())
      .send({ amount_minor: '1000000', disclosure_version: '1' });
    expect(refused.status).toBe(403);
  });
});

describe('personal and business investor profiles stay apart (J13)', () => {
  it('a personal order funds from personal USDC and becomes a personal holding only', async () => {
    const created = await personal.post('/v1/chiwo/nam/orders', {
      amount_minor: (20n * ONE).toString(),
      disclosure_version: '1',
    });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('funding_reserved');
    expect(await personalUsdc()).toBe(30n * ONE);
    expect((await personal.get('/v1/chiwo/nam')).body.funding_pending_minor).toBe('20000000');
    await settleAll();
    const mine = (await personal.get('/v1/chiwo/nam')).body;
    expect(BigInt(mine.holding.shares as string)).toBeGreaterThan(0n);
    expect(mine.funding_pending_minor).toBe('0');
    const workspace = (await business.get('/v1/nam')).body;
    expect(workspace.holding.shares).toBe('0');
    const orders = await personal.get('/v1/chiwo/nam/orders');
    expect((orders.body.data as { status: string }[])[0]?.status).toBe('holding_confirmed');
    expect(await trialBalance(h)).toBe(0n);
  });

  it('a business order by the same person is the workspace’s, in a separate profile', async () => {
    const before = (await personal.get('/v1/chiwo/nam')).body.holding.shares as string;
    const created = await business.post('/v1/nam/orders', {
      amount_minor: (30n * ONE).toString(),
      disclosure_version: '1',
    });
    expect(created.status).toBe(201);
    await settleAll();
    expect(BigInt((await business.get('/v1/nam')).body.holding.shares as string)).toBeGreaterThan(
      0n,
    );
    expect((await personal.get('/v1/chiwo/nam')).body.holding.shares).toBe(before);
    const profiles = await h.owner(
      async (client) =>
        (
          await client.query<{ kind: string; has_tenant: boolean; has_person: boolean }>(
            `select kind, tenant_id is not null as has_tenant, person_id is not null as has_person
               from nam.investor_profile order by kind`,
          )
        ).rows,
    );
    expect(profiles).toEqual([
      { kind: 'business', has_tenant: true, has_person: false },
      { kind: 'personal', has_tenant: false, has_person: true },
    ]);
    const consents = await h.owner(
      async (client) =>
        (
          await client.query<{ capacity: string }>(
            `select capacity from consent.consent_record where action = 'nam.order' order by created_at`,
          )
        ).rows,
    );
    expect(consents.map((c) => c.capacity)).toEqual(['personal', 'business']);
  });

  it('a personal redemption returns USDC to the personal balance only', async () => {
    const workspaceBefore = await balanceOf(h, h.seed.tenantA, 'merchant_usdc_available');
    const personalBefore = await personalUsdc();
    const res = await personal.post('/v1/chiwo/nam/redemptions', { all: true });
    expect(res.status).toBe(201);
    await settleAll();
    const after = (await personal.get('/v1/chiwo/nam')).body;
    expect(after.holding.shares).toBe('0');
    const returned = (await personalUsdc()) - personalBefore;
    expect(returned).toBeGreaterThan(19n * ONE);
    expect(returned).toBeLessThanOrEqual(20n * ONE);
    expect(await balanceOf(h, h.seed.tenantA, 'merchant_usdc_available')).toBe(workspaceBefore);
    expect(await trialBalance(h)).toBe(0n);
    const exceptions = await h.owner(
      async (client) =>
        (
          await client.query(
            `select 1 from payments.reconciliation_exception where type = 'nam_mismatch'`,
          )
        ).rows,
    );
    expect(exceptions).toEqual([]);
  });

  it('keeps personal NAM rows from workspaces and other consumers', async () => {
    const byTenant = await h.db.withTenant(
      h.seed.tenantA,
      (tx) =>
        tx.$queryRaw<{ consumer_account_id: string | null }[]>`
        select consumer_account_id from nam.vault_order`,
    );
    expect(byTenant.every((row) => row.consumer_account_id === null)).toBe(true);
    const stranger = await h.db.withConsumer(
      randomUUID(),
      (tx) => tx.$queryRaw<{ id: string }[]>`select id from nam.vault_order`,
    );
    expect(stranger).toEqual([]);
  });
});
