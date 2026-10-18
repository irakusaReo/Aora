import { Injectable } from '@nestjs/common';
import type { Tx } from '../../platform/database.js';

export type Direction = 'debit' | 'credit';
export type AccountType =
  | 'provider_clearing'
  | 'merchant_collections_pending'
  | 'fee_revenue'
  | 'merchant_available'
  | 'merchant_payouts_in_flight'
  | 'provider_payout_float'
  | 'kelo_layaway_funds_held'
  | 'kelo_fee_revenue'
  | 'kelo_refunds_payable'
  | 'chain_wallet_usdc'
  | 'platform_usdc_funding'
  | 'merchant_usdc_available'
  | 'merchant_usdc_withdrawals_in_flight'
  | 'nam_vault_usdc'
  | 'nam_vault_rounding'
  | 'merchant_nam_funding_pending'
  | 'merchant_nam_holding';

/** The closed list of account types and their fixed properties (ADR 0003). */
const CHART: Record<AccountType, { normalSide: Direction; allowNegative: boolean }> = {
  // Money the provider holds for AORA: an asset.
  provider_clearing: { normalSide: 'debit', allowNegative: false },
  // Collected for the merchant and not yet settled: a liability.
  merchant_collections_pending: { normalSide: 'credit', allowNegative: false },
  // AORA's own fees, earned when a collection or payout succeeds: income.
  fee_revenue: { normalSide: 'credit', allowNegative: false },
  // Settled to the merchant and free to pay out: a liability.
  merchant_available: { normalSide: 'credit', allowNegative: false },
  // Reserved for payouts that have been requested and not yet resolved: a liability.
  merchant_payouts_in_flight: { normalSide: 'credit', allowNegative: false },
  // A provider's disbursement float, funded outside the ledger in the sandbox (M-4):
  // below zero means float used, not an overdraft.
  provider_payout_float: { normalSide: 'debit', allowNegative: true },
  // KELO (ADR 0017). Layaway payments held for the buyer until fulfilment: a liability.
  kelo_layaway_funds_held: { normalSide: 'credit', allowNegative: false },
  // KELO's merchant discount fees and retained cancellation fees: income.
  kelo_fee_revenue: { normalSide: 'credit', allowNegative: false },
  // Owed back to buyers who cancelled, until the refund is paid: a liability.
  kelo_refunds_payable: { normalSide: 'credit', allowNegative: false },
  // USDC on Base Sepolia (phase 5C). Held in AORA's sandbox wallet: an asset.
  chain_wallet_usdc: { normalSide: 'debit', allowNegative: false },
  // AORA's own sandbox funding of that wallet (faucet USDC an operator attributes).
  platform_usdc_funding: { normalSide: 'credit', allowNegative: false },
  // A workspace's USDC claim, free to withdraw: a liability.
  merchant_usdc_available: { normalSide: 'credit', allowNegative: false },
  // Reserved for withdrawals requested and not yet resolved: a liability.
  merchant_usdc_withdrawals_in_flight: { normalSide: 'credit', allowNegative: false },
  // NAM (phase 6). USDC AORA's wallet has deposited in the vault, at accounted value: an asset.
  nam_vault_usdc: { normalSide: 'debit', allowNegative: false },
  // Rounding between holders' cost and what the vault returns; may go below zero.
  nam_vault_rounding: { normalSide: 'credit', allowNegative: true },
  // Reserved for a NAM order not yet confirmed: a liability.
  merchant_nam_funding_pending: { normalSide: 'credit', allowNegative: false },
  // The workspace's principal in the vault, at cost: a liability.
  merchant_nam_holding: { normalSide: 'credit', allowNegative: false },
};

export interface PostingInput {
  readonly accountId: string;
  readonly direction: Direction;
  readonly amount: bigint;
}

export interface EntryInput {
  /** Identifies this entry for ever. Posting the same key again returns the original. */
  readonly idempotencyKey: string;
  readonly tenantId: string | null;
  readonly entryType: string;
  readonly operationType: string;
  readonly operationId: string;
  readonly postings: readonly PostingInput[];
}

export class LedgerError extends Error {}

/**
 * The only code that writes the ledger. The database enforces balance,
 * immutability and tenant rules; this service adds idempotency and a small,
 * typed surface. Corrections are compensating entries (`reverse`), never edits.
 */
@Injectable()
export class LedgerService {
  async openAccount(
    tx: Tx,
    input: { tenantId: string | null; type: AccountType; assetCode: string; qualifier?: string },
  ): Promise<string> {
    const chart = CHART[input.type];
    const account = await tx.account.create({
      data: {
        tenant_id: input.tenantId,
        type: input.type,
        asset_code: input.assetCode,
        qualifier: input.qualifier ?? '',
        normal_side: chart.normalSide,
        allow_negative: chart.allowNegative,
      },
    });
    return account.id;
  }

  /** The accounts every new workspace needs before it can collect. */
  async openWorkspaceAccounts(tx: Tx, tenantId: string): Promise<void> {
    for (const type of [
      'merchant_collections_pending',
      'merchant_available',
      'merchant_payouts_in_flight',
    ] as const) {
      await this.openAccount(tx, { tenantId, type, assetCode: 'KES' });
    }
    for (const type of [
      'merchant_usdc_available',
      'merchant_usdc_withdrawals_in_flight',
      'merchant_nam_funding_pending',
      'merchant_nam_holding',
    ] as const) {
      await this.openAccount(tx, { tenantId, type, assetCode: 'USDC' });
    }
  }

  async findAccount(
    tx: Tx,
    input: { tenantId: string | null; type: AccountType; assetCode: string; qualifier?: string },
  ): Promise<string> {
    const account = await tx.account.findFirst({
      where: {
        tenant_id: input.tenantId,
        type: input.type,
        asset_code: input.assetCode,
        qualifier: input.qualifier ?? '',
      },
    });
    if (!account) throw new LedgerError(`No ${input.type} account for ${input.assetCode}.`);
    return account.id;
  }

  async post(tx: Tx, input: EntryInput): Promise<{ entryId: string; created: boolean }> {
    return this.write(tx, input, null);
  }

  /** Posts the mirror image of an entry and links the two. An entry can be reversed once. */
  async reverse(
    tx: Tx,
    entryId: string,
    idempotencyKey: string,
  ): Promise<{ entryId: string; created: boolean }> {
    const original = await tx.journal_entry.findUnique({
      where: { id: entryId },
      include: { posting: true },
    });
    if (!original) throw new LedgerError('Entry to reverse was not found.');
    if (original.reverses_entry_id) throw new LedgerError('A reversal cannot itself be reversed.');
    return this.write(
      tx,
      {
        idempotencyKey,
        tenantId: original.tenant_id,
        entryType: `${original.entry_type}.reversal`,
        operationType: original.operation_type,
        operationId: original.operation_id,
        postings: original.posting.map((row) => ({
          accountId: row.account_id,
          direction: row.direction === 'debit' ? 'credit' : 'debit',
          amount: row.amount,
        })),
      },
      original.id,
    );
  }

  async balanceOf(tx: Tx, accountId: string): Promise<bigint> {
    const row = await tx.account_balance.findUnique({ where: { account_id: accountId } });
    return row?.balance ?? 0n;
  }

  async findEntryByKey(tx: Tx, idempotencyKey: string): Promise<{ id: string } | null> {
    return tx.journal_entry.findUnique({
      where: { idempotency_key: idempotencyKey },
      select: { id: true },
    });
  }

  private async write(
    tx: Tx,
    input: EntryInput,
    reversesEntryId: string | null,
  ): Promise<{ entryId: string; created: boolean }> {
    for (const posting of input.postings) {
      if (typeof posting.amount !== 'bigint') {
        throw new LedgerError('Posting amounts must be bigint minor units.');
      }
    }
    // ON CONFLICT DO NOTHING waits for a concurrent insert of the same key to finish,
    // so two racing posts of one key produce exactly one entry.
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      insert into ledger.journal_entry
        (tenant_id, idempotency_key, entry_type, operation_type, operation_id, reverses_entry_id)
      values (${input.tenantId}::uuid, ${input.idempotencyKey}, ${input.entryType},
              ${input.operationType}, ${input.operationId}, ${reversesEntryId}::uuid)
      on conflict (idempotency_key) do nothing
      returning id`;
    const entry = inserted[0];
    if (!entry) {
      const existing = await tx.journal_entry.findUniqueOrThrow({
        where: { idempotency_key: input.idempotencyKey },
      });
      if (
        existing.operation_type !== input.operationType ||
        existing.operation_id !== input.operationId ||
        existing.entry_type !== input.entryType
      ) {
        throw new LedgerError('Idempotency key was already used for a different entry.');
      }
      return { entryId: existing.id, created: false };
    }

    const accounts = await tx.account.findMany({
      where: { id: { in: input.postings.map((posting) => posting.accountId) } },
      select: { id: true, asset_code: true },
    });
    const assetOf = new Map(accounts.map((account) => [account.id, account.asset_code]));
    // A stable account order keeps concurrent entries from deadlocking on balances.
    const ordered = [...input.postings].sort((a, b) => a.accountId.localeCompare(b.accountId));
    for (const posting of ordered) {
      const asset = assetOf.get(posting.accountId);
      if (!asset) throw new LedgerError('Posting refers to an unknown account.');
      await tx.posting.create({
        data: {
          entry_id: entry.id,
          account_id: posting.accountId,
          tenant_id: input.tenantId,
          direction: posting.direction,
          amount: posting.amount,
          asset_code: asset,
        },
      });
    }
    return { entryId: entry.id, created: true };
  }
}
