import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type Address, createWalletClient, erc20Abi, getAddress, type Hex, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { namUsdcVaultAbi } from '../src/modules/chain/abi/NamUsdcVault.js';
import { ChainService } from '../src/modules/chain/chain.service.js';
import { BASE_SEPOLIA } from '../src/modules/chain/config.js';
import { NamService } from '../src/modules/nam/nam.service.js';
import {
  type Anvil,
  startBaseSepoliaStandIn,
  TEST_KEYS,
  testContractCode,
} from './support/anvil.js';
import { type Harness, startHarness } from './support/harness.js';
import { balanceOf, trialBalance } from './support/money.js';

const USDC = BASE_SEPOLIA.usdc.address;
const WALLET = privateKeyToAccount(TEST_KEYS[0]).address;
const DEPOSITOR = TEST_KEYS[2];
const ONE = 1_000_000n;

let anvil: Anvil;
let h: Harness;
let vault: Address;
let admin: string;
let finance: string;
let cashier: string;
let adminB: string;
let nam: NamService;

const as = (token: string, workspace?: string) => {
  const ws = workspace ?? h.seed.tenantA;
  return {
    get: (path: string) =>
      h.http().get(path).set('Authorization', `Bearer ${token}`).set('Aora-Workspace-Id', ws),
    post: (path: string) =>
      h
        .http()
        .post(path)
        .set('Authorization', `Bearer ${token}`)
        .set('Aora-Workspace-Id', ws)
        .set('Idempotency-Key', randomUUID()),
  };
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
/** Runs the chain job until nothing moves (approval, then deposit or redeem, each confirmed). */
async function settleAll(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await settle();
}
const sharesOnChain = (): Promise<bigint> =>
  anvil.client.readContract({
    address: vault,
    abi: namUsdcVaultAbi,
    functionName: 'balanceOf',
    args: [WALLET],
  });
const holding = async (): Promise<{ shares: string; current_value_minor: string }> =>
  (await as(finance).get('/v1/nam')).body.holding as {
    shares: string;
    current_value_minor: string;
  };
const order = (amount: string, version = '1', token = finance) =>
  as(token).post('/v1/nam/orders').send({ amount_minor: amount, disclosure_version: version });

beforeAll(async () => {
  anvil = await startBaseSepoliaStandIn();
  await anvil.fundEth(WALLET, 10n ** 20n);
  await anvil.mint(USDC, privateKeyToAccount(DEPOSITOR).address, 1_000n * ONE);
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
  admin = await h.signIn('adminA');
  finance = await h.signIn('financeA');
  cashier = await h.signIn('cashierA');
  adminB = await h.signIn('adminB');
  for (const token of [admin, finance, adminB]) await h.stepUp(token);
  nam = h.app.get(NamService);

  // Fund tenant A's USDC treasury: register the depositor and deposit 100 USDC.
  const challenge = await as(admin).post('/v1/treasury/address-challenges').send({});
  const account = privateKeyToAccount(DEPOSITOR);
  await as(admin)
    .post('/v1/treasury/addresses')
    .send({
      challenge_id: challenge.body.id,
      address: account.address,
      signature: await account.signMessage({ message: challenge.body.message as string }),
    });
  await anvil.transfer(USDC, DEPOSITOR, WALLET, 100n * ONE);
  await settle();
  expect(await balanceOf(h, h.seed.tenantA, 'merchant_usdc_available')).toBe(100n * ONE);
});

afterAll(async () => {
  await h.close();
  await anvil.stop();
});

describe('the NAM product (brief §6.1)', () => {
  it('states its facts, its disclosure and an empty holding, labelled sandbox', async () => {
    const res = await as(finance).get('/v1/nam');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      product: {
        name: 'NAM USDC Vault (sandbox)',
        kind: 'smart_contract_vault',
        asset: 'USDC',
        fee_bps: 0,
        returns_claimed: false,
        vault_address: getAddress(vault),
      },
      disclosure: { key: 'nam_vault_disclosure', version: '1' },
      holding: { shares: '0', current_value_minor: '0' },
      funding_pending_minor: '0',
      mode: 'sandbox',
    });
  });

  it('shows no yield, rate or interest figure anywhere (J11)', async () => {
    const body = JSON.stringify((await as(finance).get('/v1/nam')).body);
    expect(body).not.toMatch(/\b(apy|apr|yield|interest)\b/i);
    const page = readFileSync(
      new URL('../../../apps/kony-web/app/w/[workspaceId]/nam/page.tsx', import.meta.url),
      'utf8',
    );
    expect(page).not.toMatch(/\b(apy|apr|yield|interest)\b/i);
  });

  it('is invisible to a cashier (J13)', async () => {
    expect((await as(cashier).get('/v1/nam')).status).toBe(403);
    expect((await order('1000000', '1', cashier)).status).toBe(403);
  });
});

describe('funding, order and holding are separate (J11, P6-4)', () => {
  let orderId: string;

  it('refuses an order without consent to the current disclosure, or above the available USDC', async () => {
    const stale = await order('1000000', '0');
    expect(stale.status).toBe(409);
    const tooMuch = await order('500000000');
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.error.code).toBe('insufficient_funds');
  });

  it('reserves the funding on request and creates no holding', async () => {
    const res = await order('10000000');
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('funding_reserved');
    orderId = res.body.id as string;
    expect(await balanceOf(h, h.seed.tenantA, 'merchant_usdc_available')).toBe(90n * ONE);
    expect(await balanceOf(h, h.seed.tenantA, 'merchant_nam_funding_pending')).toBe(10n * ONE);
    expect((await holding()).shares).toBe('0');
    const consent = await h.owner((c) =>
      c.query<{ capacity: string }>(
        `select r.capacity from consent.consent_record r
         join consent.terms_document d on d.id = r.terms_document_id
         where d.key = 'nam_vault_disclosure' and r.tenant_id = $1`,
        [h.seed.tenantA],
      ),
    );
    expect(consent.rows.map((r) => r.capacity)).toEqual(['business']);
  });

  it('holds only after the deposit is confirmed, never on a hash', async () => {
    await nam.processOrders(); // approval first (P6-6)
    await settle(); // approval confirmed
    await nam.processOrders(); // deposit signed and broadcast
    const pending = await as(finance).get('/v1/nam/orders');
    const row = (
      pending.body.data as { id: string; status: string; tx_hash: string | null }[]
    ).find((o) => o.id === orderId);
    expect(row?.status).toBe('depositing');
    expect(row?.tx_hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect((await holding()).shares).toBe('0');

    await settle();
    const done = (await as(finance).get('/v1/nam/orders')).body.data as {
      id: string;
      status: string;
      shares: string | null;
    }[];
    expect(done.find((o) => o.id === orderId)).toMatchObject({
      status: 'holding_confirmed',
      shares: '10000000000000',
    });
    expect((await holding()).shares).toBe('10000000000000');
    expect(await sharesOnChain()).toBe(10_000_000_000_000n);
    expect(await balanceOf(h, h.seed.tenantA, 'merchant_nam_funding_pending')).toBe(0n);
    expect(await balanceOf(h, h.seed.tenantA, 'merchant_nam_holding')).toBe(10n * ONE);
    expect(await balanceOf(h, null, 'nam_vault_usdc')).toBe(10n * ONE);
    expect(await balanceOf(h, null, 'chain_wallet_usdc')).toBe(90n * ONE);
    expect(await trialBalance(h)).toBe(0n);
  });

  it('approves the vault once, not per order', async () => {
    expect((await order('5000000')).status).toBe(201);
    await settleAll();
    const approvals = await h.owner((c) =>
      c.query(`select 1 from chain.operation where kind = 'usdc_approve'`),
    );
    expect(approvals.rowCount).toBe(1);
    expect((await holding()).shares).toBe('15000000000000');
  });

  it('releases the reservation when the deposit reverts', async () => {
    const res = await order('2000000');
    const chain = h.app.get(ChainService);
    const realSend = chain.rpc.sendRawTransaction.bind(chain.rpc);
    const before = await anvil.client.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [WALLET],
    });
    chain.rpc.sendRawTransaction = async (raw: Hex) => {
      await anvil.setTokenBalance(USDC, WALLET, 0n); // the vault's transferFrom will fail
      return realSend(raw);
    };
    await nam.processOrders();
    chain.rpc.sendRawTransaction = realSend;
    await settle();
    await anvil.setTokenBalance(USDC, WALLET, before);
    const row = (
      (await as(finance).get('/v1/nam/orders')).body.data as { id: string; status: string }[]
    ).find((o) => o.id === res.body.id);
    expect(row?.status).toBe('failed');
    expect(await balanceOf(h, h.seed.tenantA, 'merchant_nam_funding_pending')).toBe(0n);
    expect(await balanceOf(h, h.seed.tenantA, 'merchant_usdc_available')).toBe(85n * ONE);
  });
});

describe('redemptions back to the USDC treasury', () => {
  it('refuses more shares than the holding, counting shares already being redeemed', async () => {
    const tooMany = await as(finance)
      .post('/v1/nam/redemptions')
      .send({ shares: '99000000000000' });
    expect(tooMany.status).toBe(422);
    expect(tooMany.body.error.code).toBe('insufficient_funds');
  });

  it('redeems part of the holding after confirmation, with exact ledger and holding', async () => {
    const res = await as(finance).post('/v1/nam/redemptions').send({ shares: '5000000000000' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('requested');
    const again = await as(finance).post('/v1/nam/redemptions').send({ shares: '10000000000001' });
    expect(again.body.error.code).toBe('insufficient_funds');
    expect((await holding()).shares).toBe('15000000000000');
    await nam.processRedemptions();
    await settle();
    const row = (
      (await as(finance).get('/v1/nam/redemptions')).body.data as {
        id: string;
        status: string;
        assets_minor: string | null;
      }[]
    ).find((r) => r.id === res.body.id);
    expect(row?.status).toBe('completed');
    expect(BigInt(row?.assets_minor ?? '0')).toBeLessThanOrEqual(5n * ONE);
    expect(BigInt(row?.assets_minor ?? '0')).toBeGreaterThanOrEqual(5n * ONE - 1n);
    expect((await holding()).shares).toBe('10000000000000');
    expect(await balanceOf(h, h.seed.tenantA, 'merchant_nam_holding')).toBe(10n * ONE);
    expect(await trialBalance(h)).toBe(0n);
  });

  it('redeems everything, leaving no holding and no cost basis', async () => {
    const res = await as(finance).post('/v1/nam/redemptions').send({ all: true });
    expect(res.status).toBe(201);
    await settleAll();
    expect((await holding()).shares).toBe('0');
    expect(await balanceOf(h, h.seed.tenantA, 'merchant_nam_holding')).toBe(0n);
    expect(await sharesOnChain()).toBe(0n);
    expect(await trialBalance(h)).toBe(0n);
  });
});

describe('tenant isolation of NAM data', () => {
  it('shows another workspace none of tenant A’s orders, redemptions or holding', async () => {
    const view = await as(adminB, h.seed.tenantB).get('/v1/nam');
    expect(view.body.holding.shares).toBe('0');
    expect((await as(adminB, h.seed.tenantB).get('/v1/nam/orders')).body.data).toEqual([]);
    expect((await as(adminB, h.seed.tenantB).get('/v1/nam/redemptions')).body.data).toEqual([]);
  });

  it('forces row-level security on every NAM table with a tenant', async () => {
    const rows = await h.owner((c) =>
      c.query<{ relname: string; forced: boolean }>(
        `select c.relname, c.relforcerowsecurity as forced from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id'
         where n.nspname = 'nam' and c.relkind = 'r'`,
      ),
    );
    expect(rows.rows.length).toBeGreaterThanOrEqual(4);
    for (const row of rows.rows) expect(row.forced, row.relname).toBe(true);
  });
});

describe('NAM reconciliation against the vault (P6-10)', () => {
  it('is clean on consistent data and flags an injected holding or ledger difference', async () => {
    expect((await order('3000000')).status).toBe(201);
    await settleAll();
    expect((await nam.reconcile()).exceptions_opened).toBe(0);

    await h.owner((c) =>
      c.query(`update nam.holding set shares = shares + 1 where tenant_id = $1`, [h.seed.tenantA]),
    );
    expect((await nam.reconcile()).exceptions_opened).toBeGreaterThanOrEqual(1);
    const open = await h.owner((c) =>
      c.query<{ subject_ref: string }>(
        `select subject_ref from payments.reconciliation_exception where type = 'nam_mismatch'`,
      ),
    );
    expect(open.rows.map((r) => r.subject_ref)).toContain('vault_shares');
  });
});
