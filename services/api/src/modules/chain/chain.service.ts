import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  type Address,
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  type Hex,
  http,
  isAddress,
  keccak256,
  type PublicClient,
  TransactionNotFoundError,
  verifyMessage,
  TransactionReceiptNotFoundError,
  zeroAddress,
} from 'viem';
import type { Prisma } from '../../generated/prisma/client.js';
import { APP_CONFIG, type AppConfig } from '../../platform/config.js';
import { Database, type Tx } from '../../platform/database.js';
import { AppError } from '../../platform/errors.js';
import { ReconciliationService } from '../payments/reconciliation.service.js';
import { exactInteger } from './amounts.js';
import { BASE_SEPOLIA, type ChainSettings } from './config.js';
import { type ChainOperationStatus, transitionChainOperation } from './operations.js';
import { DevelopmentSigner, type Signer } from './signer.js';
import { ChainVerificationError, verifyChain } from './startup.js';

/** The RPC calls the chain module makes. Sends are a separate method so they can never retry. */
export interface ChainRpc {
  readonly client: PublicClient;
  sendRawTransaction(raw: Hex): Promise<Hex>;
}

export interface ChainOperationView {
  readonly id: string;
  readonly status: ChainOperationStatus;
  readonly kind: string;
  readonly tx_hash: string | null;
  readonly nonce: string | null;
}

export type ChainHealth = 'not_configured' | 'unverified' | 'verified' | `failed:${string}`;

const MAX_UINT256 = 2n ** 256n - 1n;
const WALLET_INBOUND = 'wallet_inbound';
const OPEN: ChainOperationStatus[] = ['submitted', 'pending_confirmation', 'status_unknown'];

interface Policy {
  readonly min: number;
  readonly highValueThreshold: bigint;
  readonly highValue: number;
}

/**
 * The only code that talks to Base (ADR 0004). Every feature first awaits
 * `ready()`, which verifies the chain once per process (chain ID, USDC code and
 * decimals, ledger exponent) and only then creates the sandbox signer with the
 * chain ID the RPC actually reported. On Vercel there is no long-lived process,
 * so this check runs on each instance's first chain call instead of at boot.
 */
@Injectable()
export class ChainService {
  private readonly logger = new Logger('ChainService');
  /** Replaceable in tests only, to simulate a lost or failed broadcast. */
  rpc: ChainRpc;
  private verification: Promise<{ chainId: number; signer: Signer | null }> | null = null;
  private health: ChainHealth;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(Database) private readonly db: Database,
    @Inject(ReconciliationService) private readonly reconciliation: ReconciliationService,
  ) {
    const settings = config.chain;
    this.health = settings ? 'unverified' : 'not_configured';
    this.rpc = settings ? createRpc(settings) : unavailableRpc();
  }

  status(): ChainHealth {
    return this.health;
  }

  /** Verifies the chain once; a wrong chain, token or exponent stays refused for this process. */
  ready(): Promise<{ chainId: number; signer: Signer | null }> {
    const settings = this.config.chain;
    if (!settings) {
      return Promise.reject(new AppError('chain_unavailable', 'Base Sepolia is not configured.'));
    }
    this.verification ??= (async () => {
      const asset = await this.db.asPlatform((tx) =>
        tx.asset.findUnique({ where: { code: BASE_SEPOLIA.usdc.assetCode } }),
      );
      const { chainId } = await verifyChain(this.rpc.client, asset?.exponent ?? -1);
      const signer = settings.signerPrivateKey
        ? DevelopmentSigner.create(settings.signerPrivateKey, {
            mode: this.config.mode,
            verifiedChainId: chainId,
          })
        : null;
      this.health = 'verified';
      return { chainId, signer };
    })().catch((error: unknown) => {
      const code = error instanceof ChainVerificationError ? error.code : 'error';
      this.health = `failed:${code}`;
      // An unreachable RPC may recover; a wrong chain, token or exponent never does.
      if (code === 'rpc_unreachable' || code === 'error') this.verification = null;
      this.logger.error(`Base Sepolia verification failed: ${code}`);
      throw new AppError('chain_unavailable', 'Base Sepolia is unavailable.');
    });
    return this.verification;
  }

  private async signerOrFail(): Promise<{ chainId: number; signer: Signer }> {
    const { chainId, signer } = await this.ready();
    if (!signer) throw new AppError('chain_unavailable', 'No sandbox signer is configured.');
    return { chainId, signer };
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  /** Records an intended USDC transfer from AORA's sandbox wallet. Idempotent per key. */
  async prepareUsdcTransfer(input: {
    readonly idempotencyKey: string;
    readonly tenantId: string | null;
    readonly recipient: Address;
    readonly amount: bigint;
    readonly awaitAuthorization?: boolean;
  }): Promise<ChainOperationView> {
    const { signer } = await this.signerOrFail();
    if (input.amount <= 0n || input.amount > MAX_UINT256) {
      throw new AppError(
        'invalid_request',
        'The amount must be a positive whole number of base units.',
      );
    }
    const recipient = await this.assertDestination(input.recipient);
    const usdc = BASE_SEPOLIA.usdc.address.toLowerCase();
    const callData = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [recipient, input.amount],
    });
    const contents = {
      kind: 'usdc_transfer',
      tenant_id: input.tenantId,
      from_address: signer.address.toLowerCase(),
      to_address: usdc,
      recipient_address: recipient.toLowerCase(),
      asset_code: BASE_SEPOLIA.usdc.assetCode,
      amount: input.amount.toString(),
      call_data: callData.toLowerCase(),
    };
    return this.db.asPlatform(async (tx) => {
      const inserted = await tx.$queryRaw<{ id: string }[]>`
        insert into chain.operation
          (idempotency_key, kind, tenant_id, from_address, to_address, recipient_address,
           asset_code, amount, call_data)
        values (${input.idempotencyKey}, ${contents.kind}, ${contents.tenant_id}::uuid,
                ${contents.from_address}, ${contents.to_address}, ${contents.recipient_address},
                ${contents.asset_code}, ${contents.amount}::numeric, ${contents.call_data})
        on conflict (idempotency_key) do nothing
        returning id`;
      const row = await tx.operation.findUniqueOrThrow({
        where: { idempotency_key: input.idempotencyKey },
      });
      const same =
        row.kind === contents.kind &&
        row.tenant_id === contents.tenant_id &&
        row.from_address === contents.from_address &&
        row.recipient_address === contents.recipient_address &&
        row.amount !== null &&
        exactInteger(row.amount).toString() === contents.amount;
      if (!same) {
        throw new AppError(
          'idempotency_key_reused',
          'This Idempotency-Key was used for a different chain operation.',
        );
      }
      if (inserted.length === 1) {
        await tx.transition.create({
          data: {
            operation_id: row.id,
            tenant_id: row.tenant_id,
            from_status: null,
            to_status: 'prepared',
            source: 'api',
          },
        });
        if (input.awaitAuthorization) {
          await transitionChainOperation(tx, row, 'authorization_pending', 'api', null);
          return view({ ...row, status: 'authorization_pending' });
        }
      }
      return view(row);
    });
  }

  /**
   * Records an intended call to one of AORA's own contracts (anchoring now; the
   * vault in Phase 6). No value is sent. Idempotent per key.
   */
  async prepareContractCall(input: {
    readonly idempotencyKey: string;
    readonly kind: 'anchor_commit' | 'usdc_approve' | 'vault_deposit' | 'vault_redeem';
    readonly to: Address;
    readonly data: Hex;
    /** The workspace an operation acts for, so its members can see it (row-level security). */
    readonly tenantId?: string | null;
  }): Promise<ChainOperationView> {
    const { signer } = await this.signerOrFail();
    const contents = {
      from_address: signer.address.toLowerCase(),
      to_address: getAddress(input.to).toLowerCase(),
      call_data: input.data.toLowerCase(),
    };
    return this.db.asPlatform(async (tx) => {
      const inserted = await tx.$queryRaw<{ id: string }[]>`
        insert into chain.operation (idempotency_key, kind, tenant_id, from_address, to_address, call_data)
        values (${input.idempotencyKey}, ${input.kind}, ${input.tenantId ?? null}::uuid,
                ${contents.from_address}, ${contents.to_address}, ${contents.call_data})
        on conflict (idempotency_key) do nothing
        returning id`;
      const row = await tx.operation.findUniqueOrThrow({
        where: { idempotency_key: input.idempotencyKey },
      });
      if (
        row.kind !== input.kind ||
        row.to_address !== contents.to_address ||
        row.call_data !== contents.call_data
      ) {
        throw new AppError(
          'idempotency_key_reused',
          'This Idempotency-Key was used for a different chain operation.',
        );
      }
      if (inserted.length === 1) {
        await tx.transition.create({
          data: {
            operation_id: row.id,
            tenant_id: row.tenant_id,
            from_status: null,
            to_status: 'prepared',
            source: 'api',
          },
        });
      }
      return view(row);
    });
  }

  /** The AnchorRegistry this environment anchors to, or null if none is deployed. */
  anchorRegistry(): Address | null {
    const override = this.config.chain?.anchorRegistry;
    return override ? getAddress(override) : BASE_SEPOLIA.contracts.anchorRegistry;
  }

  /** The NamUsdcVault this environment uses, or null if none is deployed. */
  namVault(): Address | null {
    const override = this.config.chain?.namVault;
    return override ? getAddress(override) : BASE_SEPOLIA.contracts.namUsdcVault;
  }

  /** AORA's sandbox testnet wallet: where deposits go and withdrawals come from. */
  async walletAddress(): Promise<Address> {
    return (await this.signerOrFail()).signer.address;
  }

  /**
   * True if `signature` is `address`'s EIP-191 personal signature of `message`
   * (P5-5). Checked off chain; nothing is sent.
   */
  async verifySignature(address: string, message: string, signature: string): Promise<boolean> {
    if (!isAddress(address, { strict: false }) || !/^0x[0-9a-fA-F]+$/.test(signature)) {
      return false;
    }
    try {
      return await verifyMessage({
        address: getAddress(address),
        message,
        signature: signature as Hex,
      });
    } catch {
      return false;
    }
  }

  /** P5-9: refuses addresses that could only lose the funds. Returns the checksummed address. */
  async assertDestination(raw: string): Promise<Address> {
    const wallet = await this.walletAddress();
    if (!isAddress(raw, { strict: false })) {
      throw new AppError('invalid_destination', 'That is not a valid address.');
    }
    const address = getAddress(raw);
    const refused = [zeroAddress, getAddress(BASE_SEPOLIA.usdc.address), getAddress(wallet)];
    if (refused.includes(address)) {
      throw new AppError('invalid_destination', 'Funds sent to that address would be lost.');
    }
    const code = await this.rpc.client.getCode({ address });
    if (code && code !== '0x') {
      throw new AppError('invalid_destination', 'Sending to a contract address is not supported.');
    }
    return address;
  }

  /**
   * Signs the transaction and commits it, with its hash and nonce, as
   * `submitted` BEFORE anything is broadcast. Nonces come from a locked row, so
   * two signers never share one.
   */
  async sign(operationId: string): Promise<ChainOperationView> {
    const { chainId, signer } = await this.signerOrFail();
    const before = await this.db.asPlatform((tx) =>
      tx.operation.findUnique({ where: { id: operationId } }),
    );
    if (!before) throw new AppError('not_found', 'No such chain operation.');
    if (before.status !== 'prepared' && before.status !== 'authorization_pending') {
      throw new AppError(
        'invalid_state_transition',
        `Cannot sign a chain operation in ${before.status}.`,
      );
    }
    const to = before.to_address ? getAddress(before.to_address) : null;
    if (!to) throw new AppError('capability_not_supported', 'Only calls are signed here.');
    const data = before.call_data as Hex;
    const [gasEstimate, fees, pendingCount] = await Promise.all([
      this.rpc.client.estimateGas({ account: signer.address, to, data }),
      this.rpc.client.estimateFeesPerGas(),
      this.rpc.client.getTransactionCount({ address: signer.address, blockTag: 'pending' }),
    ]);
    const gas = (gasEstimate * 12n) / 10n;
    const sender = signer.address.toLowerCase();

    return this.db.asPlatform(async (tx) => {
      const [row] = await tx.$queryRaw<{ id: string; tenant_id: string | null; status: string }[]>`
        select id, tenant_id, status from chain.operation where id = ${operationId}::uuid for update`;
      if (!row || (row.status !== 'prepared' && row.status !== 'authorization_pending')) {
        throw new AppError('invalid_state_transition', 'The chain operation was already signed.');
      }
      await tx.$executeRaw`
        insert into chain.signer_nonce (address, next_nonce) values (${sender}, ${pendingCount})
        on conflict (address) do nothing`;
      const [lock] = await tx.$queryRaw<{ next_nonce: bigint }[]>`
        select next_nonce from chain.signer_nonce where address = ${sender} for update`;
      const stored = lock?.next_nonce ?? 0n;
      const nonce = stored > BigInt(pendingCount) ? stored : BigInt(pendingCount);
      const raw = await signer.signTransaction({
        type: 'eip1559',
        chainId,
        nonce: Number(nonce),
        to,
        data,
        value: 0n,
        gas,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
      const hash = keccak256(raw);
      await tx.$executeRaw`
        update chain.signer_nonce set next_nonce = ${nonce + 1n}, updated_at = now()
        where address = ${sender}`;
      await transitionChainOperation(tx, row, 'submitted', 'submitter', null, {
        nonce,
        tx_hash: hash.toLowerCase(),
        raw_transaction: raw.toLowerCase(),
        submitted_at: new Date(),
      });
      return {
        id: row.id,
        status: 'submitted',
        kind: before.kind,
        tx_hash: hash.toLowerCase(),
        nonce: nonce.toString(),
      };
    });
  }

  /**
   * Broadcasts a signed, committed transaction exactly once. Any failure means
   * the outcome is unknown: the operation goes to status_unknown and only the
   * monitor's queries move it on. It is never broadcast again.
   */
  async broadcast(operationId: string): Promise<ChainOperationView> {
    await this.ready();
    const row = await this.db.asPlatform((tx) =>
      tx.operation.findUnique({ where: { id: operationId } }),
    );
    if (!row) throw new AppError('not_found', 'No such chain operation.');
    if (row.status !== 'submitted' || !row.raw_transaction || !row.tx_hash) {
      throw new AppError(
        'invalid_state_transition',
        `Cannot broadcast a chain operation in ${row.status}.`,
      );
    }
    let to: ChainOperationStatus = 'pending_confirmation';
    let reason: string | null = null;
    try {
      const returned = await this.rpc.sendRawTransaction(row.raw_transaction as Hex);
      if (returned.toLowerCase() !== row.tx_hash) {
        to = 'status_unknown';
        reason = 'The node returned a different transaction hash.';
      }
    } catch (error) {
      to = 'status_unknown';
      reason = `Broadcast did not confirm acceptance (${error instanceof Error ? error.name : 'error'}).`;
    }
    await this.db.asPlatform((tx) => transitionChainOperation(tx, row, to, 'submitter', reason));
    return view({ ...row, status: to });
  }

  async submit(operationId: string): Promise<ChainOperationView> {
    await this.sign(operationId);
    return this.broadcast(operationId);
  }

  /**
   * Moves open operations on by querying the chain: by receipt, by the
   * transaction in the node's pool, and by the sender's nonce. Never sends.
   */
  async monitor(limit = 100): Promise<{ checked: number; changed: number }> {
    await this.ready();
    const settings = this.config.chain as ChainSettings;
    const rows = await this.db.asPlatform((tx) =>
      tx.operation.findMany({
        where: { status: { in: OPEN }, tx_hash: { not: null } },
        orderBy: { submitted_at: 'asc' },
        take: limit,
      }),
    );
    if (rows.length === 0) return { checked: 0, changed: 0 };
    const head = await this.rpc.client.getBlockNumber();
    const policy = await this.policy();
    let changed = 0;
    for (const row of rows) {
      const hash = row.tx_hash as Hex;
      const receipt = await this.rpc.client
        .getTransactionReceipt({ hash })
        .catch((error: unknown) => {
          if (error instanceof TransactionReceiptNotFoundError) return null;
          throw error;
        });
      const status = row.status as ChainOperationStatus;
      if (receipt) {
        const confirmations = Number(head - receipt.blockNumber + 1n);
        const facts = {
          block_number: receipt.blockNumber,
          block_hash: receipt.blockHash.toLowerCase(),
          confirmations,
          gas_used: receipt.gasUsed.toString(),
          effective_gas_price: receipt.effectiveGasPrice.toString(),
          contract_address: receipt.contractAddress?.toLowerCase() ?? null,
        };
        if (receipt.status !== 'success') {
          await this.db.asPlatform((tx) =>
            transitionChainOperation(
              tx,
              row,
              'reverted',
              'monitor',
              'The transaction reverted.',
              facts,
            ),
          );
          changed += 1;
          continue;
        }
        const required = requiredConfirmations(
          policy,
          row.amount === null ? null : exactInteger(row.amount),
        );
        if (confirmations >= required) {
          await this.db.asPlatform((tx) =>
            transitionChainOperation(tx, row, 'confirmed', 'monitor', null, facts),
          );
          changed += 1;
        } else if (status !== 'pending_confirmation') {
          await this.db.asPlatform((tx) =>
            transitionChainOperation(tx, row, 'pending_confirmation', 'monitor', null, facts),
          );
          changed += 1;
        } else {
          await this.db.asPlatform((tx) =>
            tx.operation.update({ where: { id: row.id }, data: facts }),
          );
        }
        continue;
      }
      const pooled = await this.rpc.client.getTransaction({ hash }).catch((error: unknown) => {
        if (error instanceof TransactionNotFoundError) return null;
        throw error;
      });
      if (pooled) {
        if (status !== 'pending_confirmation') {
          await this.db.asPlatform((tx) =>
            transitionChainOperation(tx, row, 'pending_confirmation', 'monitor', null),
          );
          changed += 1;
        }
        continue;
      }
      const used = await this.rpc.client.getTransactionCount({
        address: getAddress(row.from_address),
        blockTag: 'latest',
      });
      const ageSeconds = row.submitted_at
        ? (Date.now() - row.submitted_at.getTime()) / 1000
        : Number.POSITIVE_INFINITY;
      if (row.nonce !== null && BigInt(used) > row.nonce) {
        await this.escalate(row, 'Its nonce was used by another transaction.');
        changed += 1;
      } else if (status === 'pending_confirmation') {
        await this.db.asPlatform((tx) =>
          transitionChainOperation(
            tx,
            row,
            'status_unknown',
            'monitor',
            'The transaction is no longer known to the node.',
          ),
        );
        changed += 1;
      } else if (ageSeconds > settings.unknownAfterSeconds) {
        await this.escalate(row, 'The transaction could not be found in time.');
        changed += 1;
      }
    }
    return { checked: rows.length, changed };
  }

  private async escalate(
    row: { id: string; tenant_id: string | null; status: string; tx_hash: string | null },
    reason: string,
  ): Promise<void> {
    await this.db.asPlatform(async (tx) => {
      await transitionChainOperation(tx, row, 'reconciliation_required', 'monitor', reason);
      await this.reconciliation.openException(tx, {
        runId: null,
        tenantId: row.tenant_id,
        type: 'chain_operation_unresolved',
        subjectType: 'chain_operation',
        subjectRef: row.id,
        detail: { tx_hash: row.tx_hash, reason },
      });
    });
  }

  // -------------------------------------------------------------------------
  // Observing inbound transfers to the sandbox wallet
  // -------------------------------------------------------------------------

  /**
   * Reads Transfer events to AORA's wallet from every token contract over one
   * bounded block range, from the stored cursor. Native USDC is recorded as
   * `observed`; anything else as `unexpected_asset`, with an exception for an
   * operator. Nothing here credits anything. Safe to run twice.
   */
  async observe(): Promise<{
    from_block: bigint;
    to_block: bigint;
    observed: number;
    caught_up: boolean;
  }> {
    const { signer } = await this.ready();
    const settings = this.config.chain as ChainSettings;
    const head = await this.rpc.client.getBlockNumber();
    if (!signer) return { from_block: head, to_block: head, observed: 0, caught_up: true };
    const wallet = signer.address;
    const range = BigInt(settings.scanBlockRange);

    const start = await this.db.asPlatform(async (tx) => {
      const configured = settings.scanStartBlock;
      const initial = configured !== null ? configured - 1n : head >= range ? head - range : -1n;
      await tx.$executeRaw`
        insert into chain.scan_cursor (name, last_block)
        values (${WALLET_INBOUND}, ${initial < 0n ? 0n : initial})
        on conflict (name) do nothing`;
      const cursor = await tx.scan_cursor.findUniqueOrThrow({ where: { name: WALLET_INBOUND } });
      return cursor.last_block;
    });
    const fromBlock = start + 1n;
    if (fromBlock > head) {
      return { from_block: fromBlock, to_block: head, observed: 0, caught_up: true };
    }
    const toBlock = fromBlock + range - 1n < head ? fromBlock + range - 1n : head;
    const logs = await this.rpc.client.getLogs({
      event: erc20Abi.find((item) => item.type === 'event' && item.name === 'Transfer') as Extract<
        (typeof erc20Abi)[number],
        { type: 'event'; name: 'Transfer' }
      >,
      args: { to: wallet },
      fromBlock,
      toBlock,
    });

    const usdc = getAddress(BASE_SEPOLIA.usdc.address);
    let observed = 0;
    await this.db.asPlatform(async (tx) => {
      const [cursor] = await tx.$queryRaw<{ last_block: bigint }[]>`
        select last_block from chain.scan_cursor where name = ${WALLET_INBOUND} for update`;
      if (cursor?.last_block !== start) return; // another run moved on
      for (const log of logs) {
        const isUsdc = getAddress(log.address) === usdc;
        const inserted = await tx.$queryRaw<{ id: string }[]>`
          insert into chain.observed_transfer
            (tx_hash, log_index, block_number, block_hash, token_address, from_address,
             to_address, amount, asset_code, status)
          values (${log.transactionHash.toLowerCase()}, ${log.logIndex}, ${log.blockNumber},
                  ${log.blockHash.toLowerCase()}, ${log.address.toLowerCase()},
                  ${(log.args.from ?? zeroAddress).toLowerCase()},
                  ${(log.args.to ?? zeroAddress).toLowerCase()},
                  ${(log.args.value ?? 0n).toString()}::numeric,
                  ${isUsdc ? BASE_SEPOLIA.usdc.assetCode : null},
                  ${isUsdc ? 'observed' : 'unexpected_asset'})
          on conflict (tx_hash, log_index) do nothing
          returning id`;
        if (inserted.length === 0) continue;
        observed += 1;
        if (!isUsdc) {
          await this.reconciliation.openException(tx, {
            runId: null,
            tenantId: null,
            type: 'unexpected_asset',
            subjectType: 'observed_transfer',
            subjectRef: `${log.transactionHash.toLowerCase()}:${String(log.logIndex)}`,
            detail: {
              token_address: log.address.toLowerCase(),
              amount: (log.args.value ?? 0n).toString(),
              note: 'Only native USDC is accepted (ADR 0005). Nothing was credited.',
            },
          });
        }
      }
      await tx.$executeRaw`
        update chain.scan_cursor set last_block = ${toBlock}, updated_at = now()
        where name = ${WALLET_INBOUND}`;
    });
    return { from_block: fromBlock, to_block: toBlock, observed, caught_up: toBlock >= head };
  }

  /**
   * Applies the confirmation policy to observed USDC transfers: `confirmed` once
   * the block is deep enough and still canonical, `dropped` if the block was
   * reorganised away and the transaction is gone.
   */
  async confirmObserved(limit = 200): Promise<{ confirmed: number; dropped: number }> {
    await this.ready();
    const rows = await this.db.asPlatform((tx) =>
      tx.observed_transfer.findMany({
        where: { status: 'observed' },
        orderBy: { block_number: 'asc' },
        take: limit,
      }),
    );
    if (rows.length === 0) return { confirmed: 0, dropped: 0 };
    const head = await this.rpc.client.getBlockNumber();
    const policy = await this.policy();
    let confirmed = 0;
    let dropped = 0;
    for (const row of rows) {
      const receipt = await this.rpc.client
        .getTransactionReceipt({ hash: row.tx_hash as Hex })
        .catch((error: unknown) => {
          if (error instanceof TransactionReceiptNotFoundError) return null;
          throw error;
        });
      const present =
        receipt?.status === 'success' &&
        receipt.logs.some(
          (log) =>
            log.logIndex === row.log_index && log.address.toLowerCase() === row.token_address,
        );
      if (!receipt || !present) {
        const block =
          head >= row.block_number
            ? await this.rpc.client.getBlock({ blockNumber: row.block_number })
            : null;
        if (!block || block.hash.toLowerCase() !== row.block_hash) {
          await this.db.asPlatform((tx) =>
            tx.observed_transfer.update({ where: { id: row.id }, data: { status: 'dropped' } }),
          );
          dropped += 1;
        }
        continue;
      }
      const confirmations = Number(head - receipt.blockNumber + 1n);
      const data: Prisma.observed_transferUpdateInput = {
        block_number: receipt.blockNumber,
        block_hash: receipt.blockHash.toLowerCase(),
        confirmations,
      };
      if (confirmations >= requiredConfirmations(policy, exactInteger(row.amount))) {
        data.status = 'confirmed';
        data.confirmed_at = new Date();
        confirmed += 1;
      }
      await this.db.asPlatform((tx) =>
        tx.observed_transfer.update({ where: { id: row.id }, data }),
      );
    }
    return { confirmed, dropped };
  }

  private async policy(): Promise<Policy> {
    const now = new Date();
    const row = await this.db.asPlatform((tx: Tx) =>
      tx.confirmation_policy.findFirst({
        where: {
          asset_code: BASE_SEPOLIA.usdc.assetCode,
          effective_from: { lte: now },
          OR: [{ effective_to: null }, { effective_to: { gt: now } }],
        },
        orderBy: { version: 'desc' },
      }),
    );
    if (!row) throw new AppError('chain_unavailable', 'No confirmation policy is in effect.');
    return {
      min: row.min_confirmations,
      highValueThreshold: exactInteger(row.high_value_threshold),
      highValue: row.high_value_confirmations,
    };
  }
}

function requiredConfirmations(policy: Policy, amount: bigint | null): number {
  return amount !== null && amount >= policy.highValueThreshold ? policy.highValue : policy.min;
}

function view(row: {
  id: string;
  status: string;
  kind: string;
  tx_hash: string | null;
  nonce: bigint | null;
}): ChainOperationView {
  return {
    id: row.id,
    status: row.status as ChainOperationStatus,
    kind: row.kind,
    tx_hash: row.tx_hash,
    nonce: row.nonce === null ? null : row.nonce.toString(),
  };
}

function createRpc(settings: ChainSettings): ChainRpc {
  // No block-number cache: the monitor and observer must see the current head.
  const read = createPublicClient({
    cacheTime: 0,
    transport: http(settings.rpcUrl, { timeout: settings.requestTimeoutMs, retryCount: 2 }),
  });
  // A send is never retried by the transport: a retry after a lost answer is a resubmission.
  const send = createPublicClient({
    cacheTime: 0,
    transport: http(settings.rpcUrl, { timeout: settings.requestTimeoutMs, retryCount: 0 }),
  });
  return {
    client: read,
    sendRawTransaction: (raw) => send.sendRawTransaction({ serializedTransaction: raw }),
  };
}

function unavailableRpc(): ChainRpc {
  const refuse = (): never => {
    throw new AppError('chain_unavailable', 'Base Sepolia is not configured.');
  };
  return {
    get client(): PublicClient {
      return refuse();
    },
    sendRawTransaction: () => Promise.reject(new AppError('chain_unavailable', 'Not configured.')),
  };
}
