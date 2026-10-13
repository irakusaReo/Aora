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
import { PricingService } from '../pricing/pricing.service.js';
import { TenancyService } from '../tenancy/tenancy.service.js';
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
  /** Gross: what the payer pays. */
  readonly amount_minor: string;
  /** AORA's fee, fixed when the collection was created. */
  readonly fee_minor: string;
  /** What the merchant receives: gross minus fee, exactly. */
  readonly net_minor: string;
  readonly tariff_version_id: string | null;
  readonly currency: string;
  readonly rail: string;
  readonly branch_id: string | null;
  readonly reference: string | null;
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
    fee_minor: intent.fee_amount.toString(),
    net_minor: (intent.amount - intent.fee_amount).toString(),
    tariff_version_id: intent.tariff_version_id,
    currency: intent.asset_code,
    rail: intent.rail,
    branch_id: intent.branch_id,
    reference: intent.reference,
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
    @Inject(PricingService) private readonly pricing: PricingService,
    @Inject(TenancyService) private readonly tenancy: TenancyService,
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
    rail: string;
    branchId: string | null;
    reference: string | null;
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
      .update(
        JSON.stringify([
          input.amount.toString(),
          input.assetCode,
          input.scenario,
          input.rail,
          input.branchId,
          input.reference,
        ]),
      )
      .digest('hex');

    return this.db.withTenant(input.tenantId, async (tx) => {
      // A repeat of a request already accepted is answered from the record, before
      // any check that could now give a different answer (a new tariff, a used-up limit).
      const earlier = await tx.payment_intent.findFirst({
        where: { tenant_id: input.tenantId, idempotency_key: input.idempotencyKey },
      });
      if (earlier) {
        if (earlier.request_hash !== requestHash) {
          throw new AppError(
            'idempotency_key_reused',
            'This Idempotency-Key was already used with a different request.',
          );
        }
        return { intent: view(earlier), replayed: true };
      }
      if (
        input.branchId &&
        !(await this.tenancy.isActiveBranch(tx, input.tenantId, input.branchId))
      ) {
        throw new AppError('invalid_request', 'Invalid request: branch_id.');
      }
      // The fee is fixed now, from the tariff version in effect (ADR 0021).
      const quote = await this.pricing.quote(tx, {
        operation: 'collection',
        rail: input.rail,
        country: this.provider.declaration.country,
        assetCode: input.assetCode,
        amount: input.amount,
      });
      await this.assertWithinLimits(tx, input.tenantId, input.assetCode, input.amount);

      // ON CONFLICT DO NOTHING waits out a concurrent request with the same key,
      // so duplicates resolve to exactly one intent.
      const inserted = await tx.$queryRaw<{ id: string }[]>`
        insert into payments.payment_intent
          (tenant_id, idempotency_key, request_hash, amount, asset_code, provider,
           sandbox_scenario, created_by, rail, fee_amount, tariff_version_id, branch_id, reference)
        values (${input.tenantId}::uuid, ${input.idempotencyKey}, ${requestHash}, ${input.amount},
                ${input.assetCode}, ${SANDBOX_PROVIDER}, ${input.scenario}, ${input.accountId}::uuid,
                ${input.rail}, ${quote.fee}, ${quote.tariffVersionId}::uuid,
                ${input.branchId}::uuid, ${input.reference})
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

  /**
   * `branchScope` restricts the caller to one branch (a cashier's own); `undefined`
   * means the whole workspace. A null scope matches collections with no branch.
   */
  async getIntent(
    tenantId: string,
    intentId: string,
    branchScope?: string | null,
  ): Promise<IntentView> {
    const intent = await this.db.withTenant(tenantId, (tx) =>
      tx.payment_intent.findUnique({ where: { id: intentId } }),
    );
    // Row-level security hides other tenants' intents, so they look like any missing id.
    if (!intent || (branchScope !== undefined && intent.branch_id !== branchScope)) {
      throw new AppError('not_found', 'Payment intent not found.');
    }
    return view(intent);
  }

  /** Collections of a workspace, newest first, paged by an opaque cursor. */
  async listIntents(
    tenantId: string,
    options: { branchScope?: string | null; branchId?: string; limit: number; cursor?: string },
  ): Promise<{ data: IntentView[]; next_cursor: string | null }> {
    const after = options.cursor ? decodeCursor(options.cursor) : null;
    const scoped = options.branchScope !== undefined;
    const branch = scoped ? options.branchScope : (options.branchId ?? null);
    const filterBranch = scoped || options.branchId !== undefined;
    return this.db.withTenant(tenantId, async (tx) => {
      // Keyset paging on (created_at, id). The timestamp travels as text so that
      // its microseconds survive the round trip.
      const page = await tx.$queryRaw<{ id: string; created: string }[]>`
        select id, to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created
        from payments.payment_intent
        where (${!filterBranch} or branch_id is not distinct from ${branch ?? null}::uuid)
          and (${after === null}
               or (created_at, id) < (${after?.created ?? null}::timestamptz, ${after?.id ?? null}::uuid))
        order by created_at desc, id desc
        limit ${options.limit + 1}`;
      const shown = page.slice(0, options.limit);
      const rows = await tx.payment_intent.findMany({
        where: { id: { in: shown.map((row) => row.id) } },
      });
      const byId = new Map(rows.map((row) => [row.id, row]));
      const last = shown.at(-1);
      return {
        data: shown.flatMap((row) => {
          const intent = byId.get(row.id);
          return intent ? [view(intent)] : [];
        }),
        next_cursor: page.length > options.limit && last ? encodeCursor(last) : null,
      };
    });
  }

  /** The fee a collection of this amount would carry right now. Changes nothing. */
  async quoteCollection(
    tenantId: string,
    input: { rail: string; assetCode: string; amount: bigint },
  ): Promise<{
    amount_minor: string;
    fee_minor: string;
    net_minor: string;
    tariff_version_id: string;
    tariff_version: number;
  }> {
    const quote = await this.db.withTenant(tenantId, (tx) =>
      this.pricing.quote(tx, {
        operation: 'collection',
        rail: input.rail,
        country: this.provider.declaration.country,
        assetCode: input.assetCode,
        amount: input.amount,
      }),
    );
    return {
      amount_minor: quote.amount.toString(),
      fee_minor: quote.fee.toString(),
      net_minor: quote.net.toString(),
      tariff_version_id: quote.tariffVersionId,
      tariff_version: quote.tariffVersion,
    };
  }

  /**
   * Refuses a collection above the workspace tier's limits. The per-workspace
   * lock makes concurrent requests take turns, so two cannot both fit under a
   * daily limit that has room for one.
   */
  private async assertWithinLimits(
    tx: Tx,
    tenantId: string,
    assetCode: string,
    amount: bigint,
  ): Promise<void> {
    const limits = await this.tenancy.limitsFor(tx, tenantId, assetCode);
    if (!limits || amount > limits.perTransactionMax) {
      throw new AppError('limit_exceeded', 'This amount is above the limit for one collection.');
    }
    await tx.$executeRaw`
      select pg_advisory_xact_lock(hashtextextended(${`collect:${tenantId}:${assetCode}`}::text, 0))`;
    const taken = await tx.$queryRaw<{ total: bigint }[]>`
      select coalesce(sum(amount), 0)::bigint as total from payments.payment_intent
      where asset_code = ${assetCode} and status <> 'failed'
        and created_at > now() - interval '24 hours'`;
    if ((taken[0]?.total ?? 0n) + amount > limits.dailyCollectionMax) {
      throw new AppError(
        'limit_exceeded',
        'This collection would take the workspace over its limit for 24 hours.',
      );
    }
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
          amount: intent.amount - intent.fee_amount,
        },
        // AORA's fee, as fixed on the intent. A posting must be positive, so a free collection has none.
        ...(intent.fee_amount > 0n
          ? [
              {
                accountId: await this.ledger.findAccount(tx, {
                  tenantId: null,
                  type: 'fee_revenue',
                  assetCode: intent.asset_code,
                }),
                direction: 'credit' as const,
                amount: intent.fee_amount,
              },
            ]
          : []),
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
const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f-]{36})$/i;

function encodeCursor(row: { id: string; created: string }): string {
  return Buffer.from(`${row.created}|${row.id}`).toString('base64url');
}

function decodeCursor(cursor: string): { id: string; created: string } {
  const match = CURSOR.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!match?.[1] || !match[2] || !UUID.test(match[2])) {
    throw new AppError('invalid_request', 'Invalid request: cursor.');
  }
  return { created: match[1], id: match[2] };
}

function payloadString(event: OutboxEvent, key: string): string {
  const payload = event.payload;
  if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
    const value = payload[key];
    if (typeof value === 'string') return value;
  }
  throw new Error(`Outbox event ${event.id} is missing ${key}.`);
}
