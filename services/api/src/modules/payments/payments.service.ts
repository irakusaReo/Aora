import { createHash } from 'node:crypto';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { APP_CONFIG, type AppConfig } from '../../platform/config.js';
import { Database, type Tx } from '../../platform/database.js';
import { AppError } from '../../platform/errors.js';
import { SANDBOX_PROVIDER } from '../../seed-data.js';
import { AuditService } from '../audit/audit.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { type OutboxEvent, OutboxService } from '../outbox/outbox.service.js';
import { supports } from './adapter.js';
import { ReconciliationService } from './reconciliation.service.js';
import { type Scenario, SimulatorProvider } from './simulator.js';

export type IntentStatus =
  | 'created'
  | 'submitting'
  | 'pending_provider'
  | 'succeeded'
  | 'failed'
  | 'status_unknown'
  | 'reconciliation_required';

type Source = 'api' | 'adapter' | 'webhook' | 'inquiry';

/**
 * Every legal status change. Anything not listed is rejected.
 *
 * - `submitting` is committed before the provider is called, so a crash
 *   mid-call can never lead to a second call.
 * - `succeeded` and `failed` are final, except that contradicting evidence
 *   moves them to `reconciliation_required` for an operator.
 * - `reconciliation_required` has no automatic exit.
 */
export const TRANSITIONS: Readonly<Record<IntentStatus, readonly IntentStatus[]>> = {
  created: ['submitting', 'reconciliation_required'],
  submitting: [
    'pending_provider',
    'succeeded',
    'failed',
    'status_unknown',
    'reconciliation_required',
  ],
  pending_provider: ['succeeded', 'failed', 'reconciliation_required'],
  status_unknown: ['succeeded', 'failed', 'reconciliation_required'],
  succeeded: ['reconciliation_required'],
  failed: ['reconciliation_required'],
  reconciliation_required: [],
};

export const EVENT_SUBMIT = 'payments.intent.submit';
export const EVENT_INQUIRY = 'payments.intent.status_inquiry';
export const EVENT_WEBHOOK = 'payments.webhook.process';

type Intent = Prisma.payment_intentGetPayload<object>;

export interface IntentView {
  readonly id: string;
  readonly status: IntentStatus;
  readonly amount_minor: string;
  readonly currency: string;
  readonly provider: string;
  readonly failure_code: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

function view(intent: Intent): IntentView {
  return {
    id: intent.id,
    status: intent.status as IntentStatus,
    amount_minor: intent.amount.toString(),
    currency: intent.asset_code,
    provider: intent.provider,
    failure_code: intent.failure_code,
    created_at: intent.created_at.toISOString(),
    updated_at: intent.updated_at.toISOString(),
  };
}

export function collectionEntryKey(intentId: string): string {
  return `payment_intent:${intentId}:collection`;
}

interface ProviderResult {
  readonly outcome: 'succeeded' | 'failed';
  readonly amount: bigint | null;
  readonly providerReference: string | null;
  readonly source: Source;
}

@Injectable()
export class PaymentsService implements OnModuleInit {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SimulatorProvider) private readonly provider: SimulatorProvider,
    @Inject(ReconciliationService) private readonly reconciliation: ReconciliationService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.outbox.register(EVENT_SUBMIT, (event) => this.handleSubmit(event));
    this.outbox.register(EVENT_INQUIRY, (event) => this.handleStatusInquiry(event));
    this.outbox.register(EVENT_WEBHOOK, (event) => this.handleWebhook(event));
  }

  /**
   * Creates a collection intent. The intent, its first transition, its audit
   * event and the outbox event that will submit it commit together.
   */
  async createIntent(input: {
    tenantId: string;
    accountId: string;
    requestId: string;
    idempotencyKey: string;
    amount: bigint;
    assetCode: string;
    scenario: Scenario | null;
  }): Promise<{ intent: IntentView; replayed: boolean }> {
    if (
      !supports(this.provider, 'collect') ||
      !this.provider.declaration.assets.includes(input.assetCode)
    ) {
      throw new AppError(
        'capability_not_supported',
        'This currency cannot be collected on this rail.',
      );
    }
    const requestHash = createHash('sha256')
      .update(JSON.stringify([input.amount.toString(), input.assetCode, input.scenario]))
      .digest('hex');

    return this.db.withTenant(input.tenantId, async (tx) => {
      // ON CONFLICT DO NOTHING waits out a concurrent request with the same key,
      // so duplicates resolve to exactly one intent.
      const inserted = await tx.$queryRaw<{ id: string }[]>`
        insert into payments.payment_intent
          (tenant_id, idempotency_key, request_hash, amount, asset_code, provider,
           sandbox_scenario, created_by)
        values (${input.tenantId}::uuid, ${input.idempotencyKey}, ${requestHash}, ${input.amount},
                ${input.assetCode}, ${SANDBOX_PROVIDER}, ${input.scenario}, ${input.accountId}::uuid)
        on conflict (tenant_id, idempotency_key) do nothing
        returning id`;
      const created = inserted[0];
      if (!created) {
        const existing = await tx.payment_intent.findFirstOrThrow({
          where: { tenant_id: input.tenantId, idempotency_key: input.idempotencyKey },
        });
        if (existing.request_hash !== requestHash) {
          throw new AppError(
            'idempotency_key_reused',
            'This Idempotency-Key was already used with a different request.',
          );
        }
        return { intent: view(existing), replayed: true };
      }

      await tx.payment_intent_transition.create({
        data: {
          intent_id: created.id,
          tenant_id: input.tenantId,
          from_status: null,
          to_status: 'created',
          source: 'api',
        },
      });
      await this.audit.record(tx, {
        tenantId: input.tenantId,
        actorKind: 'user',
        actorAccountId: input.accountId,
        action: 'payments.intent.created',
        subjectType: 'payment_intent',
        subjectId: created.id,
        outcome: 'success',
        requestId: input.requestId,
        detail: { amount_minor: input.amount.toString(), currency: input.assetCode },
      });
      await this.outbox.enqueue(tx, {
        tenantId: input.tenantId,
        type: EVENT_SUBMIT,
        payload: { intent_id: created.id },
      });
      const intent = await tx.payment_intent.findUniqueOrThrow({ where: { id: created.id } });
      return { intent: view(intent), replayed: false };
    });
  }

  async getIntent(tenantId: string, intentId: string): Promise<IntentView> {
    const intent = await this.db.withTenant(tenantId, (tx) =>
      tx.payment_intent.findUnique({ where: { id: intentId } }),
    );
    // Row-level security hides other tenants' intents, so they look like any missing id.
    if (!intent) throw new AppError('not_found', 'Payment intent not found.');
    return view(intent);
  }

  /** Verifies and stores a provider webhook, then queues it. Safe to receive any number of times. */
  async receiveWebhook(rawBody: Buffer | undefined, signature: string | undefined): Promise<void> {
    if (!rawBody || !this.provider.verifySignature(rawBody, signature)) {
      await this.db.asPlatform((tx) =>
        this.audit.record(tx, {
          actorKind: 'provider',
          action: 'payments.webhook.rejected',
          subjectType: 'webhook',
          subjectId: SANDBOX_PROVIDER,
          outcome: 'denied',
          detail: { reason: 'invalid_signature' },
        }),
      );
      throw new AppError('invalid_signature', 'Webhook signature is missing or invalid.');
    }
    const body = rawBody.toString('utf8');
    let eventId: string;
    try {
      eventId = this.provider.parseEvent(body).eventId;
    } catch {
      throw new AppError('invalid_request', 'Webhook payload is not a recognised event.');
    }
    await this.db.asPlatform(async (tx) => {
      const inserted = await tx.$queryRaw<{ id: string }[]>`
        insert into payments.webhook_event (provider, provider_event_id, payload_raw)
        values (${SANDBOX_PROVIDER}, ${eventId}, ${body})
        on conflict (provider, provider_event_id) do nothing
        returning id`;
      const stored = inserted[0];
      if (!stored) return; // Duplicate delivery: already stored and queued.
      await this.outbox.enqueue(tx, {
        tenantId: null,
        type: EVENT_WEBHOOK,
        payload: { webhook_event_id: stored.id },
      });
    });
  }

  // --- Outbox handlers. Each is safe to run more than once. ---

  private async handleSubmit(event: OutboxEvent): Promise<void> {
    const intentId = payloadString(event, 'intent_id');

    const proceed = await this.db.asPlatform(async (tx) => {
      const intent = await this.lock(tx, intentId);
      if (intent.status === 'created') {
        await this.transition(tx, intent, 'submitting', 'adapter', null);
        return intent;
      }
      if (intent.status === 'submitting') {
        // A previous attempt reached the provider call and never recorded the answer.
        // The provider may have acted. Do not call again: ask instead.
        await this.markUnknown(tx, intent, 'submission_interrupted');
      }
      return null;
    });
    if (!proceed) return;

    const outcome = await this.provider.collect({
      operationRef: proceed.id,
      amount: proceed.amount,
      assetCode: proceed.asset_code,
      scenario: proceed.sandbox_scenario,
    });

    await this.db.asPlatform(async (tx) => {
      const intent = await this.lock(tx, intentId);
      // A webhook can overtake this step; if it has, the result already stands.
      if (intent.status !== 'submitting') return;
      switch (outcome.kind) {
        case 'accepted':
          await this.transition(tx, intent, 'pending_provider', 'adapter', null, {
            provider_reference: outcome.providerReference,
          });
          break;
        case 'rejected':
          await this.transition(tx, intent, 'failed', 'adapter', outcome.reason, {
            failure_code: outcome.reason,
          });
          break;
        case 'unknown':
          await this.markUnknown(tx, intent, 'provider_timeout');
          break;
      }
    });
  }

  private async handleStatusInquiry(event: OutboxEvent): Promise<void> {
    const intentId = payloadString(event, 'intent_id');
    const current = await this.db.asPlatform((tx) =>
      tx.payment_intent.findUnique({ where: { id: intentId } }),
    );
    if (current?.status !== 'status_unknown') return;

    const status = supports(this.provider, 'status_inquiry')
      ? await this.provider.queryStatus(intentId)
      : ({ kind: 'unknown' } as const);

    await this.db.asPlatform(async (tx) => {
      const intent = await this.lock(tx, intentId);
      if (intent.status !== 'status_unknown') return;
      if (status.kind === 'succeeded' || status.kind === 'failed') {
        await this.applyProviderResult(tx, intent, {
          outcome: status.kind,
          amount: status.kind === 'succeeded' ? status.amount : null,
          providerReference: status.providerReference,
          source: 'inquiry',
        });
        return;
      }
      const inquiries = intent.status_inquiries + 1;
      await tx.payment_intent.update({
        where: { id: intent.id },
        data: { status_inquiries: inquiries },
      });
      if (inquiries >= this.config.payments.maxStatusInquiries) {
        await this.transition(
          tx,
          intent,
          'reconciliation_required',
          'inquiry',
          'inquiries_exhausted',
        );
        await this.reconciliation.openException(tx, {
          runId: null,
          tenantId: intent.tenant_id,
          type: 'stuck_status_unknown',
          subjectType: 'payment_intent',
          subjectRef: intent.id,
          detail: { inquiries },
        });
      } else {
        await this.scheduleInquiry(tx, intent);
      }
    });
  }

  private async handleWebhook(event: OutboxEvent): Promise<void> {
    const webhookEventId = payloadString(event, 'webhook_event_id');
    await this.db.asPlatform(async (tx) => {
      const stored = await tx.webhook_event.findUniqueOrThrow({ where: { id: webhookEventId } });
      if (stored.processed_at) return;
      const parsed = this.provider.parseEvent(stored.payload_raw);
      const known = UUID.test(parsed.operationRef)
        ? await tx.payment_intent.findUnique({ where: { id: parsed.operationRef } })
        : null;

      let outcome: string;
      if (!known) {
        await this.reconciliation.openException(tx, {
          runId: null,
          tenantId: null,
          type: 'missing_internal',
          subjectType: 'provider_transaction',
          subjectRef: parsed.providerReference,
          detail: { source: 'webhook', amount_minor: parsed.amount.toString() },
        });
        outcome = 'unmatched';
      } else {
        const intent = await this.lock(tx, known.id);
        outcome = await this.applyProviderResult(tx, intent, {
          outcome: parsed.result,
          amount: parsed.amount,
          providerReference: parsed.providerReference,
          source: 'webhook',
        });
      }
      await tx.webhook_event.update({
        where: { id: stored.id },
        data: { processed_at: new Date(), outcome },
      });
    });
  }

  /**
   * The single place a provider's verdict changes an intent. The status change
   * and the journal entry are in the caller's transaction: both or neither.
   */
  private async applyProviderResult(
    tx: Tx,
    intent: Intent,
    result: ProviderResult,
  ): Promise<string> {
    const status = intent.status as IntentStatus;
    const reference = result.providerReference ?? intent.provider_reference;
    const conflict = async (reason: string): Promise<string> => {
      await this.transition(tx, intent, 'reconciliation_required', result.source, reason, {
        provider_reference: reference,
      });
      await this.reconciliation.openException(tx, {
        runId: null,
        tenantId: intent.tenant_id,
        type: reason === 'amount_mismatch' ? 'amount_mismatch' : 'provider_result_conflict',
        subjectType: 'payment_intent',
        subjectRef: intent.id,
        detail: {
          reason,
          status_before: status,
          provider_result: result.outcome,
          intent_amount_minor: intent.amount.toString(),
          provider_amount_minor: result.amount?.toString() ?? null,
        },
      });
      return reason;
    };

    switch (status) {
      case 'reconciliation_required':
        return 'ignored_reconciliation_required';
      case 'created':
        return conflict('result_before_submission');
      case 'succeeded':
        return result.outcome === 'succeeded' && result.amount === intent.amount
          ? 'duplicate_ignored'
          : conflict('contradicts_recorded_success');
      case 'failed':
        return result.outcome === 'failed'
          ? 'duplicate_ignored'
          : conflict('late_success_after_failure');
      case 'submitting':
      case 'pending_provider':
      case 'status_unknown':
        break;
    }

    if (result.outcome === 'failed') {
      await this.transition(tx, intent, 'failed', result.source, 'provider_failed', {
        provider_reference: reference,
        failure_code: 'provider_failed',
      });
      return 'failed';
    }
    if (result.amount !== intent.amount) return conflict('amount_mismatch');

    await this.transition(tx, intent, 'succeeded', result.source, null, {
      provider_reference: reference,
    });
    await this.ledger.post(tx, {
      idempotencyKey: collectionEntryKey(intent.id),
      tenantId: intent.tenant_id,
      entryType: 'collection',
      operationType: 'payment_intent',
      operationId: intent.id,
      postings: [
        {
          accountId: await this.ledger.findAccount(tx, {
            tenantId: null,
            type: 'provider_clearing',
            assetCode: intent.asset_code,
            qualifier: intent.provider,
          }),
          direction: 'debit',
          amount: intent.amount,
        },
        {
          accountId: await this.ledger.findAccount(tx, {
            tenantId: intent.tenant_id,
            type: 'merchant_collections_pending',
            assetCode: intent.asset_code,
          }),
          direction: 'credit',
          amount: intent.amount,
        },
      ],
    });
    // Transaction alert to the person who took the payment, in the same transaction:
    // it exists if and only if the payment succeeded, and is sent once.
    const asset = await tx.asset.findUniqueOrThrow({ where: { code: intent.asset_code } });
    await this.notifications.notify(tx, {
      dedupeKey: `payment.received:${intent.id}`,
      accountId: intent.created_by,
      tenantId: intent.tenant_id,
      type: 'payment.received',
      params: {
        amount_minor: intent.amount.toString(),
        currency: intent.asset_code,
        exponent: asset.exponent,
        reference: intent.id,
      },
    });
    return 'succeeded';
  }

  private async markUnknown(tx: Tx, intent: Intent, reason: string): Promise<void> {
    await this.transition(tx, intent, 'status_unknown', 'adapter', reason);
    await this.scheduleInquiry(tx, intent);
  }

  private async scheduleInquiry(tx: Tx, intent: Intent): Promise<void> {
    await this.outbox.enqueue(tx, {
      tenantId: intent.tenant_id,
      type: EVENT_INQUIRY,
      payload: { intent_id: intent.id },
      availableAt: new Date(Date.now() + this.config.payments.statusInquiryDelaySeconds * 1000),
    });
  }

  private async lock(tx: Tx, intentId: string): Promise<Intent> {
    await tx.$queryRaw`select id from payments.payment_intent where id = ${intentId}::uuid for update`;
    return tx.payment_intent.findUniqueOrThrow({ where: { id: intentId } });
  }

  private async transition(
    tx: Tx,
    intent: Intent,
    to: IntentStatus,
    source: Source,
    reason: string | null,
    data: { provider_reference?: string | null; failure_code?: string } = {},
  ): Promise<void> {
    const from = intent.status as IntentStatus;
    if (!TRANSITIONS[from].includes(to)) {
      throw new AppError(
        'invalid_state_transition',
        `Cannot move a payment from ${from} to ${to}.`,
      );
    }
    const updated = await tx.payment_intent.updateMany({
      where: { id: intent.id, status: from },
      data: { status: to, ...data },
    });
    if (updated.count !== 1) {
      throw new AppError('invalid_state_transition', 'Payment status changed concurrently.');
    }
    await tx.payment_intent_transition.create({
      data: {
        intent_id: intent.id,
        tenant_id: intent.tenant_id,
        from_status: from,
        to_status: to,
        source,
        reason,
      },
    });
    await this.audit.record(tx, {
      tenantId: intent.tenant_id,
      actorKind: source === 'webhook' || source === 'inquiry' ? 'provider' : 'system',
      action: `payments.intent.${to}`,
      subjectType: 'payment_intent',
      subjectId: intent.id,
      outcome: 'success',
      detail: { from, to, ...(reason ? { reason } : {}) },
    });
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function payloadString(event: OutboxEvent, key: string): string {
  const payload = event.payload;
  if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
    const value = payload[key];
    if (typeof value === 'string') return value;
  }
  throw new Error(`Outbox event ${event.id} is missing ${key}.`);
}
