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
import { PricingService } from '../pricing/pricing.service.js';
import { TenancyService } from '../tenancy/tenancy.service.js';
import { DARAJA_PROVIDER, type DarajaAdapter, type DarajaPayoutResult } from './daraja.js';
import { decimalTextToMinor, type OperationStatus, transitionOperation } from './operations.js';
import { DARAJA_ADAPTER } from './payments.service.js';
import { ReconciliationService } from './reconciliation.service.js';
import { SimulatorProvider } from './simulator.js';
import { assertWholeAmount } from './settlement.service.js';

export const EVENT_PAYOUT_SUBMIT = 'payments.payout.submit';
export const EVENT_PAYOUT_INQUIRY = 'payments.payout.status_inquiry';
export const EVENT_PAYOUT_RESULT = 'payments.payout.daraja_result';

/** What confirming a recipient proves, said the same way on screen and in the audit trail (O-11). */
export const CONFIRMATION_PROVES =
  'You typed this number twice and confirmed with your PIN. This records your intent to pay it; it does not prove the number belongs to you or to the person you mean.';

type Payout = Prisma.payoutGetPayload<object>;

export interface RecipientView {
  readonly id: string;
  readonly label: string;
  readonly rail: string;
  readonly status: string;
  readonly phone_hint: string;
  readonly confirmed_at: string | null;
  readonly created_at: string;
  readonly confirmation_proves?: string;
}

export interface PayoutView {
  readonly id: string;
  readonly status: OperationStatus;
  readonly recipient_id: string;
  readonly amount_minor: string;
  readonly fee_minor: string;
  readonly total_minor: string;
  readonly currency: string;
  readonly tariff_version_id: string;
  readonly provider: string;
  readonly failure_code: string | null;
  readonly receipt: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface Actor {
  readonly tenantId: string;
  readonly accountId: string;
  readonly requestId: string;
}

function view(row: Payout): PayoutView {
  return {
    id: row.id,
    status: row.status as OperationStatus,
    recipient_id: row.recipient_id,
    amount_minor: row.amount.toString(),
    fee_minor: row.fee_amount.toString(),
    total_minor: (row.amount + row.fee_amount).toString(),
    currency: row.asset_code,
    tariff_version_id: row.tariff_version_id,
    provider: row.provider,
    failure_code: row.failure_code,
    receipt: row.receipt,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function recipientView(row: Prisma.payout_recipientGetPayload<object>): RecipientView {
  return {
    id: row.id,
    label: row.label,
    rail: row.rail,
    status: row.status,
    phone_hint: `•••${row.msisdn.slice(-3)}`,
    confirmed_at: row.confirmed_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
  };
}

const reservationKey = (id: string): string => `payout:${id}:reservation`;

/**
 * Payouts (journey J6). A payout goes only to a confirmed recipient, after
 * the cooling-off period, within the first-payout cap and the tier's limits,
 * for exactly the fee the person was shown. Amount and fee are reserved when
 * it is created; success sends the amount and earns the fee; failure gives
 * the reservation back with a compensating entry (ADR 0021).
 */
@Injectable()
export class PayoutsService implements OnModuleInit {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PricingService) private readonly pricing: PricingService,
    @Inject(TenancyService) private readonly tenancy: TenancyService,
    @Inject(SimulatorProvider) private readonly simulator: SimulatorProvider,
    @Inject(ReconciliationService) private readonly reconciliation: ReconciliationService,
    @Inject(DeveloperService) private readonly developer: DeveloperService,
    @Inject(DARAJA_ADAPTER) private readonly daraja: DarajaAdapter | null,
  ) {}

  onModuleInit(): void {
    this.outbox.register(EVENT_PAYOUT_SUBMIT, (event) => this.handleSubmit(event));
    this.outbox.register(EVENT_PAYOUT_INQUIRY, (event) => this.handleInquiry(event));
    this.outbox.register(EVENT_PAYOUT_RESULT, (event) => this.handleDarajaResult(event));
  }

  private get b2c(): DarajaAdapter | null {
    return this.daraja?.payoutsEnabled ? this.daraja : null;
  }

  // --- Recipients ---

  async listRecipients(tenantId: string): Promise<RecipientView[]> {
    const rows = await this.db.asPlatform((tx) =>
      tx.payout_recipient.findMany({
        where: { tenant_id: tenantId },
        orderBy: { created_at: 'asc' },
      }),
    );
    return rows.map(recipientView);
  }

  async addRecipient(
    actor: Actor,
    input: { phone: string; label: string },
  ): Promise<RecipientView> {
    // SANDBOX: Daraja may only ever pay its own test number.
    if (this.b2c && input.phone !== this.b2c.testPayer) {
      throw new AppError(
        'invalid_request',
        'In the sandbox, only the Daraja test number can receive payouts.',
      );
    }
    return this.db.asPlatform(async (tx) => {
      const msisdn = input.phone.slice(1);
      const existing = await tx.payout_recipient.findFirst({
        where: { tenant_id: actor.tenantId, rail: 'mpesa', msisdn },
      });
      if (existing) throw new AppError('conflict', 'This number is already a recipient.');
      const row = await tx.payout_recipient.create({
        data: {
          tenant_id: actor.tenantId,
          rail: 'mpesa',
          label: input.label,
          msisdn,
          created_by: actor.accountId,
        },
      });
      await this.audit.record(tx, {
        tenantId: actor.tenantId,
        actorKind: 'user',
        actorAccountId: actor.accountId,
        action: 'payments.recipient.added',
        subjectType: 'payout_recipient',
        subjectId: row.id,
        outcome: 'success',
        requestId: actor.requestId,
      });
      return recipientView(row);
    });
  }

  /**
   * The second entry of the number, after a PIN step-up (checked by the route).
   * Proves intent, not ownership: recorded as such (owner decision on O-11).
   */
  async confirmRecipient(actor: Actor, recipientId: string, phone: string): Promise<RecipientView> {
    return this.db.asPlatform(async (tx) => {
      const row = await tx.payout_recipient.findFirst({
        where: { id: recipientId, tenant_id: actor.tenantId },
      });
      if (!row) throw new AppError('not_found', 'Recipient not found.');
      if (row.status !== 'unconfirmed') {
        throw new AppError(
          'invalid_state_transition',
          'This recipient is not waiting for confirmation.',
        );
      }
      if (phone.slice(1) !== row.msisdn) {
        throw new AppError('invalid_request', 'The number does not match the one entered first.');
      }
      const updated = await tx.payout_recipient.update({
        where: { id: row.id },
        data: { status: 'confirmed', confirmed_by: actor.accountId, confirmed_at: new Date() },
      });
      await this.audit.record(tx, {
        tenantId: actor.tenantId,
        actorKind: 'user',
        actorAccountId: actor.accountId,
        action: 'payments.recipient.confirmed',
        subjectType: 'payout_recipient',
        subjectId: row.id,
        outcome: 'success',
        requestId: actor.requestId,
        detail: { proves: 'intent_not_ownership', method: 'number_entered_twice_with_pin' },
      });
      return { ...recipientView(updated), confirmation_proves: CONFIRMATION_PROVES };
    });
  }

  // --- Payouts ---

  async preview(
    tenantId: string,
    input: { recipientId: string; amount: bigint; assetCode: string },
  ): Promise<{
    amount_minor: string;
    fee_minor: string;
    total_minor: string;
    tariff_version_id: string;
    tariff_version: number;
  }> {
    return this.db.asPlatform(async (tx) => {
      await this.tenancy.assertNotRestricted(tx, tenantId, 'payouts_suspended');
      const recipient = await tx.payout_recipient.findFirst({
        where: { id: input.recipientId, tenant_id: tenantId },
      });
      if (!recipient) throw new AppError('not_found', 'Recipient not found.');
      const quote = await this.pricing.quote(tx, {
        operation: 'payout',
        rail: recipient.rail,
        country: 'KE',
        assetCode: input.assetCode,
        amount: input.amount,
      });
      return {
        amount_minor: quote.amount.toString(),
        fee_minor: quote.fee.toString(),
        total_minor: (quote.amount + quote.fee).toString(),
        tariff_version_id: quote.tariffVersionId,
        tariff_version: quote.tariffVersion,
      };
    });
  }

  async create(
    actor: Actor,
    input: {
      idempotencyKey: string;
      recipientId: string;
      amount: bigint;
      assetCode: string;
      expectedFee: bigint;
      tariffVersionId: string;
      scenario: string | null;
    },
  ): Promise<{ payout: PayoutView; replayed: boolean }> {
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify([
          input.recipientId,
          input.amount.toString(),
          input.assetCode,
          input.expectedFee.toString(),
          input.tariffVersionId,
          input.scenario,
        ]),
      )
      .digest('hex');
    const daraja = input.scenario ? null : this.b2c;
    const provider = daraja ? DARAJA_PROVIDER : SANDBOX_PROVIDER;

    try {
      return await this.db.asPlatform(async (tx) => {
        const earlier = await tx.payout.findFirst({
          where: { tenant_id: actor.tenantId, idempotency_key: input.idempotencyKey },
        });
        if (earlier) {
          if (earlier.request_hash !== requestHash) {
            throw new AppError(
              'idempotency_key_reused',
              'This Idempotency-Key was already used with a different request.',
            );
          }
          return { payout: view(earlier), replayed: true };
        }
        // Payouts of one workspace take turns, so limits and balances are checked one at a time.
        await tx.$executeRaw`select pg_advisory_xact_lock(hashtextextended(${`payout:${actor.tenantId}`}::text, 0))`;
        await this.tenancy.assertNotRestricted(tx, actor.tenantId, 'payouts_suspended');

        const recipient = await tx.payout_recipient.findFirst({
          where: { id: input.recipientId, tenant_id: actor.tenantId },
        });
        if (!recipient) throw new AppError('not_found', 'Recipient not found.');
        if (recipient.status !== 'confirmed' || !recipient.confirmed_at) {
          throw new AppError(
            'recipient_not_confirmed',
            'Confirm this recipient before paying them.',
          );
        }
        const policy = await tx.payout_policy.findFirst({
          where: { asset_code: input.assetCode, effective_from: { lte: new Date() } },
          orderBy: { version: 'desc' },
        });
        if (!policy)
          throw new AppError(
            'capability_not_supported',
            'Payouts are not available in this currency.',
          );
        if (recipient.confirmed_at.getTime() + policy.cooling_off_seconds * 1000 > Date.now()) {
          throw new AppError(
            'recipient_cooling_off',
            'This recipient was confirmed recently. Try again later.',
          );
        }
        if (input.amount < policy.min_amount) {
          throw new AppError('invalid_request', 'This amount is below the minimum payout.');
        }
        const paidBefore = await tx.payout.count({
          where: { recipient_id: recipient.id, status: 'succeeded' },
        });
        if (paidBefore === 0 && input.amount > policy.first_payout_cap) {
          throw new AppError('limit_exceeded', 'The first payout to a new recipient is capped.');
        }
        const limits = await this.tenancy.limitsFor(tx, actor.tenantId, input.assetCode);
        if (!limits || input.amount > limits.perTransactionMax) {
          throw new AppError('limit_exceeded', 'This amount is above the limit for one payout.');
        }
        const today = await tx.$queryRaw<{ total: bigint }[]>`
          select coalesce(sum(amount), 0)::bigint as total from payments.payout
          where tenant_id = ${actor.tenantId}::uuid and asset_code = ${input.assetCode}
            and status <> 'failed' and created_at > now() - interval '24 hours'`;
        if ((today[0]?.total ?? 0n) + input.amount > limits.dailyPayoutMax) {
          throw new AppError(
            'limit_exceeded',
            'This payout would take the workspace over its limit for 24 hours.',
          );
        }
        if (daraja) {
          const asset = await tx.asset.findUniqueOrThrow({ where: { code: input.assetCode } });
          assertWholeAmount(input.amount, asset.exponent);
        }
        const quote = await this.pricing.quote(tx, {
          operation: 'payout',
          rail: recipient.rail,
          country: 'KE',
          assetCode: input.assetCode,
          amount: input.amount,
        });
        // The person must be charged exactly what they were shown.
        if (quote.fee !== input.expectedFee || quote.tariffVersionId !== input.tariffVersionId) {
          throw new AppError(
            'fee_changed',
            'The fee has changed since it was shown. Preview the payout again.',
          );
        }
        const available = await this.ledger.findAccount(tx, {
          tenantId: actor.tenantId,
          type: 'merchant_available',
          assetCode: input.assetCode,
        });
        if ((await this.ledger.balanceOf(tx, available)) < input.amount + quote.fee) {
          throw new AppError(
            'insufficient_funds',
            'There is not enough available money for this payout and its fee.',
          );
        }

        const row = await tx.payout.create({
          data: {
            tenant_id: actor.tenantId,
            idempotency_key: input.idempotencyKey,
            request_hash: requestHash,
            recipient_id: recipient.id,
            amount: input.amount,
            fee_amount: quote.fee,
            tariff_version_id: quote.tariffVersionId,
            asset_code: input.assetCode,
            provider,
            sandbox_scenario: input.scenario,
            created_by: actor.accountId,
          },
        });
        await tx.operation_transition.create({
          data: {
            operation_type: 'payout',
            operation_id: row.id,
            tenant_id: actor.tenantId,
            from_status: null,
            to_status: 'created',
            source: 'api',
          },
        });
        // Reserve amount and fee now: what is in flight can never be spent twice.
        await this.ledger.post(tx, {
          idempotencyKey: reservationKey(row.id),
          tenantId: actor.tenantId,
          entryType: 'payout.reservation',
          operationType: 'payout',
          operationId: row.id,
          postings: [
            { accountId: available, direction: 'debit', amount: input.amount + quote.fee },
            {
              accountId: await this.ledger.findAccount(tx, {
                tenantId: actor.tenantId,
                type: 'merchant_payouts_in_flight',
                assetCode: input.assetCode,
              }),
              direction: 'credit',
              amount: input.amount + quote.fee,
            },
          ],
        });
        await this.audit.record(tx, {
          tenantId: actor.tenantId,
          actorKind: 'user',
          actorAccountId: actor.accountId,
          action: 'payments.payout.created',
          subjectType: 'payout',
          subjectId: row.id,
          outcome: 'success',
          requestId: actor.requestId,
          detail: { amount_minor: input.amount.toString(), fee_minor: quote.fee.toString() },
        });
        await this.outbox.enqueue(tx, {
          tenantId: actor.tenantId,
          type: EVENT_PAYOUT_SUBMIT,
          payload: { payout_id: row.id },
        });
        return { payout: view(row), replayed: false };
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      // The ledger refuses a reservation that would overdraw "available".
      if (String(error).includes('insufficient balance')) {
        throw new AppError(
          'insufficient_funds',
          'There is not enough available money for this payout and its fee.',
        );
      }
      throw error;
    }
  }

  async get(tenantId: string, payoutId: string): Promise<PayoutView> {
    const row = await this.db.withTenant(tenantId, (tx) =>
      tx.payout.findUnique({ where: { id: payoutId } }),
    );
    if (!row) throw new AppError('not_found', 'Payout not found.');
    return view(row);
  }

  async list(tenantId: string): Promise<PayoutView[]> {
    const rows = await this.db.withTenant(tenantId, (tx) =>
      tx.payout.findMany({ orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 100 }),
    );
    return rows.map(view);
  }

  // --- Daraja result callbacks (ADR 0022) ---

  async receiveDarajaResult(input: {
    payoutId: string;
    token: string;
    purpose: 'b2c' | 'b2c_status';
    rawBody: Buffer | undefined;
    sourceIp: string | null;
  }): Promise<void> {
    const daraja = this.b2c;
    const known =
      daraja !== null &&
      /^[0-9a-f-]{36}$/i.test(input.payoutId) &&
      daraja.verifyCallbackToken(input.payoutId, input.token, input.purpose);
    if (!daraja || !known || !daraja.allowedSource(input.sourceIp)) {
      await this.db.asPlatform((tx) =>
        this.audit.record(tx, {
          actorKind: 'provider',
          action: 'payments.webhook.rejected',
          subjectType: 'webhook',
          subjectId: DARAJA_PROVIDER,
          outcome: 'denied',
          detail: {
            reason: known ? 'source_not_allowed' : 'invalid_callback_token',
            source_ip: input.sourceIp,
          },
        }),
      );
      throw new AppError('invalid_signature', 'Webhook signature is missing or invalid.');
    }
    const body = input.rawBody?.toString('utf8') ?? '';
    let result: DarajaPayoutResult;
    try {
      result =
        input.purpose === 'b2c' ? daraja.parseB2cResult(body) : daraja.parseStatusResult(body);
    } catch {
      throw new AppError('invalid_request', 'Webhook payload is not a recognised event.');
    }
    if (result.payoutId !== input.payoutId) {
      throw new AppError('invalid_request', 'Webhook payload is not for this payout.');
    }
    await this.db.asPlatform(async (tx) => {
      const inserted = await tx.$queryRaw<{ id: string }[]>`
        insert into payments.webhook_event (provider, provider_event_id, payload_raw)
        values (${DARAJA_PROVIDER}, ${`${input.purpose}:${input.payoutId}:${result.resultCode}:${result.outcome}`}, ${body})
        on conflict (provider, provider_event_id) do nothing
        returning id`;
      const stored = inserted[0];
      if (!stored) return;
      await this.audit.record(tx, {
        actorKind: 'provider',
        action: 'payments.daraja.callback_received',
        subjectType: 'payout',
        subjectId: input.payoutId,
        outcome: 'success',
        detail: { source_ip: input.sourceIp, kind: input.purpose, result_code: result.resultCode },
      });
      await this.outbox.enqueue(tx, {
        tenantId: null,
        type: EVENT_PAYOUT_RESULT,
        payload: { webhook_event_id: stored.id, purpose: input.purpose },
      });
    });
  }

  // --- Outbox handlers. Each is safe to run more than once. ---

  private async handleSubmit(event: OutboxEvent): Promise<void> {
    const payoutId = stringOf(event, 'payout_id');
    const proceed = await this.db.asPlatform(async (tx) => {
      const row = await this.lock(tx, payoutId);
      if (row.status === 'created') {
        await transitionOperation(tx, this.audit, 'payout', row, 'submitting', 'adapter', null);
        return row;
      }
      if (row.status === 'submitting') {
        // The provider may have acted on an earlier attempt. Never call again: ask.
        await transitionOperation(
          tx,
          this.audit,
          'payout',
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

    const recipient = await this.db.asPlatform((tx) =>
      tx.payout_recipient.findUniqueOrThrow({ where: { id: proceed.recipient_id } }),
    );
    const asset = await this.db.asPlatform((tx) =>
      tx.asset.findUniqueOrThrow({ where: { code: proceed.asset_code } }),
    );
    const outcome =
      proceed.provider === DARAJA_PROVIDER
        ? this.b2c
          ? await this.b2c.b2cPayment({
              payoutId: proceed.id,
              amount: proceed.amount,
              exponent: asset.exponent,
              msisdn: recipient.msisdn,
              resultUrl: this.resultUrl('b2c', proceed.id),
            })
          : ({ kind: 'rejected', reason: 'provider_not_configured' } as const)
        : await this.simulator.moveMoney({
            kind: 'payout',
            operationRef: proceed.id,
            amount: proceed.amount,
            assetCode: proceed.asset_code,
            scenario: proceed.sandbox_scenario,
          });

    await this.db.asPlatform(async (tx) => {
      const row = await this.lock(tx, payoutId);
      if (row.status !== 'submitting') return;
      if (outcome.kind === 'accepted') {
        await transitionOperation(
          tx,
          this.audit,
          'payout',
          row,
          'pending_provider',
          'adapter',
          null,
          {
            provider_reference: outcome.providerReference,
          },
        );
        // The simulator answers a status query at once; Daraja's result comes by callback,
        // with a Transaction Status query later if it does not.
        await this.scheduleInquiry(tx, row, row.provider === DARAJA_PROVIDER);
      } else if (outcome.kind === 'rejected') {
        await this.fail(tx, row, outcome.reason, 'adapter');
      } else {
        await transitionOperation(
          tx,
          this.audit,
          'payout',
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
    const payoutId = stringOf(event, 'payout_id');
    const current = await this.db.asPlatform((tx) =>
      tx.payout.findUnique({ where: { id: payoutId } }),
    );
    if (!current || !['pending_provider', 'status_unknown'].includes(current.status)) return;

    let answer: 'succeeded' | 'failed' | 'pending' = 'pending';
    if (current.provider === DARAJA_PROVIDER) {
      // Asynchronous: the answer comes back to the status callback URL.
      if (this.b2c) {
        await this.b2c.transactionStatus({
          payoutId,
          resultUrl: this.resultUrl('b2c_status', payoutId),
        });
      }
    } else {
      const status = await this.simulator.queryStatus(payoutId);
      answer =
        status.kind === 'succeeded' ? 'succeeded' : status.kind === 'failed' ? 'failed' : 'pending';
    }

    await this.db.asPlatform(async (tx) => {
      const row = await this.lock(tx, payoutId);
      if (!['pending_provider', 'status_unknown'].includes(row.status)) return;
      if (answer === 'succeeded') {
        await this.succeed(tx, row, null, 'inquiry');
        return;
      }
      if (answer === 'failed') {
        await this.fail(tx, row, 'provider_failed', 'inquiry');
        return;
      }
      const inquiries = row.status_inquiries + 1;
      await tx.payout.update({ where: { id: row.id }, data: { status_inquiries: inquiries } });
      if (inquiries >= this.config.payments.maxStatusInquiries) {
        await transitionOperation(
          tx,
          this.audit,
          'payout',
          row,
          'reconciliation_required',
          'inquiry',
          'inquiries_exhausted',
        );
        await this.reconciliation.openException(tx, {
          runId: null,
          tenantId: row.tenant_id,
          type: 'stuck_status_unknown',
          subjectType: 'payout',
          subjectRef: row.id,
          detail: { inquiries, last_known: row.status },
        });
      } else {
        await this.scheduleInquiry(tx, row, true);
      }
    });
  }

  private async handleDarajaResult(event: OutboxEvent): Promise<void> {
    const webhookEventId = stringOf(event, 'webhook_event_id');
    const purpose = stringOf(event, 'purpose');
    const daraja = this.b2c;
    if (!daraja) throw new Error('Daraja B2C is not configured.');
    await this.db.asPlatform(async (tx) => {
      const stored = await tx.webhook_event.findUniqueOrThrow({ where: { id: webhookEventId } });
      if (stored.processed_at) return;
      const result =
        purpose === 'b2c'
          ? daraja.parseB2cResult(stored.payload_raw)
          : daraja.parseStatusResult(stored.payload_raw);
      const row = await this.lock(tx, result.payoutId);
      const asset = await tx.asset.findUniqueOrThrow({ where: { code: row.asset_code } });
      let outcome: string = result.outcome;
      const live = ['pending_provider', 'status_unknown'].includes(row.status);
      if (result.outcome === 'pending') {
        outcome = 'ignored_pending';
      } else if (!live) {
        // Already final: a result can only confirm it or contradict it.
        if ((result.outcome === 'succeeded') !== (row.status === 'succeeded')) {
          await this.reconciliation.openException(tx, {
            runId: null,
            tenantId: row.tenant_id,
            type: 'provider_result_conflict',
            subjectType: 'payout',
            subjectRef: row.id,
            detail: {
              reason: 'result_contradicts_status',
              result: result.outcome,
              status: row.status,
            },
          });
          outcome = 'conflict';
        } else {
          outcome = 'duplicate_ignored';
        }
      } else if (result.outcome === 'failed') {
        await this.fail(tx, row, `provider_${result.resultCode}`, 'webhook');
      } else if (decimalTextToMinor(result.amountText, asset.exponent) !== row.amount) {
        // Money moved, but not the amount AORA asked for: an operator must look.
        await transitionOperation(
          tx,
          this.audit,
          'payout',
          row,
          'reconciliation_required',
          'webhook',
          'amount_mismatch',
        );
        await this.reconciliation.openException(tx, {
          runId: null,
          tenantId: row.tenant_id,
          type: 'amount_mismatch',
          subjectType: 'payout',
          subjectRef: row.id,
          detail: {
            payout_amount_minor: row.amount.toString(),
            provider_amount: result.amountText,
          },
        });
        outcome = 'amount_mismatch';
      } else {
        await this.succeed(tx, row, result.receipt, 'webhook');
      }
      await tx.webhook_event.update({
        where: { id: stored.id },
        data: { processed_at: new Date(), outcome },
      });
    });
  }

  // --- Internals ---

  private async succeed(
    tx: Tx,
    row: Payout,
    receipt: string | null,
    source: 'inquiry' | 'webhook',
  ): Promise<void> {
    await transitionOperation(
      tx,
      this.audit,
      'payout',
      row,
      'succeeded',
      source,
      null,
      receipt ? { receipt } : {},
    );
    await this.notify(tx, row, 'payout.succeeded');
    const inFlight = await this.ledger.findAccount(tx, {
      tenantId: row.tenant_id,
      type: 'merchant_payouts_in_flight',
      assetCode: row.asset_code,
    });
    await this.ledger.post(tx, {
      idempotencyKey: `payout:${row.id}:sent`,
      tenantId: row.tenant_id,
      entryType: 'payout',
      operationType: 'payout',
      operationId: row.id,
      postings: [
        { accountId: inFlight, direction: 'debit', amount: row.amount + row.fee_amount },
        {
          accountId: await this.ledger.findAccount(tx, {
            tenantId: null,
            type: 'provider_payout_float',
            assetCode: row.asset_code,
            qualifier: row.provider,
          }),
          direction: 'credit',
          amount: row.amount,
        },
        ...(row.fee_amount > 0n
          ? [
              {
                accountId: await this.ledger.findAccount(tx, {
                  tenantId: null,
                  type: 'fee_revenue',
                  assetCode: row.asset_code,
                }),
                direction: 'credit' as const,
                amount: row.fee_amount,
              },
            ]
          : []),
      ],
    });
  }

  /** Fails the payout and gives the reservation back, exactly, with a compensating entry. */
  private async fail(
    tx: Tx,
    row: Payout,
    reason: string,
    source: 'adapter' | 'inquiry' | 'webhook',
  ): Promise<void> {
    await transitionOperation(tx, this.audit, 'payout', row, 'failed', source, reason, {
      failure_code: reason,
    });
    await this.notify(tx, row, 'payout.failed');
    const reservation = await this.ledger.findEntryByKey(tx, reservationKey(row.id));
    if (reservation) await this.ledger.reverse(tx, reservation.id, `payout:${row.id}:released`);
  }

  /** The merchant's own systems hear about it through their webhook, in this same transaction. */
  private async notify(
    tx: Tx,
    row: Payout,
    type: 'payout.succeeded' | 'payout.failed',
  ): Promise<void> {
    await this.developer.emit(tx, {
      tenantId: row.tenant_id,
      type,
      subjectId: row.id,
      data: {
        id: row.id,
        status: type === 'payout.succeeded' ? 'succeeded' : 'failed',
        amount_minor: row.amount.toString(),
        fee_minor: row.fee_amount.toString(),
        currency: row.asset_code,
      },
    });
  }

  private async scheduleInquiry(tx: Tx, row: Payout, delayed: boolean): Promise<void> {
    await this.outbox.enqueue(tx, {
      tenantId: row.tenant_id,
      type: EVENT_PAYOUT_INQUIRY,
      payload: { payout_id: row.id },
      availableAt: new Date(
        Date.now() + (delayed ? this.config.payments.statusInquiryDelaySeconds * 1000 : 0),
      ),
    });
  }

  private resultUrl(purpose: 'b2c' | 'b2c_status', payoutId: string): string {
    const path = purpose === 'b2c' ? 'b2c' : 'b2c-status';
    const token = this.b2c?.callbackToken(payoutId, purpose) ?? '';
    return `${this.config.publicApiUrl}/v1/webhooks/daraja/${path}/${payoutId}/${token}`;
  }

  private async lock(tx: Tx, payoutId: string): Promise<Payout> {
    await tx.$queryRaw`select id from payments.payout where id = ${payoutId}::uuid for update`;
    return tx.payout.findUniqueOrThrow({ where: { id: payoutId } });
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
