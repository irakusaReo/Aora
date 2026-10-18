import { randomUUID } from 'node:crypto';
import {
  type Address,
  createWalletClient,
  decodeFunctionData,
  erc20Abi,
  type Hex,
  http,
  keccak256,
  parseAbi,
  toBytes,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anchorRegistryAbi } from '../src/modules/chain/abi/AnchorRegistry.js';
import { AnchoringService } from '../src/modules/chain/anchoring.service.js';
import { ChainReconciliationService } from '../src/modules/chain/chain-reconciliation.service.js';
import { BASE_SEPOLIA } from '../src/modules/chain/config.js';
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
const ONE = 1_000_000n;
const DEPOSITOR = TEST_KEYS[2];
const STRANGER = TEST_KEYS[1];

let anvil: Anvil;
let h: Harness;
let registry: Address;
let admin: string;
let finance: string;
let operator: string;
let recon: ChainReconciliationService;
let anchoring: AnchoringService;

const ws = (token: string) => ({
  get: (path: string) =>
    h
      .http()
      .get(path)
      .set('Authorization', `Bearer ${token}`)
      .set('Aora-Workspace-Id', h.seed.tenantA),
  post: (path: string) =>
    h
      .http()
      .post(path)
      .set('Authorization', `Bearer ${token}`)
      .set('Aora-Workspace-Id', h.seed.tenantA)
      .set('Idempotency-Key', randomUUID()),
});
const ops = (token: string, path: string) =>
  h.http().post(path).set('Authorization', `Bearer ${token}`);
const cron = () =>
  h
    .http()
    .get('/v1/internal/cron/chain')
    .set('Authorization', `Bearer ${h.config.cronSecret ?? ''}`);

async function settle(blocks = 61): Promise<void> {
  await anvil.mine(blocks);
  expect((await cron()).status).toBe(200);
}

const exceptionsOf = (type: string) =>
  h.owner(async (c) => {
    const r = await c.query<{ subject_ref: string }>(
      `select subject_ref from payments.reconciliation_exception where type = $1 and status = 'open'`,
      [type],
    );
    return r.rows.map((row) => row.subject_ref);
  });

beforeAll(async () => {
  anvil = await startBaseSepoliaStandIn();
  await anvil.fundEth(WALLET, 10n ** 20n);
  for (const key of [DEPOSITOR, STRANGER]) {
    await anvil.mint(USDC, privateKeyToAccount(key).address, 1_000n * ONE);
  }
  // The real AnchorRegistry, with AORA's sandbox wallet as owner and anchorer.
  const deployer = createWalletClient({
    account: privateKeyToAccount(TEST_KEYS[0]),
    transport: http(anvil.rpcUrl),
  });
  const deployHash = await deployer.deployContract({
    abi: anchorRegistryAbi,
    bytecode: testContractCode('AnchorRegistryCreation'),
    args: [WALLET, WALLET],
    chain: null,
  });
  await anvil.mine(1);
  const receipt = await anvil.client.getTransactionReceipt({ hash: deployHash });
  registry = receipt.contractAddress as Address;

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
        anchorRegistry: registry,
      },
    }),
  });
  admin = await h.signIn('adminA');
  finance = await h.signIn('financeA');
  operator = await h.signIn('operator');
  await h.stepUp(admin);
  await h.stepUp(finance);
  recon = h.app.get(ChainReconciliationService);
  anchoring = h.app.get(AnchoringService);

  // Register the depositor, deposit, and complete one withdrawal.
  const challenge = await ws(admin).post('/v1/treasury/address-challenges').send({});
  const account = privateKeyToAccount(DEPOSITOR);
  const registered = await ws(admin)
    .post('/v1/treasury/addresses')
    .send({
      challenge_id: challenge.body.id,
      address: account.address,
      signature: await account.signMessage({ message: challenge.body.message as string }),
    });
  expect(registered.status).toBe(201);
  await anvil.transfer(USDC, DEPOSITOR, WALLET, 40n * ONE);
  await settle();
  const withdrawal = await ws(finance)
    .post('/v1/treasury/withdrawals')
    .send({
      amount_minor: '5000000',
      destination: privateKeyToAccount(generatePrivateKey()).address,
    });
  await h
    .http()
    .post(`/v1/treasury/withdrawals/${withdrawal.body.id as string}/approval`)
    .set('Authorization', `Bearer ${admin}`)
    .set('Aora-Workspace-Id', h.seed.tenantA)
    .send({});
  await settle();
});

afterAll(async () => {
  await h.close();
  await anvil.stop();
});

describe('operator attribution of unattributed deposits', () => {
  let strangerHash: Hex;
  let transferId: string;

  beforeAll(async () => {
    strangerHash = await anvil.transfer(USDC, STRANGER, WALLET, 7n * ONE);
    await settle();
    const row = await h.owner((c) =>
      c.query<{ id: string; status: string }>(
        `select id, status from chain.observed_transfer where tx_hash = $1`,
        [strangerHash.toLowerCase()],
      ),
    );
    expect(row.rows[0]?.status).toBe('unattributed');
    transferId = row.rows[0]?.id ?? '';
  });

  it('is for operators only', async () => {
    const res = await ops(admin, `/v1/ops/chain/transfers/${transferId}/attribution`).send({
      reason: 'faucet funding',
    });
    expect(res.status).toBe(403);
  });

  it('records AORA’s own faucet funding against the platform, once, with a reason', async () => {
    const before = await balanceOf(h, null, 'platform_usdc_funding');
    const res = await ops(operator, `/v1/ops/chain/transfers/${transferId}/attribution`).send({
      reason: 'Circle faucet funding of the sandbox wallet',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'credited', attributed_to: 'platform_funding' });
    expect(await balanceOf(h, null, 'platform_usdc_funding')).toBe(before + 7n * ONE);
    const again = await ops(operator, `/v1/ops/chain/transfers/${transferId}/attribution`).send({
      reason: 'twice',
    });
    expect(again.status).toBe(409);
    expect(await trialBalance(h)).toBe(0n);
  });
});

describe('three-way reconciliation: ledger, chain and operation records (J10)', () => {
  it('is clean on consistent data, and a deposit settles nothing else', async () => {
    const kes = await balanceOf(h, h.seed.tenantA, 'merchant_available');
    const result = await recon.run();
    expect(result).toMatchObject({ skipped: false, exceptions_opened: 0 });
    expect(result.chain_balance_minor).toBe((40n - 5n + 7n) * ONE);
    expect(result.ledger_wallet_minor).toBe((40n - 5n + 7n) * ONE);
    expect(await balanceOf(h, h.seed.tenantA, 'merchant_available')).toBe(kes);
  });

  it('flags a chain balance that the records do not explain', async () => {
    await anvil.setTokenBalance(USDC, WALLET, (40n - 5n + 7n + 1n) * ONE);
    await anvil.mine(1);
    await cron(); // the job runs the reconciliation once the scan has caught up
    await recon.run(); // a second run opens no duplicate
    expect(await exceptionsOf('chain_balance_mismatch')).toHaveLength(1);
    await anvil.setTokenBalance(USDC, WALLET, (40n - 5n + 7n) * ONE);
  });

  it('flags a ledger wallet balance that the records do not explain', async () => {
    await h.owner(async (c) => {
      await c.query('begin');
      const entry = await c.query<{ id: string }>(
        `insert into ledger.journal_entry (idempotency_key, entry_type, operation_type, operation_id)
         values ('injected-for-test', 'injected', 'test', 'test') returning id`,
      );
      const id = entry.rows[0]?.id;
      await c.query(
        `insert into ledger.posting (entry_id, account_id, direction, amount, asset_code)
         select $1, a.id, 'debit', 1, 'USDC' from ledger.account a where a.type = 'chain_wallet_usdc'`,
        [id],
      );
      await c.query(
        `insert into ledger.posting (entry_id, account_id, direction, amount, asset_code)
         select $1, a.id, 'credit', 1, 'USDC' from ledger.account a where a.type = 'platform_usdc_funding'`,
        [id],
      );
      await c.query('commit');
    });
    await recon.run();
    expect(await exceptionsOf('ledger_mismatch')).toContain('chain_wallet_usdc');
  });

  it('flags an operation record that disagrees with the chain', async () => {
    const created = await ws(finance)
      .post('/v1/treasury/withdrawals')
      .send({
        amount_minor: '1000000',
        destination: privateKeyToAccount(generatePrivateKey()).address,
      });
    await h.owner((c) =>
      c.query(`update chain.withdrawal set status = 'completed' where id = $1`, [created.body.id]),
    );
    await recon.run();
    expect(await exceptionsOf('chain_operation_mismatch')).toContain(created.body.id);
  });

  it('waits while the scan has not caught up', async () => {
    await h.owner((c) =>
      c.query(
        `update chain.scan_cursor set last_block = last_block - 10 where name = 'wallet_inbound'`,
      ),
    );
    expect((await recon.run()).skipped).toBe(true);
    await cron();
  });
});

describe('anchoring a ledger period (ADR 0015, P5-10)', () => {
  const tomorrow = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  const label = `ledger-day:${new Date().toISOString().slice(0, 10)}`;
  const periodId = keccak256(toBytes(label));

  it('closes a day into a salted Merkle root, once', async () => {
    const closed = await anchoring.closePeriods(tomorrow);
    expect(closed.closed).toBeGreaterThanOrEqual(1);
    const row = await h.owner((c) =>
      c.query<{ root: string; entry_count: number; salt: Buffer; status: string }>(
        `select root, entry_count, salt, status from chain.anchor_period where label = $1`,
        [label],
      ),
    );
    const period = row.rows[0];
    expect(period?.status).toBe('closed');
    expect(period?.root).toMatch(/^0x[0-9a-f]{64}$/);
    expect(period?.salt).toHaveLength(32);
    const entries = await h.owner((c) =>
      c.query<{ n: string }>(
        `select count(*)::text as n from ledger.journal_entry
         where posted_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'`,
      ),
    );
    expect(period?.entry_count).toBe(Number(entries.rows[0]?.n));
    expect((await anchoring.closePeriods(tomorrow)).closed).toBe(0);
  });

  it('commits the root on chain, and it recomputes from the ledger', async () => {
    await anchoring.commitPeriods();
    await settle();
    await anchoring.commitPeriods();
    const row = await h.owner((c) =>
      c.query<{ root: string; status: string }>(
        `select root, status from chain.anchor_period where label = $1`,
        [label],
      ),
    );
    expect(row.rows[0]?.status).toBe('committed');
    const onChain = await anvil.client.readContract({
      address: registry,
      abi: anchorRegistryAbi,
      functionName: 'anchorOf',
      args: [periodId],
    });
    expect(onChain.root).toBe(row.rows[0]?.root);
    const verified = await anchoring.verifyPeriods();
    expect(verified).toMatchObject({ checked: 1, mismatched: 0 });
  });

  it('flags a stored root that no longer recomputes from the ledger', async () => {
    // Leaves are append-only; tamper with the salt as an operator with database access could.
    await h.owner((c) =>
      c.query(`alter table chain.anchor_period disable trigger anchor_period_protect`),
    );
    await h.owner((c) =>
      c.query(`update chain.anchor_period set salt = $2 where label = $1`, [
        label,
        Buffer.alloc(32, 7),
      ]),
    );
    await h.owner((c) =>
      c.query(`alter table chain.anchor_period enable trigger anchor_period_protect`),
    );
    const verified = await anchoring.verifyPeriods();
    expect(verified.mismatched).toBe(1);
    expect(await exceptionsOf('anchor_mismatch')).toContain(label);
  });

  it('puts no personal or tenant data in any transaction AORA sends (rule 8)', async () => {
    const sent = await h.owner((c) =>
      c.query<{ call_data: string }>(
        `select call_data from chain.operation where tx_hash is not null`,
      ),
    );
    expect(sent.rows.length).toBeGreaterThanOrEqual(2);
    const anchorAbi = parseAbi([
      'function anchor(bytes32 periodId, bytes32 root, uint64 entryCount)',
    ]);
    const tenants = [h.seed.tenantA, h.seed.tenantB].map((id) => id.replaceAll('-', ''));
    for (const row of sent.rows) {
      const data = row.call_data as Hex;
      let name: string;
      try {
        name = decodeFunctionData({ abi: erc20Abi, data }).functionName;
      } catch {
        name = decodeFunctionData({ abi: anchorAbi, data }).functionName;
      }
      expect(['transfer', 'anchor']).toContain(name);
      for (const tenant of tenants) expect(data).not.toContain(tenant);
      expect(data).not.toMatch(/999000000/); // seeded phone digits
    }
  });
});
