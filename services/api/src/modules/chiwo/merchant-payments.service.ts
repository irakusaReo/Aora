import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Database, type Tx } from '../../platform/database.js';
import { AppError } from '../../platform/errors.js';
import { RateLimiter } from '../../platform/rate-limit.js';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { OutboxService, type OutboxEvent } from '../outbox/outbox.service.js';
import type { DarajaAdapter } from '../payments/daraja.js';
import {
  DARAJA_ADAPTER,
  EVENT_CHIWO_PAYMENT_RESULT,
  type IntentStatus,
  PaymentsService,
} from '../payments/payments.service.js';
import type { Scenario } from '../payments/simulator.js';

export type MerchantPaymentStatus =
  'submitted' | 'being_checked' | 'succeeded' | 'failed' | 'reconciliation_required';

/**
 * The consumer's side of a payment to a merchant (phase-7 P7-4). It follows the
 * merchant's payment intent and never moves by itself.
 */
export const MERCHANT_PAYMENT_TRANSITIONS: Readonly<
  Record<MerchantPaymentStatus, readonly MerchantPaymentStatus[]>
> = {
  submitted: ['succeeded', 'failed', 'being_checked', 'reconciliation_required'],
  being_checked: ['succeeded', 'failed', 'reconciliation_required'],
  succeeded: ['reconciliation_required'],
  failed: ['reconciliation_required'],
  reconciliation_required: [],
};

/** What each intent status means to the consumer; null leaves the payment as it is. */
const FROM_INTENT: Record<IntentStatus, MerchantPaymentStatus | null> = {
  created: null,
  submitting: null,
  pending_provider: null,
  status_unknown: 'being_checked',
  succeeded: 'succeeded',
  failed: 'failed',
  reconciliation_required: 'reconciliation_required',
};

const OPERATION = 'merchant_payment';
const RAIL = 'mpesa';

export interface MerchantView {
  readonly code: string;
  readonly trading_name: string;
}

export interface PaymentQuote {
  readonly pay_code: string;
  readonly amount_minor: string;
  /** What the consumer pays on top: nothing; the tariff charges the merchant. */
  readonly fee_minor: string;
  readonly total_minor: string;
  readonly currency: string;
  readonly rail: string;
  readonly provider: 'daraja_sandbox' | 'simulator';
  /** In the sandbox the payment prompt never reaches the consumer's own phone (O-14). */
  readonly payer_number: 'sandbox_test_number';
  readonly timing: string;
  readonly merchant: MerchantView;
}

export interface MerchantPaymentView {
  readonly id: string;
  readonly status: MerchantPaymentStatus;
  readonly amount_minor: string;
  readonly fee_minor: string;
  readonly total_minor: string;
  readonly currency: string;
  readonly rail: string;
  readonly merchant: MerchantView;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ReceiptView extends MerchantPaymentView {
  readonly kind: 'merchant_payment';
  readonly reference: string;
  readonly payer_number: 'sandbox_test_number';
}

type Row = {
  id: string;
  consumer_account_id: string;
  idempotency_key: string;
  request_hash: string;
  pay_code: string;
  tenant_id: string;
  amount: bigint;
  fee_minor: bigint;
  asset_code: string;
  rail: string;
  intent_id: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
};

@Injectable()
export class MerchantPaymentsService implements OnModuleInit {
  private readonly logger = new Logger(MerchantPaymentsService.name);

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(RateLimiter) private readonly rateLimiter: RateLimiter,
    @Inject(DARAJA_ADAPTER) private readonly daraja: DarajaAdapter | null,
  ) {}

  onModuleInit(): void {
    this.outbox.register(EVENT_CHIWO_PAYMENT_RESULT, (event) => this.handleResult(event));
  }

  /** The trading name behind an active pay code, and nothing else (P7-3). */
  async lookup(accountId: string, code: string): Promise<MerchantView> {
    await this.rateLimiter.consume('chiwo_merchant_lookup', accountId);
    return this.db.asPlatform(async (tx) => (await this.activeCode(tx, code)).merchant);
  }

  async quote(
    accountId: string,
    input: { payCode: string; amount: bigint; currency: string },
  ): Promise<PaymentQuote> {
    await this.rateLimiter.consume('chiwo_merchant_lookup', accountId);
    return this.db.asPlatform(async (tx) => {
      const { merchant } = await this.activeCode(tx, input.payCode);
      return this.quoteIn(tx, merchant, input);
    });
  }

  /**
   * Starts a payment. The consumer's record is committed first, so no money can
   * move without it; the merchant's collection follows, idempotently, keyed by
   * that record. A repeat of the request finishes whatever the first one began.
   */
  async pay(
    actor: { accountId: string; requestId: string },
    idempotencyKey: string,
    input: {
      payCode: string;
      amount: bigint;
      currency: string;
      expectedFee: bigint;
      expectedTotal: bigint;
      scenario: Scenario | null;
    },
  ): Promise<{ payment: MerchantPaymentView; replayed: boolean }> {
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify([
          input.payCode,
          input.amount.toString(),
          input.currency,
          input.expectedFee.toString(),
          input.expectedTotal.toString(),
          input.scenario,
        ]),
      )
      .digest('hex');

    const { row, branchId, replayed } = await this.db.asPlatform(async (tx) => {
      // One request at a time per consumer: the daily limit counts what is committed.
      await tx.$queryRaw`
        select account_id from chiwo.consumer where account_id = ${actor.accountId}::uuid for update`;
      const earlier = await tx.merchant_payment.findFirst({
        where: { consumer_account_id: actor.accountId, idempotency_key: idempotencyKey },
      });
      if (earlier) {
        if (earlier.request_hash !== requestHash) {
          throw new AppError(
            'idempotency_key_reused',
            'This Idempotency-Key was already used with a different request.',
          );
        }
        const code = await tx.pay_code.findUniqueOrThrow({ where: { code: earlier.pay_code } });
        return { row: earlier, branchId: code.branch_id, replayed: true };
      }
      const { code, merchant } = await this.activeCode(tx, input.payCode);
      const quote = await this.quoteIn(tx, merchant, input);
      if (
        quote.fee_minor !== input.expectedFee.toString() ||
        quote.total_minor !== input.expectedTotal.toString()
      ) {
        throw new AppError('fee_changed', 'The fee or total changed. Review the new quote.');
      }
      await this.assertWithinLimits(tx, actor.accountId, input.currency, input.amount);
      const created = await tx.merchant_payment.create({
        data: {
          consumer_account_id: actor.accountId,
          idempotency_key: idempotencyKey,
          request_hash: requestHash,
          pay_code: code.code,
          tenant_id: code.tenant_id,
          amount: input.amount,
          fee_minor: BigInt(quote.fee_minor),
          asset_code: input.currency,
          rail: RAIL,
        },
      });
      await this.audit.record(tx, {
        tenantId: null,
        actorKind: 'user',
        actorAccountId: actor.accountId,
        action: 'chiwo.merchant_payment.created',
        subjectType: 'chiwo_merchant_payment',
        subjectId: created.id,
        outcome: 'success',
        requestId: actor.requestId,
        detail: { amount_minor: input.amount.toString(), currency: input.currency },
      });
      return { row: created, branchId: code.branch_id, replayed: false };
    });

    if (row.intent_id === null && row.status === 'submitted') {
      await this.startCollection(actor, row, branchId, input.scenario);
    }
    return { payment: await this.get(actor.accountId, row.id), replayed };
  }

  async get(accountId: string, id: string): Promise<MerchantPaymentView> {
    const row = await this.db.withConsumer(accountId, (tx) =>
      tx.merchant_payment.findFirst({ where: { id, consumer_account_id: accountId } }),
    );
    if (!row) throw new AppError('not_found', 'Payment not found.');
    const [view] = await this.withMerchants([row]);
    if (!view) throw new AppError('not_found', 'Payment not found.');
    return view;
  }

  async list(accountId: string, limit = 50): Promise<MerchantPaymentView[]> {
    const rows = await this.db.withConsumer(accountId, (tx) =>
      tx.merchant_payment.findMany({
        where: { consumer_account_id: accountId },
        orderBy: { created_at: 'desc' },
        take: limit,
      }),
    );
    return this.withMerchants(rows);
  }

  async receipt(accountId: string, id: string): Promise<ReceiptView> {
    const view = await this.get(accountId, id);
    return {
      ...view,
      kind: 'merchant_payment',
      reference: view.id,
      payer_number: 'sandbox_test_number',
    };
  }

  // --- internals ---

  private async startCollection(
    actor: { accountId: string; requestId: string },
    row: Row,
    branchId: string | null,
    scenario: Scenario | null,
  ): Promise<void> {
    // A scripted scenario goes to the simulator; otherwise Daraja serves the
    // mpesa rail when configured, and only its test number may be asked to pay (O-14).
    const payerPhone = !scenario && this.daraja ? this.daraja.testPayer : null;
    let intentId: string;
    try {
      const { intent } = await this.payments.createIntent({
        tenantId: row.tenant_id,
        accountId: actor.accountId,
        requestId: actor.requestId,
        idempotencyKey: `chiwo:${row.id}`,
        amount: row.amount,
        assetCode: row.asset_code,
        rail: row.rail,
        branchId,
        reference: `CHIWO-${row.id.slice(0, 8)}`,
        scenario,
        payerPhone,
        channel: 'chiwo',
      });
      intentId = intent.id;
    } catch (error) {
      // Refused before any money could move (a merchant limit, say): the payment ends here.
      if (error instanceof AppError) {
        await this.db.asPlatform((tx) =>
          tx.merchant_payment.updateMany({
            where: { id: row.id, status: 'submitted', intent_id: null },
            data: { status: 'failed' },
          }),
        );
      }
      throw error;
    }
    await this.db.asPlatform(async (tx) => {
      await tx.merchant_payment.updateMany({
        where: { id: row.id, intent_id: null },
        data: { intent_id: intentId },
      });
      // A result that arrived before the link was written is applied now.
      await this.applyIntentStatus(tx, row.id);
    });
  }

  private async handleResult(event: OutboxEvent): Promise<void> {
    const intentId = (event.payload as { intent_id?: unknown }).intent_id;
    if (typeof intentId !== 'string') throw new Error(`Outbox event ${event.id} has no intent_id.`);
    await this.db.asPlatform(async (tx) => {
      const row = await tx.merchant_payment.findFirst({ where: { intent_id: intentId } });
      // Not linked yet: startCollection applies the status once it links.
      if (!row) return;
      await this.applyIntentStatus(tx, row.id);
    });
  }

  /** Moves the payment to what its intent now says, if that is a legal step. At least once. */
  private async applyIntentStatus(tx: Tx, id: string): Promise<void> {
    await tx.$queryRaw`select id from chiwo.merchant_payment where id = ${id}::uuid for update`;
    const row = await tx.merchant_payment.findUniqueOrThrow({ where: { id } });
    if (!row.intent_id) return;
    const intent = await tx.payment_intent.findUniqueOrThrow({ where: { id: row.intent_id } });
    const target = FROM_INTENT[intent.status as IntentStatus];
    const from = row.status as MerchantPaymentStatus;
    if (!target || target === from) return;
    if (!MERCHANT_PAYMENT_TRANSITIONS[from].includes(target)) {
      this.logger.warn(`CHIWO payment ${row.id}: ignored ${from} -> ${target}`);
      return;
    }
    await tx.merchant_payment.update({ where: { id }, data: { status: target } });
    await this.audit.record(tx, {
      tenantId: null,
      actorKind: 'system',
      action: `chiwo.merchant_payment.${target}`,
      subjectType: 'chiwo_merchant_payment',
      subjectId: id,
      outcome: 'success',
      detail: { from, to: target },
    });
    if (target === 'succeeded') {
      const [asset, merchant] = await Promise.all([
        tx.asset.findUniqueOrThrow({ where: { code: row.asset_code } }),
        this.tradingName(tx, row.tenant_id),
      ]);
      await this.notifications.notify(tx, {
        dedupeKey: `chiwo.payment.receipt:${row.id}`,
        accountId: row.consumer_account_id,
        tenantId: null,
        type: 'chiwo.payment.receipt',
        params: {
          amount_minor: row.amount.toString(),
          currency: row.asset_code,
          exponent: asset.exponent,
          merchant,
          reference: row.id,
        },
      });
    }
  }

  private async activeCode(
    tx: Tx,
    code: string,
  ): Promise<{
    code: { code: string; tenant_id: string; branch_id: string | null };
    merchant: MerchantView;
  }> {
    const row = await tx.pay_code.findUnique({ where: { code } });
    if (!row || row.status !== 'active') throw new AppError('not_found', 'Merchant not found.');
    return {
      code: row,
      merchant: { code: row.code, trading_name: await this.tradingName(tx, row.tenant_id) },
    };
  }

  private async tradingName(tx: Tx, tenantId: string): Promise<string> {
    const rows = await tx.$queryRaw<{ name: string }[]>`
      select b.name from tenancy.workspace w join business.business b on b.id = w.business_id
       where w.id = ${tenantId}::uuid`;
    const name = rows[0]?.name;
    if (!name) throw new AppError('not_found', 'Merchant not found.');
    return name;
  }

  private async quoteIn(
    tx: Tx,
    merchant: MerchantView,
    input: { amount: bigint; currency: string },
  ): Promise<PaymentQuote> {
    const asset = await tx.asset.findUnique({ where: { code: input.currency } });
    if (!asset || asset.kind !== 'fiat') {
      throw new AppError('capability_not_supported', 'This currency cannot be paid on M-Pesa.');
    }
    if (input.amount <= 0n) throw new AppError('invalid_request', 'Invalid request: amount_minor.');
    if (this.daraja && input.amount % 10n ** BigInt(asset.exponent) !== 0n) {
      throw new AppError('invalid_request', 'M-Pesa amounts are whole shillings.');
    }
    const note = await tx.timing_note.findFirst({
      where: { rail: RAIL, effective_from: { lte: new Date() } },
      orderBy: { effective_from: 'desc' },
    });
    // The tariff charges the merchant; the consumer pays exactly the amount (P7-5).
    const fee = 0n;
    return {
      pay_code: merchant.code,
      amount_minor: input.amount.toString(),
      fee_minor: fee.toString(),
      total_minor: (input.amount + fee).toString(),
      currency: input.currency,
      rail: RAIL,
      provider: this.daraja ? 'daraja_sandbox' : 'simulator',
      payer_number: 'sandbox_test_number',
      timing: note?.body ?? '',
      merchant,
    };
  }

  /** Limits are data (P7-7): the newest version in effect; with none, nothing is allowed. */
  private async assertWithinLimits(
    tx: Tx,
    accountId: string,
    currency: string,
    amount: bigint,
  ): Promise<void> {
    const limit = await tx.consumer_limit.findFirst({
      where: { operation: OPERATION, asset_code: currency, effective_from: { lte: new Date() } },
      orderBy: { effective_from: 'desc' },
    });
    if (!limit || amount > limit.per_payment_max) {
      throw new AppError('limit_exceeded', 'This amount is above your limit for one payment.');
    }
    // The day is Nairobi's (UTC+3, no daylight saving).
    const rows = await tx.$queryRaw<{ total: bigint | null }[]>`
      select sum(amount)::bigint as total from chiwo.merchant_payment
       where consumer_account_id = ${accountId}::uuid and asset_code = ${currency}
         and status <> 'failed'
         and created_at >= date_trunc('day', now() at time zone 'Africa/Nairobi') at time zone 'Africa/Nairobi'`;
    if ((rows[0]?.total ?? 0n) + amount > limit.per_day_max) {
      throw new AppError('limit_exceeded', 'This payment would take you over your daily limit.');
    }
  }

  private async withMerchants(rows: Row[]): Promise<MerchantPaymentView[]> {
    if (rows.length === 0) return [];
    const names = await this.db.asPlatform(async (tx) => {
      const map = new Map<string, string>();
      for (const tenantId of new Set(rows.map((row) => row.tenant_id))) {
        map.set(tenantId, await this.tradingName(tx, tenantId));
      }
      return map;
    });
    return rows.map((row) => ({
      id: row.id,
      status: row.status as MerchantPaymentStatus,
      amount_minor: row.amount.toString(),
      fee_minor: row.fee_minor.toString(),
      total_minor: (row.amount + row.fee_minor).toString(),
      currency: row.asset_code,
      rail: row.rail,
      merchant: { code: row.pay_code, trading_name: names.get(row.tenant_id) ?? '' },
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    }));
  }
}
