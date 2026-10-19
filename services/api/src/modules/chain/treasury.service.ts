import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { getAddress } from 'viem';
import { Database, type Tx } from '../../platform/database.js';
import { AppError } from '../../platform/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { ReconciliationService } from '../payments/reconciliation.service.js';
import { TenancyService } from '../tenancy/tenancy.service.js';
import { exactInteger } from './amounts.js';
import { ChainService } from './chain.service.js';
import { BASE_SEPOLIA } from './config.js';

const USDC = BASE_SEPOLIA.usdc.assetCode;
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

export interface Actor {
  readonly tenantId: string;
  readonly accountId: string;
  readonly requestId: string;
}

/** Who a deposit address or withdrawal belongs to: a workspace, or one CHIWO consumer (P7-9). */
export type Owner =
  | { readonly kind: 'workspace'; readonly tenantId: string }
  | { readonly kind: 'consumer'; readonly accountId: string };

export interface PersonalUsdcView {
  readonly network: { readonly name: string; readonly label: string; readonly chain_id: number };
  /** Null when Base Sepolia is not configured here: transfers between consumers still work. */
  readonly deposit_address: string | null;
  readonly wallet_label: string;
  readonly asset: { readonly code: string; readonly decimals: number; readonly contract: string };
  readonly balances: {
    readonly available_minor: string;
    readonly withdrawals_in_flight_minor: string;
  };
  readonly addresses: AddressView[];
  readonly explorer_url: string;
  readonly note: string;
}

export interface TreasuryView {
  readonly network: { readonly name: string; readonly label: string; readonly chain_id: number };
  readonly deposit_address: string;
  readonly wallet_label: string;
  readonly asset: { readonly code: string; readonly decimals: number; readonly contract: string };
  readonly balances: {
    readonly available_minor: string;
    readonly withdrawals_in_flight_minor: string;
  };
  readonly explorer_url: string;
  readonly note: string;
}

export interface AddressView {
  readonly id: string;
  readonly address: string;
  readonly label: string | null;
  readonly status: string;
  readonly registered_at: string;
}

export interface WithdrawalView {
  readonly id: string;
  readonly amount_minor: string;
  readonly currency: string;
  readonly destination: string;
  readonly status: string;
  readonly created_by: string;
  readonly decided_by: string | null;
  readonly tx_hash: string | null;
  readonly created_at: string;
}

export interface TransferView {
  readonly direction: 'in' | 'out';
  readonly tx_hash: string | null;
  readonly amount_minor: string;
  readonly currency: string;
  readonly counterparty: string;
  readonly status: string;
  readonly at: string;
}

/**
 * KONY's USDC treasury on Base Sepolia (phase-5 plan 5C). One AORA sandbox
 * wallet holds the USDC; each workspace holds a ledger claim (P5-4). Deposits
 * are attributed by a registered sender address proved by signature (P5-5).
 * Withdrawals are requested by one member and approved by a different admin
 * (P5-9). Every balance change is a journal entry; nothing is credited before
 * the confirmation policy is met.
 */
@Injectable()
export class TreasuryService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ChainService) private readonly chain: ChainService,
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(TenancyService) private readonly tenancy: TenancyService,
    @Inject(ReconciliationService) private readonly reconciliation: ReconciliationService,
  ) {}

  async view(tenantId: string): Promise<TreasuryView> {
    const wallet = await this.chain.walletAddress();
    const [available, inFlight] = await this.db.asPlatform(async (tx) => [
      await this.balance(tx, tenantId, 'merchant_usdc_available'),
      await this.balance(tx, tenantId, 'merchant_usdc_withdrawals_in_flight'),
    ]);
    return {
      network: {
        name: BASE_SEPOLIA.network,
        label: BASE_SEPOLIA.label,
        chain_id: BASE_SEPOLIA.chainId,
      },
      deposit_address: wallet,
      wallet_label: 'AORA sandbox testnet wallet',
      asset: {
        code: USDC,
        decimals: BASE_SEPOLIA.usdc.decimals,
        contract: BASE_SEPOLIA.usdc.address,
      },
      balances: {
        available_minor: available.toString(),
        withdrawals_in_flight_minor: inFlight.toString(),
      },
      explorer_url: BASE_SEPOLIA.explorerUrl,
      note: 'SANDBOX: testnet USDC on Base Sepolia only. Deposits count only from a registered address, after confirmation.',
    };
  }

  private async balance(
    tx: Tx,
    tenantId: string,
    type: 'merchant_usdc_available' | 'merchant_usdc_withdrawals_in_flight',
  ): Promise<bigint> {
    const account = await this.ledger.findAccount(tx, { tenantId, type, assetCode: USDC });
    return this.ledger.balanceOf(tx, account);
  }

  // -------------------------------------------------------------------------
  // Deposit addresses
  // -------------------------------------------------------------------------

  /** A one-time message for the address owner to sign. It names no workspace and moves nothing. */
  createChallenge(actor: Actor): Promise<{ id: string; message: string; expires_at: string }> {
    return this.challengeFor({ kind: 'workspace', tenantId: actor.tenantId }, actor.accountId);
  }

  /** The same one-time message, for a CHIWO consumer's own address (P7-9). */
  createPersonalChallenge(
    accountId: string,
  ): Promise<{ id: string; message: string; expires_at: string }> {
    return this.challengeFor({ kind: 'consumer', accountId }, accountId);
  }

  private async challengeFor(
    owner: Owner,
    createdBy: string,
  ): Promise<{ id: string; message: string; expires_at: string }> {
    const nonce = randomBytes(16).toString('hex');
    const expires = new Date(Date.now() + CHALLENGE_TTL_MS);
    const message = [
      `AORA SANDBOX - ${BASE_SEPOLIA.label}, chain ${String(BASE_SEPOLIA.chainId)}`,
      owner.kind === 'workspace'
        ? 'Register this address to deposit testnet USDC into an AORA KONY sandbox workspace.'
        : 'Register this address as your own, for your personal AORA CHIWO sandbox account.',
      'Signing moves no funds and is not a transaction.',
      `Challenge: ${nonce}`,
      `Expires: ${expires.toISOString()}`,
    ].join('\n');
    return this.db.asPlatform(async (tx) => {
      const row = await tx.address_challenge.create({
        data: {
          ...ownerColumns(owner),
          nonce,
          message,
          created_by: createdBy,
          expires_at: expires,
        },
      });
      return { id: row.id, message, expires_at: expires.toISOString() };
    });
  }

  registerAddress(
    actor: Actor,
    input: { challengeId: string; address: string; signature: string; label: string | null },
  ): Promise<AddressView> {
    return this.registerFor(
      { kind: 'workspace', tenantId: actor.tenantId },
      { accountId: actor.accountId, requestId: actor.requestId },
      input,
    );
  }

  registerPersonalAddress(
    actor: { accountId: string; requestId: string },
    input: { challengeId: string; address: string; signature: string; label: string | null },
  ): Promise<AddressView> {
    return this.registerFor({ kind: 'consumer', accountId: actor.accountId }, actor, input);
  }

  private async registerFor(
    owner: Owner,
    actor: { accountId: string; requestId: string },
    input: { challengeId: string; address: string; signature: string; label: string | null },
  ): Promise<AddressView> {
    const challenge = await this.db.asPlatform((tx) =>
      tx.address_challenge.findFirst({
        where: { id: input.challengeId, ...ownerColumns(owner) },
      }),
    );
    if (!challenge) throw new AppError('not_found', 'Challenge not found.');
    if (!(await this.chain.verifySignature(input.address, challenge.message, input.signature))) {
      throw new AppError('invalid_signature', 'The signature does not match that address.');
    }
    const address = getAddress(input.address).toLowerCase();
    try {
      return await this.db.asPlatform(async (tx) => {
        const [locked] = await tx.$queryRaw<{ used_at: Date | null; expires_at: Date }[]>`
          select used_at, expires_at from chain.address_challenge
          where id = ${challenge.id}::uuid for update`;
        if (!locked || locked.used_at !== null || locked.expires_at.getTime() <= Date.now()) {
          throw new AppError('conflict', 'This challenge was already used or has expired.');
        }
        await tx.address_challenge.update({
          where: { id: challenge.id },
          data: { used_at: new Date() },
        });
        const row = await tx.registered_address.create({
          data: {
            ...ownerColumns(owner),
            address,
            label: input.label,
            challenge_id: challenge.id,
            registered_by: actor.accountId,
          },
        });
        await this.audit.record(tx, {
          tenantId: owner.kind === 'workspace' ? owner.tenantId : null,
          actorKind: 'user',
          actorAccountId: actor.accountId,
          action: 'chain.address.registered',
          subjectType: 'registered_address',
          subjectId: row.id,
          outcome: 'success',
          requestId: actor.requestId,
          detail: { network: BASE_SEPOLIA.network },
        });
        return addressView(row);
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (String(error).includes('registered_address_active')) {
        throw new AppError('conflict', 'That address is already registered.');
      }
      throw error;
    }
  }

  listAddresses(tenantId: string): Promise<AddressView[]> {
    return this.db.withTenant(tenantId, async (tx) =>
      (
        await tx.registered_address.findMany({
          where: { tenant_id: tenantId },
          orderBy: { registered_at: 'desc' },
        })
      ).map(addressView),
    );
  }

  async revokeAddress(actor: Actor, id: string): Promise<AddressView> {
    return this.db.asPlatform(async (tx) => {
      const row = await tx.registered_address.findFirst({
        where: { id, tenant_id: actor.tenantId },
      });
      if (!row) throw new AppError('not_found', 'Address not found.');
      if (row.status !== 'active') {
        throw new AppError('invalid_state_transition', 'That address is already revoked.');
      }
      const updated = await tx.registered_address.update({
        where: { id },
        data: { status: 'revoked', revoked_by: actor.accountId, revoked_at: new Date() },
      });
      await this.audit.record(tx, {
        tenantId: actor.tenantId,
        actorKind: 'user',
        actorAccountId: actor.accountId,
        action: 'chain.address.revoked',
        subjectType: 'registered_address',
        subjectId: id,
        outcome: 'success',
        requestId: actor.requestId,
      });
      return addressView(updated);
    });
  }

  // -------------------------------------------------------------------------
  // Deposits
  // -------------------------------------------------------------------------

  /**
   * Credits confirmed USDC deposits from addresses that were registered before
   * the deposit was observed; anything else is `unattributed` with an
   * exception. One journal entry per deposit, keyed on the observation.
   */
  async creditConfirmed(limit = 200): Promise<{ credited: number; unattributed: number }> {
    const rows = await this.db.asPlatform((tx) =>
      tx.observed_transfer.findMany({
        where: { status: 'confirmed', asset_code: USDC },
        orderBy: { block_number: 'asc' },
        take: limit,
      }),
    );
    let credited = 0;
    let unattributed = 0;
    // USDC the NAM vault returns on a redemption is AORA's own, accounted by NAM (P6-5).
    const vault = this.chain.namVault()?.toLowerCase() ?? null;
    for (const row of rows) {
      if (vault !== null && row.from_address === vault) {
        await this.db.asPlatform((tx) =>
          tx.observed_transfer.update({ where: { id: row.id }, data: { status: 'internal' } }),
        );
        continue;
      }
      await this.db.asPlatform(async (tx) => {
        const registration = await tx.registered_address.findFirst({
          where: {
            address: row.from_address,
            status: 'active',
            registered_at: { lte: row.observed_at },
          },
        });
        if (!registration) {
          await tx.observed_transfer.update({
            where: { id: row.id },
            data: { status: 'unattributed' },
          });
          await this.reconciliation.openException(tx, {
            runId: null,
            tenantId: null,
            type: 'unattributed_deposit',
            subjectType: 'observed_transfer',
            subjectRef: `${row.tx_hash}:${String(row.log_index)}`,
            detail: {
              from_address: row.from_address,
              amount: exactInteger(row.amount).toString(),
              note: 'No workspace had registered this sender before the deposit. Nothing was credited.',
            },
          });
          unattributed += 1;
          return;
        }
        const amount = exactInteger(row.amount);
        const owner = ownerOf(registration);
        const entry = await this.ledger.post(tx, {
          idempotencyKey: `observed_transfer:${row.id}:credit`,
          tenantId: registration.tenant_id,
          entryType: 'usdc_deposit_credited',
          operationType: 'observed_transfer',
          operationId: row.id,
          postings: [
            {
              accountId: await this.ledger.findAccount(tx, {
                tenantId: null,
                type: 'chain_wallet_usdc',
                assetCode: USDC,
              }),
              direction: 'debit',
              amount,
            },
            {
              accountId: await this.usdcAccount(tx, owner, 'available'),
              direction: 'credit',
              amount,
            },
          ],
        });
        await tx.observed_transfer.update({
          where: { id: row.id },
          data: {
            status: 'credited',
            tenant_id: registration.tenant_id,
            consumer_account_id: registration.consumer_account_id,
            journal_entry_id: entry.entryId,
          },
        });
        await this.audit.record(tx, {
          tenantId: registration.tenant_id,
          actorKind: 'system',
          action: 'chain.deposit.credited',
          subjectType: 'observed_transfer',
          subjectId: row.id,
          outcome: 'success',
          detail: { amount: amount.toString(), asset: USDC },
        });
        credited += 1;
      });
    }
    return { credited, unattributed };
  }

  /** Operators: inbound transfers by status, newest first. */
  opsTransfers(statuses: string[]): Promise<
    {
      id: string;
      tx_hash: string;
      token_address: string;
      from_address: string;
      amount: string;
      asset_code: string | null;
      status: string;
      workspace_id: string | null;
      observed_at: string;
    }[]
  > {
    return this.db.asPlatform(async (tx) =>
      (
        await tx.observed_transfer.findMany({
          where: { status: { in: statuses } },
          orderBy: { observed_at: 'desc' },
          take: 200,
        })
      ).map((row) => ({
        id: row.id,
        tx_hash: row.tx_hash,
        token_address: row.token_address,
        from_address: row.from_address,
        amount: exactInteger(row.amount).toString(),
        asset_code: row.asset_code,
        status: row.status,
        workspace_id: row.tenant_id,
        observed_at: row.observed_at.toISOString(),
      })),
    );
  }

  /**
   * An operator attributes an `unattributed` deposit, with an audited reason:
   * to a workspace (a deposit sent before its address was registered), or to
   * AORA's own sandbox funding (faucet USDC). One journal entry, once.
   */
  async attribute(
    actor: { accountId: string; requestId: string },
    id: string,
    input: { workspaceId: string | null; reason: string },
  ): Promise<{ id: string; status: string; attributed_to: string }> {
    return this.db.asPlatform(async (tx) => {
      const [row] = await tx.$queryRaw<
        { id: string; status: string; amount: string; asset_code: string | null }[]
      >`
        select id, status, amount::text, asset_code from chain.observed_transfer
        where id = ${id}::uuid for update`;
      if (!row) throw new AppError('not_found', 'Transfer not found.');
      if (row.status !== 'unattributed' || row.asset_code !== USDC) {
        throw new AppError(
          'conflict',
          `This transfer is ${row.status}; only unattributed USDC can be attributed.`,
        );
      }
      if (input.workspaceId) {
        const workspace = await tx.workspace.findUnique({ where: { id: input.workspaceId } });
        if (!workspace) throw new AppError('not_found', 'Workspace not found.');
      }
      const amount = BigInt(row.amount);
      const wallet = await this.ledger.findAccount(tx, {
        tenantId: null,
        type: 'chain_wallet_usdc',
        assetCode: USDC,
      });
      const counterpart = input.workspaceId
        ? await this.ledger.findAccount(tx, {
            tenantId: input.workspaceId,
            type: 'merchant_usdc_available',
            assetCode: USDC,
          })
        : await this.ledger.findAccount(tx, {
            tenantId: null,
            type: 'platform_usdc_funding',
            assetCode: USDC,
          });
      const entry = await this.ledger.post(tx, {
        idempotencyKey: `observed_transfer:${row.id}:credit`,
        tenantId: input.workspaceId,
        entryType: input.workspaceId ? 'usdc_deposit_credited' : 'usdc_sandbox_funding',
        operationType: 'observed_transfer',
        operationId: row.id,
        postings: [
          { accountId: wallet, direction: 'debit', amount },
          { accountId: counterpart, direction: 'credit', amount },
        ],
      });
      await tx.observed_transfer.update({
        where: { id: row.id },
        data: { status: 'credited', tenant_id: input.workspaceId, journal_entry_id: entry.entryId },
      });
      await this.audit.record(tx, {
        tenantId: input.workspaceId,
        actorKind: 'user',
        actorAccountId: actor.accountId,
        action: 'chain.deposit.attributed',
        subjectType: 'observed_transfer',
        subjectId: row.id,
        outcome: 'success',
        requestId: actor.requestId,
        detail: {
          to: input.workspaceId ? 'workspace' : 'platform_funding',
          reason: input.reason,
          amount: amount.toString(),
        },
      });
      return {
        id: row.id,
        status: 'credited',
        attributed_to: input.workspaceId ?? 'platform_funding',
      };
    });
  }

  // -------------------------------------------------------------------------
  // Withdrawals
  // -------------------------------------------------------------------------

  async createWithdrawal(
    actor: Actor,
    input: { idempotencyKey: string; amount: bigint; destination: string },
  ): Promise<{ withdrawal: WithdrawalView; replayed: boolean }> {
    const destination = (await this.chain.assertDestination(input.destination)).toLowerCase();
    const requestHash = createHash('sha256')
      .update(`${input.amount.toString()}|${destination}`)
      .digest('hex');
    try {
      return await this.db.asPlatform(async (tx) => {
        const existing = await tx.withdrawal.findUnique({
          where: {
            tenant_id_idempotency_key: {
              tenant_id: actor.tenantId,
              idempotency_key: input.idempotencyKey,
            },
          },
        });
        if (existing) {
          if (existing.request_hash !== requestHash) {
            throw new AppError(
              'idempotency_key_reused',
              'This Idempotency-Key was used for a different withdrawal.',
            );
          }
          return { withdrawal: await this.withdrawalView(tx, existing), replayed: true };
        }
        const limits = await this.tenancy.limitsFor(tx, actor.tenantId, USDC);
        if (!limits || input.amount > limits.perTransactionMax) {
          throw new AppError(
            'limit_exceeded',
            'This amount is above the limit for one withdrawal.',
          );
        }
        const [today] = await tx.$queryRaw<{ total: bigint }[]>`
          select coalesce(sum(amount), 0)::bigint as total from chain.withdrawal
          where tenant_id = ${actor.tenantId}::uuid and status not in ('rejected', 'failed')
            and created_at > now() - interval '24 hours'`;
        if ((today?.total ?? 0n) + input.amount > limits.dailyPayoutMax) {
          throw new AppError(
            'limit_exceeded',
            'This withdrawal would take the workspace over its limit for 24 hours.',
          );
        }
        if ((await this.balance(tx, actor.tenantId, 'merchant_usdc_available')) < input.amount) {
          throw new AppError('insufficient_funds', 'Not enough USDC is available.');
        }
        const row = await tx.withdrawal.create({
          data: {
            tenant_id: actor.tenantId,
            idempotency_key: input.idempotencyKey,
            request_hash: requestHash,
            amount: input.amount,
            destination,
            created_by: actor.accountId,
          },
        });
        await this.move(tx, row, 'reserve');
        await this.audit.record(tx, {
          tenantId: actor.tenantId,
          actorKind: 'user',
          actorAccountId: actor.accountId,
          action: 'chain.withdrawal.requested',
          subjectType: 'withdrawal',
          subjectId: row.id,
          outcome: 'success',
          requestId: actor.requestId,
          detail: { amount: input.amount.toString(), asset: USDC },
        });
        return { withdrawal: await this.withdrawalView(tx, row), replayed: false };
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (String(error).includes('insufficient balance')) {
        throw new AppError('insufficient_funds', 'Not enough USDC is available.');
      }
      throw error;
    }
  }

  listWithdrawals(tenantId: string): Promise<WithdrawalView[]> {
    return this.db.withTenant(tenantId, async (tx) => {
      const rows = await tx.withdrawal.findMany({
        where: { tenant_id: tenantId },
        orderBy: { created_at: 'desc' },
        take: 100,
      });
      return Promise.all(rows.map((row) => this.withdrawalView(tx, row)));
    });
  }

  /** A different admin approves; the transaction is then signed and broadcast once. */
  async approve(actor: Actor, id: string): Promise<WithdrawalView> {
    await this.db.asPlatform(async (tx) => {
      const [row] = await tx.$queryRaw<{ id: string; status: string; created_by: string }[]>`
        select id, status, created_by from chain.withdrawal
        where id = ${id}::uuid and tenant_id = ${actor.tenantId}::uuid for update`;
      if (!row) throw new AppError('not_found', 'Withdrawal not found.');
      if (row.created_by === actor.accountId) {
        throw new AppError('forbidden', 'The person who requested a withdrawal cannot approve it.');
      }
      if (row.status !== 'requested') {
        throw new AppError('invalid_state_transition', `This withdrawal is ${row.status}.`);
      }
      await tx.withdrawal.update({
        where: { id },
        data: { status: 'submitted', decided_by: actor.accountId, decided_at: new Date() },
      });
      await this.audit.record(tx, {
        tenantId: actor.tenantId,
        actorKind: 'user',
        actorAccountId: actor.accountId,
        action: 'chain.withdrawal.approved',
        subjectType: 'withdrawal',
        subjectId: id,
        outcome: 'success',
        requestId: actor.requestId,
      });
    });
    await this.send(id);
    return this.db.asPlatform(async (tx) =>
      this.withdrawalView(tx, await tx.withdrawal.findUniqueOrThrow({ where: { id } })),
    );
  }

  async reject(actor: Actor, id: string, reason: string): Promise<WithdrawalView> {
    return this.db.asPlatform(async (tx) => {
      const [row] = await tx.$queryRaw<{ id: string; status: string }[]>`
        select id, status from chain.withdrawal
        where id = ${id}::uuid and tenant_id = ${actor.tenantId}::uuid for update`;
      if (!row) throw new AppError('not_found', 'Withdrawal not found.');
      if (row.status !== 'requested') {
        throw new AppError('invalid_state_transition', `This withdrawal is ${row.status}.`);
      }
      const updated = await tx.withdrawal.update({
        where: { id },
        data: {
          status: 'rejected',
          decided_by: actor.accountId,
          decided_at: new Date(),
          decision_reason: reason,
        },
      });
      await this.move(tx, updated, 'release');
      await this.audit.record(tx, {
        tenantId: actor.tenantId,
        actorKind: 'user',
        actorAccountId: actor.accountId,
        action: 'chain.withdrawal.rejected',
        subjectType: 'withdrawal',
        subjectId: id,
        outcome: 'success',
        requestId: actor.requestId,
      });
      return this.withdrawalView(tx, updated);
    });
  }

  /**
   * Prepares (idempotently) and submits the chain operation of an approved
   * withdrawal. Safe to call again: a prepared operation was never signed; a
   * signed one is never signed or sent twice (ChainService).
   */
  private async send(id: string): Promise<void> {
    const row = await this.db.asPlatform((tx) =>
      tx.withdrawal.findUniqueOrThrow({ where: { id } }),
    );
    const operation = await this.chain.prepareUsdcTransfer({
      idempotencyKey: `withdrawal:${row.id}`,
      tenantId: row.tenant_id,
      recipient: getAddress(row.destination),
      amount: row.amount,
    });
    if (row.operation_id === null) {
      await this.db.asPlatform((tx) =>
        tx.withdrawal.update({ where: { id }, data: { operation_id: operation.id } }),
      );
    }
    if (operation.status === 'prepared') await this.chain.submit(operation.id);
  }

  /**
   * Resolves submitted withdrawals from their chain operation: `completed` with
   * the funds leaving the wallet once confirmed; `failed` with the reserve
   * released if the transaction reverted or failed; `reconciliation_required`
   * (funds stay reserved) when only a person can tell.
   */
  async settleWithdrawals(limit = 100): Promise<{ completed: number; failed: number }> {
    const rows = await this.db.asPlatform((tx) =>
      tx.withdrawal.findMany({ where: { status: 'submitted' }, take: limit }),
    );
    let completed = 0;
    let failed = 0;
    for (const row of rows) {
      const operation = row.operation_id
        ? await this.db.asPlatform((tx) =>
            tx.operation.findUnique({ where: { id: row.operation_id ?? '' } }),
          )
        : null;
      if (!operation || operation.status === 'prepared') {
        await this.send(row.id).catch(() => undefined); // retried on the next run
        continue;
      }
      const outcome =
        operation.status === 'confirmed'
          ? 'completed'
          : operation.status === 'reverted' || operation.status === 'failed'
            ? 'failed'
            : operation.status === 'reconciliation_required'
              ? 'reconciliation_required'
              : null;
      if (!outcome) continue;
      await this.db.asPlatform(async (tx) => {
        const updated = await tx.withdrawal.updateMany({
          where: { id: row.id, status: 'submitted' },
          data: { status: outcome },
        });
        if (updated.count !== 1) return;
        if (outcome === 'completed') await this.move(tx, row, 'send');
        if (outcome === 'failed') await this.move(tx, row, 'release');
        await this.audit.record(tx, {
          tenantId: row.tenant_id,
          actorKind: 'system',
          action: `chain.withdrawal.${outcome}`,
          subjectType: 'withdrawal',
          subjectId: row.id,
          outcome: outcome === 'completed' ? 'success' : 'failure',
        });
      });
      if (outcome === 'completed') completed += 1;
      if (outcome === 'failed') failed += 1;
    }
    return { completed, failed };
  }

  /** The three ledger movements of a withdrawal, each keyed so it posts once. */
  private async move(
    tx: Tx,
    row: {
      id: string;
      tenant_id: string | null;
      consumer_account_id: string | null;
      amount: bigint;
    },
    kind: 'reserve' | 'release' | 'send',
  ): Promise<void> {
    const owner = ownerOf(row);
    const inFlight = await this.usdcAccount(tx, owner, 'in_flight');
    const other =
      kind === 'send'
        ? await this.ledger.findAccount(tx, {
            tenantId: null,
            type: 'chain_wallet_usdc',
            assetCode: USDC,
          })
        : await this.usdcAccount(tx, owner, 'available');
    const postings =
      kind === 'reserve'
        ? [
            { accountId: other, direction: 'debit' as const, amount: row.amount },
            { accountId: inFlight, direction: 'credit' as const, amount: row.amount },
          ]
        : [
            { accountId: inFlight, direction: 'debit' as const, amount: row.amount },
            { accountId: other, direction: 'credit' as const, amount: row.amount },
          ];
    await this.ledger.post(tx, {
      idempotencyKey: `withdrawal:${row.id}:${kind}`,
      tenantId: row.tenant_id,
      entryType: `usdc_withdrawal_${kind === 'send' ? 'sent' : kind === 'reserve' ? 'reserved' : 'released'}`,
      operationType: 'withdrawal',
      operationId: row.id,
      postings,
    });
  }

  /** A workspace's or a consumer's USDC account: kept apart by type (rule 5). */
  private usdcAccount(tx: Tx, owner: Owner, which: 'available' | 'in_flight'): Promise<string> {
    if (owner.kind === 'consumer') {
      return this.ledger.consumerAccount(tx, {
        accountId: owner.accountId,
        type:
          which === 'available' ? 'consumer_usdc_available' : 'consumer_usdc_withdrawals_in_flight',
        assetCode: USDC,
      });
    }
    return this.ledger.findAccount(tx, {
      tenantId: owner.tenantId,
      type:
        which === 'available' ? 'merchant_usdc_available' : 'merchant_usdc_withdrawals_in_flight',
      assetCode: USDC,
    });
  }

  // -------------------------------------------------------------------------
  // CHIWO: personal USDC (phase-7 P7-8, P7-9, P7-11)
  // -------------------------------------------------------------------------

  async personalView(accountId: string): Promise<PersonalUsdcView> {
    let wallet: string | null = null;
    try {
      wallet = await this.chain.walletAddress();
    } catch (error) {
      if (!(error instanceof AppError && error.code === 'chain_unavailable')) throw error;
    }
    const owner: Owner = { kind: 'consumer', accountId };
    const [available, inFlight, addresses] = await this.db.asPlatform(
      async (tx) =>
        [
          await this.ledger.balanceOf(tx, await this.usdcAccount(tx, owner, 'available')),
          await this.ledger.balanceOf(tx, await this.usdcAccount(tx, owner, 'in_flight')),
          await tx.registered_address.findMany({
            where: { consumer_account_id: accountId, status: 'active' },
            orderBy: { registered_at: 'desc' },
          }),
        ] as const,
    );
    return {
      network: {
        name: BASE_SEPOLIA.network,
        label: BASE_SEPOLIA.label,
        chain_id: BASE_SEPOLIA.chainId,
      },
      deposit_address: wallet,
      wallet_label: 'AORA sandbox testnet wallet',
      asset: {
        code: USDC,
        decimals: BASE_SEPOLIA.usdc.decimals,
        contract: BASE_SEPOLIA.usdc.address,
      },
      balances: {
        available_minor: available.toString(),
        withdrawals_in_flight_minor: inFlight.toString(),
      },
      addresses: addresses.map(addressView),
      explorer_url: BASE_SEPOLIA.explorerUrl,
      note: 'SANDBOX: testnet USDC on Base Sepolia only. Deposits count only from your registered address, after confirmation.',
    };
  }

  /**
   * An on-chain withdrawal to the consumer's own registered address (P7-11):
   * reserved, then signed and sent once. No second approver: a person acts for
   * themself. The caller (CHIWO) supplies its limits, which are its data.
   */
  async createPersonalWithdrawal(
    actor: { accountId: string; requestId: string },
    input: {
      idempotencyKey: string;
      amount: bigint;
      addressId: string;
      limits: { perTransactionMax: bigint; perDayMax: bigint };
    },
  ): Promise<{ withdrawal: WithdrawalView; replayed: boolean }> {
    const requestHash = createHash('sha256')
      .update(`${input.amount.toString()}|${input.addressId}`)
      .digest('hex');
    const result = await this.db.asPlatform(async (tx) => {
      await tx.$queryRaw`
        select id from identity.user_account where id = ${actor.accountId}::uuid for update`;
      const existing = await tx.withdrawal.findUnique({
        where: {
          consumer_account_id_idempotency_key: {
            consumer_account_id: actor.accountId,
            idempotency_key: input.idempotencyKey,
          },
        },
      });
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new AppError(
            'idempotency_key_reused',
            'This Idempotency-Key was used for a different withdrawal.',
          );
        }
        return { row: existing, replayed: true };
      }
      const address = await tx.registered_address.findFirst({
        where: { id: input.addressId, consumer_account_id: actor.accountId, status: 'active' },
      });
      if (!address) throw new AppError('not_found', 'Address not found.');
      if (input.amount > input.limits.perTransactionMax) {
        throw new AppError('limit_exceeded', 'This amount is above the limit for one withdrawal.');
      }
      const [today] = await tx.$queryRaw<{ total: bigint }[]>`
        select coalesce(sum(amount), 0)::bigint as total from chain.withdrawal
        where consumer_account_id = ${actor.accountId}::uuid and status not in ('rejected', 'failed')
          and created_at > now() - interval '24 hours'`;
      if ((today?.total ?? 0n) + input.amount > input.limits.perDayMax) {
        throw new AppError(
          'limit_exceeded',
          'This withdrawal would take you over your daily limit.',
        );
      }
      const owner: Owner = { kind: 'consumer', accountId: actor.accountId };
      const available = await this.ledger.balanceOf(
        tx,
        await this.usdcAccount(tx, owner, 'available'),
      );
      if (available < input.amount) {
        throw new AppError('insufficient_funds', 'Not enough USDC is available.');
      }
      const destination = (await this.chain.assertDestination(address.address)).toLowerCase();
      const created = await tx.withdrawal.create({
        data: {
          consumer_account_id: actor.accountId,
          idempotency_key: input.idempotencyKey,
          request_hash: requestHash,
          amount: input.amount,
          destination,
          created_by: actor.accountId,
        },
      });
      await this.move(tx, created, 'reserve');
      const row = await tx.withdrawal.update({
        where: { id: created.id },
        data: { status: 'submitted' },
      });
      await this.audit.record(tx, {
        tenantId: null,
        actorKind: 'user',
        actorAccountId: actor.accountId,
        action: 'chain.withdrawal.requested',
        subjectType: 'withdrawal',
        subjectId: row.id,
        outcome: 'success',
        requestId: actor.requestId,
        detail: { amount: input.amount.toString(), asset: USDC, owner: 'consumer' },
      });
      return { row, replayed: false };
    });
    if (result.row.status === 'submitted' && result.row.operation_id === null) {
      // Sent once; a failure here leaves it submitted for the chain job to retry the send.
      await this.send(result.row.id).catch(() => undefined);
    }
    return {
      withdrawal: await this.db.asPlatform(async (tx) =>
        this.withdrawalView(
          tx,
          await tx.withdrawal.findUniqueOrThrow({ where: { id: result.row.id } }),
        ),
      ),
      replayed: result.replayed,
    };
  }

  async personalWithdrawal(accountId: string, id: string): Promise<WithdrawalView> {
    return this.db.withConsumer(accountId, async (tx) => {
      const row = await tx.withdrawal.findFirst({ where: { id, consumer_account_id: accountId } });
      if (!row) throw new AppError('not_found', 'Withdrawal not found.');
      return this.withdrawalView(tx, row);
    });
  }

  /** The consumer's credited deposits and withdrawals, newest first, for CHIWO's activity. */
  personalTransfers(accountId: string): Promise<(TransferView & { id: string })[]> {
    return this.db.asPlatform(async (tx) => {
      const inbound = await tx.observed_transfer.findMany({
        where: { consumer_account_id: accountId, status: 'credited' },
        orderBy: { observed_at: 'desc' },
        take: 100,
      });
      const outbound = await tx.withdrawal.findMany({
        where: { consumer_account_id: accountId },
        orderBy: { created_at: 'desc' },
        take: 100,
      });
      const views: (TransferView & { id: string })[] = inbound.map((row) => ({
        id: row.id,
        direction: 'in',
        tx_hash: row.tx_hash,
        amount_minor: exactInteger(row.amount).toString(),
        currency: USDC,
        counterparty: getAddress(row.from_address),
        status: row.status,
        at: row.observed_at.toISOString(),
      }));
      for (const row of outbound) {
        const view = await this.withdrawalView(tx, row);
        views.push({
          id: row.id,
          direction: 'out',
          tx_hash: view.tx_hash,
          amount_minor: view.amount_minor,
          currency: USDC,
          counterparty: view.destination,
          status: view.status,
          at: view.created_at,
        });
      }
      return views.sort((a, b) => b.at.localeCompare(a.at));
    });
  }

  private async withdrawalView(
    tx: Tx,
    row: {
      id: string;
      amount: bigint;
      asset_code: string;
      destination: string;
      status: string;
      created_by: string;
      decided_by: string | null;
      operation_id: string | null;
      created_at: Date;
    },
  ): Promise<WithdrawalView> {
    const operation = row.operation_id
      ? await tx.operation.findUnique({ where: { id: row.operation_id } })
      : null;
    return {
      id: row.id,
      amount_minor: row.amount.toString(),
      currency: row.asset_code,
      destination: getAddress(row.destination),
      status: row.status,
      created_by: row.created_by,
      decided_by: row.decided_by,
      tx_hash: operation?.tx_hash ?? null,
      created_at: row.created_at.toISOString(),
    };
  }

  /** Deposits credited to the workspace and its withdrawals, newest first. */
  listTransfers(tenantId: string): Promise<TransferView[]> {
    return this.db.withTenant(tenantId, async (tx) => {
      const inbound = await tx.observed_transfer.findMany({
        where: { tenant_id: tenantId },
        orderBy: { observed_at: 'desc' },
        take: 100,
      });
      const outbound = await tx.withdrawal.findMany({
        where: { tenant_id: tenantId, status: { in: ['submitted', 'completed', 'failed'] } },
        orderBy: { created_at: 'desc' },
        take: 100,
      });
      const views: TransferView[] = inbound.map((row) => ({
        direction: 'in',
        tx_hash: row.tx_hash,
        amount_minor: exactInteger(row.amount).toString(),
        currency: USDC,
        counterparty: getAddress(row.from_address),
        status: row.status,
        at: row.observed_at.toISOString(),
      }));
      for (const row of outbound) {
        const view = await this.withdrawalView(tx, row);
        views.push({
          direction: 'out',
          tx_hash: view.tx_hash,
          amount_minor: view.amount_minor,
          currency: USDC,
          counterparty: view.destination,
          status: view.status,
          at: view.created_at,
        });
      }
      return views.sort((a, b) => b.at.localeCompare(a.at));
    });
  }
}

function ownerColumns(owner: Owner): { tenant_id?: string; consumer_account_id?: string } {
  return owner.kind === 'workspace'
    ? { tenant_id: owner.tenantId }
    : { consumer_account_id: owner.accountId };
}

function ownerOf(row: { tenant_id: string | null; consumer_account_id: string | null }): Owner {
  if (row.tenant_id) return { kind: 'workspace', tenantId: row.tenant_id };
  if (row.consumer_account_id) return { kind: 'consumer', accountId: row.consumer_account_id };
  throw new Error('A treasury record has no owner.');
}

function addressView(row: {
  id: string;
  address: string;
  label: string | null;
  status: string;
  registered_at: Date;
}): AddressView {
  return {
    id: row.id,
    address: getAddress(row.address),
    label: row.label,
    status: row.status,
    registered_at: row.registered_at.toISOString(),
  };
}
