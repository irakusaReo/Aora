import { createHash } from 'node:crypto';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { APP_CONFIG, type AppConfig } from '../../platform/config.js';
import { Database, type Tx } from '../../platform/database.js';
import { AppError } from '../../platform/errors.js';
import { SANDBOX_PROVIDER } from '../../seed-data.js';
import { AuditService } from '../audit/audit.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { DeveloperService } from '../developer/developer.service.js';
import { type OutboxEvent, OutboxService } from '../outbox/outbox.service.js';
import { type OperationStatus, transitionOperation } from './operations.js';
import { ReconciliationService } from './reconciliation.service.js';
import { SimulatorProvider } from './simulator.js';

export const EVENT_REFUND_SUBMIT = 'payments.refund.submit';
export const EVENT_REFUND_INQUIRY = 'payments.refund.status_inquiry';

type Refund = Prisma.refundGetPayload<object>;

export interface RefundView {
  readonly id: string;
  readonly status: OperationStatus;
  readonly payment_intent_id: string;
  readonly amount_minor: string;
  readonly currency: string;
  readonly provider: string;
  readonly failure_code: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

function view(row: Refund): RefundView {
  return {
    id: row.id,
    status: row.status as OperationStatus,
    payment_intent_id: row.intent_id,
    amount_minor: row.amount.toString(),
    currency: row.asset_code,
    provider: row.provider,
    failure_code: row.failure_code,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

const reservationKey = (id: string): string => `refund:${id}:reservation`;

/**
 * Refunds of a succeeded collection (journey J6). The total refunded can never
 * exceed the collection (enforced by the database, under concurrency). The
 * merchant's money is reserved when the refund is created and leaves when the
 * provider confirms; a failed refund gives it back with a compensating entry.
 * The sandbox refund tariff charges nothing and keeps the original fee (ADR 0021).
 * Daraja collections cannot be refunded in Phase 3 (docs/providers/daraja.md).
 */
@Injectable()
export class RefundsService implements OnModuleInit {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SimulatorProvider) private readonly simulator: SimulatorProvider,
    @Inject(ReconciliationService) private readonly reconciliation: ReconciliationService,
    @Inject(DeveloperService) private readonly developer: DeveloperService,
  ) {}

  onModuleInit(): void {
    this.outbox.register(EVENT_REFUND_SUBMIT, (event) => this.handleSubmit(event));
    this.outbox.register(EVENT_REFUND_INQUIRY, (event) => this.handleInquiry(event));
  }

  async create(
    actor: { tenantId: string; accountId: string; requestId: string },
    input: { intentId: string; idempotencyKey: string; amount: bigint; scenario: string | null },
  ): Promise<{ refund: RefundView; replayed: boolean }> {
    const requestHash = createHash('sha256')
      .update(JSON.stringify([input.intentId, input.amount.toString(), input.scenario]))
      .digest('hex');
    try {
      return await this.db.asPlatform(async (tx) => {
        const earlier = await tx.refund.findFirst({
          where: { tenant_id: actor.tenantId, idempotency_key: input.idempotencyKey },
        });
        if (earlier) {
          if (earlier.request_hash !== requestHash) {
            throw new AppError(
              'idempotency_key_reused',
              'This Idempotency-Key was already used with a different request.',
            );
          }
          return { refund: view(earlier), replayed: true };
        }
        // Scoped to the caller's workspace: another tenant's collection is simply not found.
        const intent = await tx.payment_intent.findFirst({
          where: { id: input.intentId, tenant_id: actor.tenantId },
        });
        if (!intent) throw new AppError('not_found', 'Payment intent not found.');
        if (intent.status !== 'succeeded') {
          throw new AppError(
            'invalid_state_transition',
            'Only a succeeded collection can be refunded.',
          );
        }
        if (intent.provider !== SANDBOX_PROVIDER) {
          throw new AppError(
            'capability_not_supported',
            'Refunds on this rail are not available yet.',
          );
        }
        const row = await tx.refund.create({
          data: {
            tenant_id: actor.tenantId,
            idempotency_key: input.idempotencyKey,
            request_hash: requestHash,
            intent_id: intent.id,
            amount: input.amount,
            asset_code: intent.asset_code,
            provider: intent.provider,
            sandbox_scenario: input.scenario,
            created_by: actor.accountId,
          },
        });
        await tx.operation_transition.create({
          data: {
            operation_type: 'refund',
            operation_id: row.id,
            tenant_id: actor.tenantId,
            from_status: null,
            to_status: 'created',
            source: 'api',
          },
        });
        // From "available" once settled, from "collections pending" before.
        const source = await this.ledger.findAccount(tx, {
          tenantId: actor.tenantId,
          type: intent.settlement_batch_id ? 'merchant_available' : 'merchant_collections_pending',
          assetCode: intent.asset_code,
        });
        await this.ledger.post(tx, {
          idempotencyKey: reservationKey(row.id),
          tenantId: actor.tenantId,
          entryType: 'refund.reservation',
          operationType: 'refund',
          operationId: row.id,
          postings: [
            { accountId: source, direction: 'debit', amount: input.amount },
            {
              accountId: await this.ledger.findAccount(tx, {
                tenantId: actor.tenantId,
                type: 'merchant_payouts_in_flight',
                assetCode: intent.asset_code,
              }),
              direction: 'credit',
              amount: input.amount,
            },
          ],
        });
        await this.audit.record(tx, {
          tenantId: actor.tenantId,
          actorKind: 'user',
          actorAccountId: actor.accountId,
          action: 'payments.refund.created',
          subjectType: 'refund',
          subjectId: row.id,
          outcome: 'success',
          requestId: actor.requestId,
          detail: { payment_intent_id: intent.id, amount_minor: input.amount.toString() },
        });
        await this.outbox.enqueue(tx, {
          tenantId: actor.tenantId,
          type: EVENT_REFUND_SUBMIT,
          payload: { refund_id: row.id },
        });
        return { refund: view(row), replayed: false };
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      const text = String(error);
      if (text.includes('exceed the collection')) {
        throw new AppError(
          'refund_exceeds_collection',
          'Refunds cannot exceed the amount collected.',
        );
      }
      if (text.includes('insufficient balance')) {
        throw new AppError(
          'insufficient_funds',
          'There is not enough money in the workspace for this refund.',
        );
      }
      throw error;
    }
  }

  async get(tenantId: string, refundId: string): Promise<RefundView> {
    const row = await this.db.withTenant(tenantId, (tx) =>
      tx.refund.findUnique({ where: { id: refundId } }),
    );
    if (!row) throw new AppError('not_found', 'Refund not found.');
    return view(row);
  }

  private async handleSubmit(event: OutboxEvent): Promise<void> {
    const refundId = stringOf(event, 'refund_id');
    const proceed = await this.db.asPlatform(async (tx) => {
      const row = await this.lock(tx, refundId);
      if (row.status === 'created') {
        await transitionOperation(tx, this.audit, 'refund', row, 'submitting', 'adapter', null);
        return row;
      }
      if (row.status === 'submitting') {
        await transitionOperation(
          tx,
          this.audit,
          'refund',
          row,
          'status_unknown',
          'adapter',
          'submission_interrupted',
        );
        await this.scheduleInquiry(tx, row, true);
      }
      return null;
    });
    if (!proceed) return;
    const outcome = await this.simulator.moveMoney({
      kind: 'refund',
      operationRef: proceed.id,
      amount: proceed.amount,
      assetCode: proceed.asset_code,
      scenario: proceed.sandbox_scenario,
    });
    await this.db.asPlatform(async (tx) => {
      const row = await this.lock(tx, refundId);
      if (row.status !== 'submitting') return;
      if (outcome.kind === 'accepted') {
        await transitionOperation(
          tx,
          this.audit,
          'refund',
          row,
          'pending_provider',
          'adapter',
          null,
          {
            provider_reference: outcome.providerReference,
          },
        );
        await this.scheduleInquiry(tx, row, false);
      } else if (outcome.kind === 'rejected') {
        await this.fail(tx, row, outcome.reason, 'adapter');
      } else {
        await transitionOperation(
          tx,
          this.audit,
          'refund',
          row,
          'status_unknown',
          'adapter',
          'provider_timeout',
        );
        await this.scheduleInquiry(tx, row, true);
      }
    });
  }

  private async handleInquiry(event: OutboxEvent): Promise<void> {
    const refundId = stringOf(event, 'refund_id');
    const current = await this.db.asPlatform((tx) =>
      tx.refund.findUnique({ where: { id: refundId } }),
    );
    if (!current || !['pending_provider', 'status_unknown'].includes(current.status)) return;
    const status = await this.simulator.queryStatus(refundId);
    await this.db.asPlatform(async (tx) => {
      const row = await this.lock(tx, refundId);
      if (!['pending_provider', 'status_unknown'].includes(row.status)) return;
      if (status.kind === 'succeeded') {
        await this.succeed(tx, row);
        return;
      }
      if (status.kind === 'failed') {
        await this.fail(tx, row, 'provider_failed', 'inquiry');
        return;
      }
      const inquiries = row.status_inquiries + 1;
      await tx.refund.update({ where: { id: row.id }, data: { status_inquiries: inquiries } });
      if (inquiries >= this.config.payments.maxStatusInquiries) {
        await transitionOperation(
          tx,
          this.audit,
          'refund',
          row,
          'reconciliation_required',
          'inquiry',
          'inquiries_exhausted',
        );
        await this.reconciliation.openException(tx, {
          runId: null,
          tenantId: row.tenant_id,
          type: 'stuck_status_unknown',
          subjectType: 'refund',
          subjectRef: row.id,
          detail: { inquiries },
        });
      } else {
        await this.scheduleInquiry(tx, row, true);
      }
    });
  }

  private async succeed(tx: Tx, row: Refund): Promise<void> {
    await transitionOperation(tx, this.audit, 'refund', row, 'succeeded', 'inquiry', null);
    await this.notify(tx, row, 'refund.succeeded');
    await this.ledger.post(tx, {
      idempotencyKey: `refund:${row.id}:sent`,
      tenantId: row.tenant_id,
      entryType: 'refund',
      operationType: 'refund',
      operationId: row.id,
      postings: [
        {
          accountId: await this.ledger.findAccount(tx, {
            tenantId: row.tenant_id,
            type: 'merchant_payouts_in_flight',
            assetCode: row.asset_code,
          }),
          direction: 'debit',
          amount: row.amount,
        },
        {
          // The money goes back out through the provider it came in by.
          accountId: await this.ledger.findAccount(tx, {
            tenantId: null,
            type: 'provider_clearing',
            assetCode: row.asset_code,
            qualifier: row.provider,
          }),
          direction: 'credit',
          amount: row.amount,
        },
      ],
    });
  }

  private async fail(
    tx: Tx,
    row: Refund,
    reason: string,
    source: 'adapter' | 'inquiry',
  ): Promise<void> {
    await transitionOperation(tx, this.audit, 'refund', row, 'failed', source, reason, {
      failure_code: reason,
    });
    await this.notify(tx, row, 'refund.failed');
    const reservation = await this.ledger.findEntryByKey(tx, reservationKey(row.id));
    if (reservation) await this.ledger.reverse(tx, reservation.id, `refund:${row.id}:released`);
  }

  /** The merchant's own systems hear about it through their webhook, in this same transaction. */
  private async notify(
    tx: Tx,
    row: Refund,
    type: 'refund.succeeded' | 'refund.failed',
  ): Promise<void> {
    await this.developer.emit(tx, {
      tenantId: row.tenant_id,
      type,
      subjectId: row.id,
      data: {
        id: row.id,
        status: type === 'refund.succeeded' ? 'succeeded' : 'failed',
        payment_intent_id: row.intent_id,
        amount_minor: row.amount.toString(),
        currency: row.asset_code,
      },
    });
  }

  private async scheduleInquiry(tx: Tx, row: Refund, delayed: boolean): Promise<void> {
    await this.outbox.enqueue(tx, {
      tenantId: row.tenant_id,
      type: EVENT_REFUND_INQUIRY,
      payload: { refund_id: row.id },
      availableAt: new Date(
        Date.now() + (delayed ? this.config.payments.statusInquiryDelaySeconds * 1000 : 0),
      ),
    });
  }

  private async lock(tx: Tx, refundId: string): Promise<Refund> {
    await tx.$queryRaw`select id from payments.refund where id = ${refundId}::uuid for update`;
    return tx.refund.findUniqueOrThrow({ where: { id: refundId } });
  }
}

function stringOf(event: OutboxEvent, key: string): string {
  const payload = event.payload;
  if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
    const value = payload[key];
    if (typeof value === 'string') return value;
  }
  throw new Error(`Outbox event ${event.id} is missing ${key}.`);
}
