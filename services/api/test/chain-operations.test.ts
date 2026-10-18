import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ChainService } from '../src/modules/chain/chain.service.js';
import { BASE_SEPOLIA } from '../src/modules/chain/config.js';
import { CHAIN_TRANSITIONS, type ChainOperationStatus } from '../src/modules/chain/operations.js';
import { TEST_KEYS, type Anvil, startBaseSepoliaStandIn, TOKEN_ABI } from './support/anvil.js';
import { type Harness, startHarness } from './support/harness.js';

const USDC = BASE_SEPOLIA.usdc.address;
const WALLET = privateKeyToAccount(TEST_KEYS[0]).address;
const RECIPIENT = privateKeyToAccount(TEST_KEYS[1]).address;
const ONE_USDC = 1_000_000n;

describe('chain operation state machine (brief §3.4, ADR 0004)', () => {
  it('allows exactly the documented transitions', () => {
    expect(CHAIN_TRANSITIONS).toEqual({
      prepared: ['authorization_pending', 'submitted', 'failed', 'reconciliation_required'],
      authorization_pending: ['submitted', 'failed', 'reconciliation_required'],
      submitted: [
        'pending_confirmation',
        'confirmed',
        'reverted',
        'failed',
        'status_unknown',
        'reconciliation_required',
      ],
      pending_confirmation: ['confirmed', 'reverted', 'status_unknown', 'reconciliation_required'],
      status_unknown: ['pending_confirmation', 'confirmed', 'reverted', 'reconciliation_required'],
      confirmed: ['reconciliation_required'],
      reverted: ['reconciliation_required'],
      failed: ['reconciliation_required'],
      reconciliation_required: [],
    } satisfies Record<ChainOperationStatus, readonly ChainOperationStatus[]>);
  });

  it('never leads from status_unknown back to submitted, and never out of reconciliation_required', () => {
    expect(CHAIN_TRANSITIONS.status_unknown).not.toContain('submitted');
    expect(CHAIN_TRANSITIONS.reconciliation_required).toEqual([]);
  });
});

describe('sending USDC from the sandbox wallet (local chain)', () => {
  let anvil: Anvil;
  let h: Harness;
  let chain: ChainService;
  let sends: number;
  let realSend: (raw: Hex) => Promise<Hex>;

  const status = async (id: string): Promise<string> =>
    h.owner(async (c) => {
      const r = await c.query<{ status: string }>(
        'select status from chain.operation where id = $1',
        [id],
      );
      return r.rows[0]?.status ?? 'missing';
    });

  const balance = (who: Address): Promise<bigint> =>
    anvil.client.readContract({
      address: USDC,
      abi: TOKEN_ABI,
      functionName: 'balanceOf',
      args: [who],
    });

  beforeAll(async () => {
    anvil = await startBaseSepoliaStandIn();
    await anvil.fundEth(WALLET, 10n ** 20n);
    await anvil.mint(USDC, WALLET, 1_000n * ONE_USDC);
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
    chain = h.app.get(ChainService);
    await chain.ready();
    realSend = chain.rpc.sendRawTransaction.bind(chain.rpc);
  });

  beforeEach(() => {
    sends = 0;
    chain.rpc.sendRawTransaction = async (raw) => {
      sends += 1;
      return realSend(raw);
    };
  });

  afterAll(async () => {
    await h.close();
    await anvil.stop();
  });

  it('is idempotent per key and refuses the same key with different contents', async () => {
    const first = await chain.prepareUsdcTransfer({
      idempotencyKey: 'idem-1',
      tenantId: null,
      recipient: RECIPIENT,
      amount: ONE_USDC,
    });
    const again = await chain.prepareUsdcTransfer({
      idempotencyKey: 'idem-1',
      tenantId: null,
      recipient: RECIPIENT,
      amount: ONE_USDC,
    });
    expect(again.id).toBe(first.id);
    expect(first.status).toBe('prepared');
    await expect(
      chain.prepareUsdcTransfer({
        idempotencyKey: 'idem-1',
        tenantId: null,
        recipient: RECIPIENT,
        amount: 2n * ONE_USDC,
      }),
    ).rejects.toMatchObject({ code: 'idempotency_key_reused' });
  });

  it('refuses destinations that can only lose funds, and non-positive amounts', async () => {
    const bad: Address[] = ['0x0000000000000000000000000000000000000000', USDC, WALLET];
    for (const recipient of bad) {
      await expect(
        chain.prepareUsdcTransfer({
          idempotencyKey: `bad-${recipient}`,
          tenantId: null,
          recipient,
          amount: ONE_USDC,
        }),
      ).rejects.toMatchObject({ code: 'invalid_destination' });
    }
    await expect(
      chain.prepareUsdcTransfer({
        idempotencyKey: 'bad-amount',
        tenantId: null,
        recipient: RECIPIENT,
        amount: 0n,
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('commits the signed transaction before broadcasting, and a hash is not completion', async () => {
    const op = await chain.prepareUsdcTransfer({
      idempotencyKey: 'send-ok',
      tenantId: null,
      recipient: RECIPIENT,
      amount: 5n * ONE_USDC,
    });
    let statusAtBroadcast = '';
    let hashAtBroadcast: string | null = null;
    chain.rpc.sendRawTransaction = async (raw) => {
      sends += 1;
      const row = await h.owner(async (c) =>
        c.query<{ status: string; tx_hash: string | null }>(
          'select status, tx_hash from chain.operation where id = $1',
          [op.id],
        ),
      );
      statusAtBroadcast = row.rows[0]?.status ?? '';
      hashAtBroadcast = row.rows[0]?.tx_hash ?? null;
      return realSend(raw);
    };
    const sent = await chain.submit(op.id);
    expect(statusAtBroadcast).toBe('submitted');
    expect(hashAtBroadcast).toMatch(/^0x[0-9a-f]{64}$/);
    expect(sent.status).toBe('pending_confirmation');
    expect(sends).toBe(1);

    await anvil.mine(1);
    await chain.monitor();
    expect(await status(op.id)).toBe('pending_confirmation');

    await anvil.mine(60);
    await chain.monitor();
    expect(await status(op.id)).toBe('confirmed');
    expect(await balance(RECIPIENT)).toBe(5n * ONE_USDC);

    const row = await h.owner(async (c) =>
      c.query<Record<string, unknown>>('select * from chain.operation where id = $1', [op.id]),
    );
    const record = row.rows[0] ?? {};
    // Brief §3.5: every field of an on-chain operation is kept.
    expect(record['network']).toBe('base-sepolia');
    expect(record['to_address']).toBe(USDC.toLowerCase());
    expect(record['recipient_address']).toBe(RECIPIENT.toLowerCase());
    expect(record['asset_code']).toBe('USDC');
    expect(String(record['amount'])).toBe('5000000');
    expect(record['submitted_at']).not.toBeNull();
    expect(record['block_hash']).toMatch(/^0x[0-9a-f]{64}$/);
    expect(Number(record['confirmations'])).toBeGreaterThanOrEqual(60);
    expect(String(record['gas_used'])).toMatch(/^[1-9][0-9]*$/);

    const transitions = await h.owner(async (c) =>
      c.query<{ to_status: string }>(
        'select to_status from chain.transition where operation_id = $1 order by created_at',
        [op.id],
      ),
    );
    expect(transitions.rows.map((t) => t.to_status)).toEqual([
      'prepared',
      'submitted',
      'pending_confirmation',
      'confirmed',
    ]);
  });

  it('marks a failed broadcast status_unknown, recovers it by hash, and never sends it again', async () => {
    const op = await chain.prepareUsdcTransfer({
      idempotencyKey: 'send-timeout-after-send',
      tenantId: null,
      recipient: RECIPIENT,
      amount: ONE_USDC,
    });
    // The node accepted the transaction but the answer was lost.
    chain.rpc.sendRawTransaction = async (raw) => {
      sends += 1;
      await realSend(raw);
      throw new Error('socket hang up');
    };
    const sent = await chain.submit(op.id);
    expect(sent.status).toBe('status_unknown');

    await anvil.mine(61);
    await chain.monitor();
    await chain.monitor();
    expect(await status(op.id)).toBe('confirmed');
    expect(sends).toBe(1);
  });

  it('escalates an unknown transaction whose nonce was used by another to reconciliation_required', async () => {
    const op = await chain.prepareUsdcTransfer({
      idempotencyKey: 'send-never-arrived',
      tenantId: null,
      recipient: RECIPIENT,
      amount: ONE_USDC,
    });
    chain.rpc.sendRawTransaction = () => {
      sends += 1;
      return Promise.reject(new Error('timeout'));
    };
    const sent = await chain.submit(op.id);
    expect(sent.status).toBe('status_unknown');

    await chain.monitor();
    expect(await status(op.id)).toBe('status_unknown');

    // Someone with the key sends a different transaction with that nonce.
    const row = await h.owner(async (c) =>
      c.query<{ nonce: string }>('select nonce from chain.operation where id = $1', [op.id]),
    );
    const nonce = Number(row.rows[0]?.nonce);
    const { createWalletClient, http } = await import('viem');
    const wallet = createWalletClient({
      account: privateKeyToAccount(TEST_KEYS[0]),
      transport: http(anvil.rpcUrl),
    });
    await wallet.sendTransaction({ to: RECIPIENT, value: 1n, nonce, chain: null, gas: 21_000n });
    await anvil.mine(1);

    await chain.monitor();
    expect(await status(op.id)).toBe('reconciliation_required');
    expect(sends).toBe(1);
    const exceptions = await h.owner(async (c) =>
      c.query<{ type: string }>(
        `select type from payments.reconciliation_exception where subject_ref = $1`,
        [op.id],
      ),
    );
    expect(exceptions.rows.map((e) => e.type)).toEqual(['chain_operation_unresolved']);
  });

  it('records a transaction that was mined but reverted as reverted', async () => {
    const op = await chain.prepareUsdcTransfer({
      idempotencyKey: 'send-revert',
      tenantId: null,
      recipient: RECIPIENT,
      amount: ONE_USDC,
    });
    await chain.sign(op.id);
    const before = await balance(WALLET);
    await anvil.setTokenBalance(USDC, WALLET, 0n);
    await chain.broadcast(op.id);
    await anvil.mine(61);
    await chain.monitor();
    expect(await status(op.id)).toBe('reverted');
    await anvil.setTokenBalance(USDC, WALLET, before);
  });

  it('gives concurrently signed operations distinct, consecutive nonces', async () => {
    const ops = await Promise.all(
      [0, 1, 2].map((i) =>
        chain.prepareUsdcTransfer({
          idempotencyKey: `nonce-${String(i)}`,
          tenantId: null,
          recipient: RECIPIENT,
          amount: ONE_USDC,
        }),
      ),
    );
    await Promise.all(ops.map((op) => chain.sign(op.id)));
    const nonces = await h.owner(async (c) =>
      c.query<{ nonce: string }>(
        `select nonce from chain.operation where idempotency_key like 'nonce-%' order by nonce`,
      ),
    );
    const values = nonces.rows.map((r) => Number(r.nonce));
    expect(new Set(values).size).toBe(3);
    expect((values[2] ?? 0) - (values[0] ?? 0)).toBe(2);
    for (const op of ops) await chain.broadcast(op.id);
    await anvil.mine(61);
    await chain.monitor();
    for (const op of ops) expect(await status(op.id)).toBe('confirmed');
  });

  it('refuses to sign the same operation twice', async () => {
    const op = await chain.prepareUsdcTransfer({
      idempotencyKey: 'sign-twice',
      tenantId: null,
      recipient: RECIPIENT,
      amount: ONE_USDC,
    });
    await chain.sign(op.id);
    await expect(chain.sign(op.id)).rejects.toMatchObject({ code: 'invalid_state_transition' });
  });

  it('keeps the signer key out of every log line', () => {
    for (const line of h.logs) expect(line).not.toContain(TEST_KEYS[0].slice(2));
  });
});
