import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChainService } from '../src/modules/chain/chain.service.js';
import { BASE_SEPOLIA } from '../src/modules/chain/config.js';
import { verifyUsdcTransfer } from '../src/modules/chain/verify.js';
import { TEST_KEYS, type Anvil, OTHER_TOKEN, startBaseSepoliaStandIn } from './support/anvil.js';
import { type Harness, startHarness } from './support/harness.js';

const USDC = BASE_SEPOLIA.usdc.address;
const WALLET = privateKeyToAccount(TEST_KEYS[0]).address;
const PAYER_KEY = TEST_KEYS[2];
const PAYER = privateKeyToAccount(PAYER_KEY).address;
const STRANGER = privateKeyToAccount(TEST_KEYS[1]).address;
const ONE_USDC = 1_000_000n;

interface Observed {
  tx_hash: string;
  status: string;
  asset_code: string | null;
  amount: string;
  from_address: string;
  token_address: string;
  journal_entry_id: string | null;
}

describe('inbound transfers to the sandbox wallet (local chain)', () => {
  let anvil: Anvil;
  let h: Harness;
  let chain: ChainService;

  const observed = async (txHash: string): Promise<Observed[]> =>
    h.owner(async (c) => {
      const r = await c.query<Observed>(
        'select tx_hash, status, asset_code, amount::text, from_address, token_address, journal_entry_id from chain.observed_transfer where tx_hash = $1',
        [txHash.toLowerCase()],
      );
      return r.rows;
    });

  const catchUp = async (): Promise<void> => {
    for (let i = 0; i < 100; i += 1) {
      const result = await chain.observe();
      if (result.caught_up) return;
    }
    throw new Error('observer did not catch up');
  };

  beforeAll(async () => {
    anvil = await startBaseSepoliaStandIn();
    await anvil.fundEth(WALLET, 10n ** 20n);
    await anvil.fundEth(PAYER, 10n ** 20n);
    await anvil.mint(USDC, PAYER, 100_000n * ONE_USDC);
    await anvil.mint(OTHER_TOKEN, PAYER, 10n ** 24n);
    h = await startHarness({
      config: (config) => ({
        ...config,
        chain: {
          rpcUrl: anvil.rpcUrl,
          signerPrivateKey: TEST_KEYS[0],
          scanBlockRange: 25,
          requestTimeoutMs: 5_000,
          unknownAfterSeconds: 3_600,
        },
      }),
    });
    chain = h.app.get(ChainService);
    await chain.ready();
  });

  afterAll(async () => {
    await h.close();
    await anvil.stop();
  });

  it('records an inbound USDC transfer exactly, once, however often the scan runs', async () => {
    const hash = await anvil.transfer(USDC, PAYER_KEY, WALLET, 12_345_678n);
    await catchUp();
    await catchUp();
    const rows = await observed(hash);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'observed',
      asset_code: 'USDC',
      amount: '12345678',
      from_address: PAYER.toLowerCase(),
      token_address: USDC.toLowerCase(),
      journal_entry_id: null,
    });
  });

  it('confirms only after the confirmation policy, and credits nothing by itself', async () => {
    const hash = await anvil.transfer(USDC, PAYER_KEY, WALLET, 7n * ONE_USDC);
    await catchUp();
    await anvil.mine(58);
    await chain.confirmObserved();
    expect((await observed(hash))[0]?.status).toBe('observed');
    await anvil.mine(2);
    await chain.confirmObserved();
    const [row] = await observed(hash);
    expect(row?.status).toBe('confirmed');
    expect(row?.journal_entry_id).toBeNull();
    const entries = await h.owner(async (c) =>
      c.query(`select 1 from ledger.posting where asset_code = 'USDC'`),
    );
    expect(entries.rowCount).toBe(0);
  });

  it('holds a high-value transfer to the larger confirmation count', async () => {
    const hash = await anvil.transfer(USDC, PAYER_KEY, WALLET, 5_000n * ONE_USDC);
    await catchUp();
    await anvil.mine(100);
    await chain.confirmObserved();
    expect((await observed(hash))[0]?.status).toBe('observed');
    await anvil.mine(500);
    await chain.confirmObserved();
    expect((await observed(hash))[0]?.status).toBe('confirmed');
  });

  it('never treats another token as USDC, and opens an unexpected_asset exception', async () => {
    const hash = await anvil.transfer(OTHER_TOKEN, PAYER_KEY, WALLET, 10n ** 18n);
    await catchUp();
    const [row] = await observed(hash);
    expect(row).toMatchObject({
      status: 'unexpected_asset',
      asset_code: null,
      token_address: OTHER_TOKEN.toLowerCase(),
    });
    const exceptions = await h.owner(async (c) =>
      c.query<{ type: string }>(
        `select type from payments.reconciliation_exception where subject_ref like $1`,
        [`${hash.toLowerCase()}%`],
      ),
    );
    expect(exceptions.rows.map((e) => e.type)).toEqual(['unexpected_asset']);
  });

  it('ignores transfers that do not go to the wallet', async () => {
    const hash = await anvil.transfer(USDC, PAYER_KEY, STRANGER, ONE_USDC);
    await catchUp();
    expect(await observed(hash)).toHaveLength(0);
  });

  it('drops an observation whose block was reorganised away', async () => {
    const snapshot = await anvil.snapshot();
    const hash = await anvil.transfer(USDC, PAYER_KEY, WALLET, 3n * ONE_USDC);
    await catchUp();
    expect((await observed(hash))[0]?.status).toBe('observed');
    await anvil.revert(snapshot);
    await anvil.mine(70);
    await chain.confirmObserved();
    expect((await observed(hash))[0]?.status).toBe('dropped');
  });

  it('scans in bounded block ranges from a stored cursor', async () => {
    await anvil.mine(80);
    const first = await chain.observe();
    expect(first.to_block - first.from_block + 1n).toBeLessThanOrEqual(25n);
    expect(first.caught_up).toBe(false);
    await catchUp();
    const idle = await chain.observe();
    expect(idle.caught_up).toBe(true);
  });
});

describe('verifying a USDC transfer by its content (ADR 0004)', () => {
  let anvil: Anvil;
  beforeAll(async () => {
    anvil = await startBaseSepoliaStandIn();
    await anvil.fundEth(PAYER, 10n ** 20n);
    await anvil.mint(USDC, PAYER, 1_000n * ONE_USDC);
    await anvil.mint(OTHER_TOKEN, PAYER, 10n ** 24n);
  });
  afterAll(async () => {
    await anvil.stop();
  });

  it('accepts a transfer only with the right token, recipient, amount and confirmations', async () => {
    const hash = await anvil.transfer(USDC, PAYER_KEY, WALLET, 2n * ONE_USDC);
    const expected = { to: WALLET, amount: 2n * ONE_USDC, minConfirmations: 10 };
    expect((await verifyUsdcTransfer(anvil.client, hash, expected)).outcome).toBe(
      'insufficient_confirmations',
    );
    await anvil.mine(10);
    const verified = await verifyUsdcTransfer(anvil.client, hash, expected);
    expect(verified.outcome).toBe('verified');
    expect(verified.from?.toLowerCase()).toBe(PAYER.toLowerCase());
    expect(
      (await verifyUsdcTransfer(anvil.client, hash, { ...expected, amount: ONE_USDC })).outcome,
    ).toBe('no_matching_transfer');
    expect(
      (await verifyUsdcTransfer(anvil.client, hash, { ...expected, to: STRANGER })).outcome,
    ).toBe('no_matching_transfer');
  });

  it('never accepts another token, an unknown hash, or a reverted transaction', async () => {
    const other = await anvil.transfer(OTHER_TOKEN, PAYER_KEY, WALLET, 2n * ONE_USDC);
    await anvil.mine(10);
    const expected = { to: WALLET, amount: 2n * ONE_USDC, minConfirmations: 1 };
    expect((await verifyUsdcTransfer(anvil.client, other, expected)).outcome).toBe(
      'no_matching_transfer',
    );
    expect((await verifyUsdcTransfer(anvil.client, `0x${'ab'.repeat(32)}`, expected)).outcome).toBe(
      'not_found',
    );
    const reverted = await anvil.transfer(USDC, PAYER_KEY, WALLET, 10n ** 30n);
    await anvil.mine(10);
    expect(
      (await verifyUsdcTransfer(anvil.client, reverted, { ...expected, amount: 10n ** 30n }))
        .outcome,
    ).toBe('reverted');
  });
});
