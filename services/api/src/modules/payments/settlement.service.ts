import { Inject, Injectable } from '@nestjs/common';
import { Database } from '../../platform/database.js';
import { AppError } from '../../platform/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { LedgerService } from '../ledger/ledger.service.js';

export interface SettlementView {
  readonly id: string;
  readonly currency: string;
  readonly gross_minor: string;
  readonly fee_minor: string;
  readonly net_minor: string;
  readonly collections: number;
  readonly created_at: string;
}

/**
 * Settlement in the sandbox (ADR 0021, assumption M-4): succeeded collections
 * move, net of fee, from "collections pending" to "available", one batch per
 * workspace and asset per run. A collection with an open reconciliation
 * exception is never settled. Idempotent and safe to run concurrently.
 */
@Injectable()
export class SettlementService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async run(): Promise<{ batches: number; collections: number }> {
    const groups = await this.db.asPlatform(
      (tx) => tx.$queryRaw<{ tenant_id: string; asset_code: string }[]>`
        select distinct i.tenant_id, i.asset_code from payments.payment_intent i
        where i.status = 'succeeded' and i.settlement_batch_id is null
          and i.purpose = 'collection'`,
    );
    let batches = 0;
    let collections = 0;
    for (const group of groups) {
      const settled = await this.settleGroup(group.tenant_id, group.asset_code);
      if (settled > 0) {
        batches += 1;
        collections += settled;
      }
    }
    return { batches, collections };
  }

  private async settleGroup(tenantId: string, assetCode: string): Promise<number> {
    return this.db.asPlatform(async (tx) => {
      // SKIP LOCKED: a concurrent run takes other rows or none, never the same ones.
      const rows = await tx.$queryRaw<{ id: string; amount: bigint; fee_amount: bigint }[]>`
        select i.id, i.amount, i.fee_amount from payments.payment_intent i
        where i.tenant_id = ${tenantId}::uuid and i.asset_code = ${assetCode}
          and i.status = 'succeeded' and i.settlement_batch_id is null
          -- Layaway instalments are held for the buyer, never settled to the merchant (P4-9).
          and i.purpose = 'collection'
          and not exists (
            select from payments.reconciliation_exception e
            where e.subject_ref = i.id::text and e.status = 'open')
        order by i.created_at
        for update skip locked`;
      if (rows.length === 0) return 0;
      const gross = rows.reduce((sum, row) => sum + row.amount, 0n);
      const fee = rows.reduce((sum, row) => sum + row.fee_amount, 0n);
      const batch = await tx.settlement_batch.create({
        data: {
          tenant_id: tenantId,
          asset_code: assetCode,
          gross_amount: gross,
          fee_amount: fee,
          net_amount: gross - fee,
          intent_count: rows.length,
        },
      });
      if (gross - fee > 0n) {
        await this.ledger.post(tx, {
          idempotencyKey: `settlement_batch:${batch.id}`,
          tenantId,
          entryType: 'settlement',
          operationType: 'settlement_batch',
          operationId: batch.id,
          postings: [
            {
              accountId: await this.ledger.findAccount(tx, {
                tenantId,
                type: 'merchant_collections_pending',
                assetCode,
              }),
              direction: 'debit',
              amount: gross - fee,
            },
            {
              accountId: await this.ledger.findAccount(tx, {
                tenantId,
                type: 'merchant_available',
                assetCode,
              }),
              direction: 'credit',
              amount: gross - fee,
            },
          ],
        });
      }
      await tx.payment_intent.updateMany({
        where: { id: { in: rows.map((row) => row.id) }, settlement_batch_id: null },
        data: { settlement_batch_id: batch.id },
      });
      await this.audit.record(tx, {
        tenantId,
        actorKind: 'system',
        action: 'payments.settlement.batch_created',
        subjectType: 'settlement_batch',
        subjectId: batch.id,
        outcome: 'success',
        detail: { collections: rows.length, net_minor: (gross - fee).toString() },
      });
      return rows.length;
    });
  }

  async list(tenantId: string): Promise<SettlementView[]> {
    const rows = await this.db.withTenant(tenantId, (tx) =>
      tx.settlement_batch.findMany({ orderBy: { created_at: 'desc' }, take: 100 }),
    );
    return rows.map((row) => ({
      id: row.id,
      currency: row.asset_code,
      gross_minor: row.gross_amount.toString(),
      fee_minor: row.fee_amount.toString(),
      net_minor: row.net_amount.toString(),
      collections: row.intent_count,
      created_at: row.created_at.toISOString(),
    }));
  }
}

export function assertWholeAmount(amount: bigint, exponent: number): void {
  if (amount % 10n ** BigInt(exponent) !== 0n) {
    throw new AppError('invalid_request', 'M-Pesa amounts are whole shillings.');
  }
}
