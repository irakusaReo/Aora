import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { APP_CONFIG, type AppConfig } from '../../platform/config.js';
import { Database, type Tx } from '../../platform/database.js';
import { AppError } from '../../platform/errors.js';
import { SANDBOX_PROVIDER } from '../../seed-data.js';
import { AuditService } from '../audit/audit.service.js';
import type { SettlementLine } from './adapter.js';
import { SimulatorProvider } from './simulator.js';

export type ExceptionType =
  | 'missing_internal'
  | 'missing_at_provider'
  | 'amount_mismatch'
  | 'duplicate_reference'
  | 'state_mismatch'
  | 'stuck_status_unknown'
  | 'ledger_mismatch'
  | 'provider_result_conflict'
  | 'unexpected_asset'
  | 'chain_operation_unresolved'
  | 'unattributed_deposit'
  | 'chain_balance_mismatch'
  | 'chain_operation_mismatch'
  | 'anchor_mismatch'
  | 'nam_mismatch';

export interface ExceptionInput {
  readonly runId: string | null;
  readonly tenantId: string | null;
  readonly type: ExceptionType;
  readonly subjectType: string;
  readonly subjectRef: string;
  readonly detail: Prisma.InputJsonObject;
}

export interface ExceptionView {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly workspace_id: string | null;
  readonly subject_type: string;
  readonly subject_ref: string;
  readonly detail: Prisma.JsonValue;
  readonly run_id: string | null;
  readonly created_at: string;
  readonly resolution: string | null;
  readonly resolution_reason: string | null;
  readonly resolved_by: string | null;
  readonly resolved_at: string | null;
}

export type Resolution = 'corrected' | 'accepted' | 'false_positive';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Compares the provider's settlement report with payment intents and the
 * ledger, and records every difference as an exception for an operator.
 * It never changes an intent, a balance or a journal entry.
 */
@Injectable()
export class ReconciliationService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SimulatorProvider) private readonly provider: SimulatorProvider,
  ) {}

  /** Opens an exception unless the same one is already open. Returns true if it is new. */
  async openException(tx: Tx, input: ExceptionInput): Promise<boolean> {
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      insert into payments.reconciliation_exception
        (run_id, tenant_id, type, subject_type, subject_ref, detail)
      values (${input.runId}::uuid, ${input.tenantId}::uuid, ${input.type}, ${input.subjectType},
              ${input.subjectRef}, ${JSON.stringify(input.detail)}::jsonb)
      on conflict (type, subject_ref) where status = 'open' do nothing
      returning id`;
    return inserted.length === 1;
  }

  async run(actor: { accountId: string | null; requestId: string }): Promise<{
    run_id: string;
    lines_checked: number;
    intents_checked: number;
    exceptions_opened: number;
  }> {
    const report = await this.provider.fetchSettlementReport();

    return this.db.asPlatform(async (tx) => {
      const run = await tx.reconciliation_run.create({ data: { provider: SANDBOX_PROVIDER } });
      let opened = 0;
      const open = async (input: Omit<ExceptionInput, 'runId'>): Promise<void> => {
        if (await this.openException(tx, { ...input, runId: run.id })) opened += 1;
      };

      // 1. Provider report against AORA's records.
      const byRef = new Map<string, SettlementLine[]>();
      for (const line of report) {
        byRef.set(line.operationRef, [...(byRef.get(line.operationRef) ?? []), line]);
      }
      for (const [operationRef, lines] of byRef) {
        const line = lines[0];
        if (!line) continue;
        if (lines.length > 1) {
          await open({
            tenantId: null,
            type: 'duplicate_reference',
            subjectType: 'provider_transaction',
            subjectRef: line.providerReference,
            detail: { occurrences: lines.length },
          });
        }
        const intent = UUID.test(operationRef)
          ? await tx.payment_intent.findUnique({ where: { id: operationRef } })
          : null;
        if (!intent) {
          await open({
            tenantId: null,
            type: 'missing_internal',
            subjectType: 'provider_transaction',
            subjectRef: line.providerReference,
            detail: { source: 'settlement_report', amount_minor: line.amount.toString() },
          });
        } else if (intent.amount !== line.amount || intent.asset_code !== line.assetCode) {
          await open({
            tenantId: intent.tenant_id,
            type: 'amount_mismatch',
            subjectType: 'payment_intent',
            subjectRef: intent.id,
            detail: {
              reason: 'settlement_report',
              intent_amount_minor: intent.amount.toString(),
              provider_amount_minor: line.amount.toString(),
            },
          });
        } else if (intent.status !== 'succeeded') {
          await open({
            tenantId: intent.tenant_id,
            type: 'state_mismatch',
            subjectType: 'payment_intent',
            subjectRef: intent.id,
            detail: { intent_status: intent.status, provider_status: 'settled' },
          });
        }
      }

      // 2. AORA's successful intents against the report and the ledger.
      // Every provider's successes are checked against the ledger; only providers
      // with a settlement report are checked against one (Daraja has none yet).
      const succeeded = await tx.payment_intent.findMany({ where: { status: 'succeeded' } });
      for (const intent of succeeded) {
        if (intent.provider === SANDBOX_PROVIDER && !byRef.has(intent.id)) {
          await open({
            tenantId: intent.tenant_id,
            type: 'missing_at_provider',
            subjectType: 'payment_intent',
            subjectRef: intent.id,
            detail: { amount_minor: intent.amount.toString() },
          });
        }
        // Net credit to the merchant's own accounts for this intent, reversals included.
        // The merchant is owed gross minus AORA's fee. A layaway instalment is owed to
        // the buyer instead: all of it in "layaway funds held", none to the merchant.
        // A credit repayment is owed to KELO: all of it in "repayments unapplied" (P8-8).
        const kelo =
          intent.purpose === 'kelo_layaway'
            ? 'kelo_layaway_funds_held'
            : intent.purpose === 'kelo_credit'
              ? 'kelo_credit_repayments_unapplied'
              : null;
        const postings = await tx.posting.findMany({
          where: {
            journal_entry: { operation_type: 'payment_intent', operation_id: intent.id },
            account: kelo ? { tenant_id: null, type: kelo } : { tenant_id: intent.tenant_id },
          },
        });
        const credited = postings.reduce(
          (sum, posting) =>
            posting.direction === 'credit' ? sum + posting.amount : sum - posting.amount,
          0n,
        );
        const owed = intent.amount - intent.fee_amount;
        if (credited !== owed) {
          await open({
            tenantId: intent.tenant_id,
            type: 'ledger_mismatch',
            subjectType: 'payment_intent',
            subjectRef: intent.id,
            detail: {
              ledger_amount_minor: credited.toString(),
              intent_amount_minor: intent.amount.toString(),
              intent_net_minor: owed.toString(),
            },
          });
        }
      }

      // 3. Intents that have been unresolved for too long.
      const cutoff = new Date(Date.now() - this.config.payments.stuckUnknownAfterSeconds * 1000);
      const stuck = await tx.payment_intent.findMany({
        where: { status: 'status_unknown', updated_at: { lt: cutoff } },
      });
      for (const intent of stuck) {
        await open({
          tenantId: intent.tenant_id,
          type: 'stuck_status_unknown',
          subjectType: 'payment_intent',
          subjectRef: intent.id,
          detail: { since: intent.updated_at.toISOString() },
        });
      }

      const summary = {
        lines_checked: report.length,
        intents_checked: succeeded.length + stuck.length,
        exceptions_opened: opened,
      };
      await tx.reconciliation_run.update({
        where: { id: run.id },
        data: { ...summary, finished_at: new Date() },
      });
      await this.audit.record(tx, {
        actorKind: actor.accountId ? 'user' : 'system',
        actorAccountId: actor.accountId,
        action: 'payments.reconciliation.run',
        subjectType: 'reconciliation_run',
        subjectId: run.id,
        outcome: 'success',
        requestId: actor.requestId,
        detail: summary,
      });
      return { run_id: run.id, ...summary };
    });
  }

  async listExceptions(status?: 'open' | 'resolved'): Promise<ExceptionView[]> {
    const rows = await this.db.asPlatform((tx) =>
      tx.reconciliation_exception.findMany({
        ...(status ? { where: { status } } : {}),
        orderBy: { created_at: 'desc' },
        take: 200,
      }),
    );
    return rows.map(toView);
  }

  /**
   * Records an operator's judgement on an exception, with a reason. It changes
   * no intent, balance or journal entry: a correction to the books is its own
   * compensating entry, made elsewhere and referred to in the reason. If the
   * difference is still there, the next run opens the exception again.
   */
  async resolve(
    actor: { accountId: string; requestId: string },
    id: string,
    input: { resolution: Resolution; reason: string },
  ): Promise<ExceptionView> {
    return this.db.asPlatform(async (tx) => {
      const updated = await tx.reconciliation_exception.updateMany({
        where: { id, status: 'open' },
        data: {
          status: 'resolved',
          resolved_at: new Date(),
          resolved_by: actor.accountId,
          resolution: input.resolution,
          resolution_reason: input.reason,
        },
      });
      const row = await tx.reconciliation_exception.findUnique({ where: { id } });
      if (!row) throw new AppError('not_found', 'Reconciliation exception not found.');
      if (updated.count !== 1) {
        throw new AppError('invalid_state_transition', 'This exception is already resolved.');
      }
      await this.audit.record(tx, {
        tenantId: row.tenant_id,
        actorKind: 'user',
        actorAccountId: actor.accountId,
        action: 'payments.reconciliation.exception_resolved',
        subjectType: 'reconciliation_exception',
        subjectId: row.id,
        outcome: 'success',
        requestId: actor.requestId,
        detail: { type: row.type, resolution: input.resolution, reason: input.reason },
      });
      return toView(row);
    });
  }

  async getException(id: string): Promise<ExceptionView> {
    const row = UUID.test(id)
      ? await this.db.asPlatform((tx) => tx.reconciliation_exception.findUnique({ where: { id } }))
      : null;
    if (!row) throw new AppError('not_found', 'Reconciliation exception not found.');
    return toView(row);
  }
}

function toView(row: Prisma.reconciliation_exceptionGetPayload<object>): ExceptionView {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    workspace_id: row.tenant_id,
    subject_type: row.subject_type,
    subject_ref: row.subject_ref,
    detail: row.detail,
    run_id: row.run_id,
    created_at: row.created_at.toISOString(),
    resolution: row.resolution,
    resolution_reason: row.resolution_reason,
    resolved_by: row.resolved_by,
    resolved_at: row.resolved_at?.toISOString() ?? null,
  };
}
