import { createHash } from 'node:crypto';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { APP_CONFIG, type AppConfig } from '../../platform/config.js';
import { Database, type Tx } from '../../platform/database.js';
import { AppError } from '../../platform/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { OutboxService, type OutboxEvent } from '../outbox/outbox.service.js';
import { EVENT_LAYAWAY_PAYMENT_RESULT, PaymentsService } from '../payments/payments.service.js';
import { ReconciliationService } from '../payments/reconciliation.service.js';
import { type Scenario, SimulatorProvider } from '../payments/simulator.js';
import { SANDBOX_PROVIDER } from '../../seed-data.js';
import { FeatureFlagsService } from '../ops/feature-flags.js';
import { AGREEMENT_TERMS_KEY, type CreditOffer, creditOffer, kidKey } from './credit/offer.js';
import {
  allowedTemplates,
  EVENT_REFUND_SUBMIT,
  effective,
  lockPurchaseForBuyer,
  movePurchase,
  type PlanTemplate,
  type PlanType,
  payloadId,
  priceOf,
  type PurchaseRow,
  type PurchaseStatus,
  purchaseEvent,
  release,
  reserve,
} from './purchase-common.js';
import {
  basisPoints,
  cancellationRefund,
  layawaySchedule,
  nairobiToday,
  type ScheduleLine,
} from './schedule.js';

export { PURCHASE_TRANSITIONS, type PurchaseStatus } from './purchase-common.js';
export type PlanStatus = 'active' | 'paid_in_full' | 'settled' | 'cancelled' | 'refunded';

const TERMS_KEY = 'kelo_layaway_terms';
const EVENT_REFUND_INQUIRY = 'kelo.layaway.refund_inquiry';
/** A claim older than this with no payment behind it is taken to have been abandoned. */
const STALE_CLAIM_SECONDS = 120;

type Purchase = Prisma.purchaseGetPayload<{
  include: { layaway_instalment: true; layaway_refund: true };
}>;

export interface PlanOffer {
  readonly template_key: string;
  readonly name: string;
  readonly plan_type: 'layaway';
  readonly instalments: { seq: number; due_on: string; amount_minor: string }[];
  readonly total_minor: string;
  /** What the buyer pays on top of the price. Layaway: nothing. */
  readonly fees_minor: string;
  readonly currency: string;
  readonly receive_after_last_payment: true;
  readonly cancellation: {
    fee_bps: number;
    fee_cap_minor: string;
    after_start_returned_bps: number;
  };
  readonly terms: { key: string; version: string };
}

export interface BuyerPurchaseView {
  readonly id: string;
  readonly status: PurchaseStatus;
  readonly plan_status: PlanStatus;
  readonly plan_type: PlanType;
  readonly listing_id: string;
  readonly listing_title: string;
  readonly total_minor: string;
  readonly paid_minor: string;
  readonly currency: string;
  /** Layaway: the item comes after the last payment. Credit: it comes first. */
  readonly receive_after_last_payment: boolean;
  /** Layaway instalments; a credit purchase's are in its agreement (`credit`). */
  readonly instalments: { seq: number; due_on: string; amount_minor: string; status: string }[];
  readonly refund: {
    paid_minor: string;
    fee_minor: string;
    refund_minor: string;
    status: string;
  } | null;
  readonly created_at: string;
}

export interface MerchantPurchaseView {
  readonly id: string;
  readonly status: PurchaseStatus;
  readonly plan_status: PlanStatus;
  /** Layaway or a BNPL plan; never anything about the buyer's credit (P8-9). */
  readonly plan_type: PlanType;
  readonly listing_title: string;
  readonly total_minor: string;
  readonly paid_minor: string;
  readonly merchant_fee_minor: string;
  readonly net_minor: string;
  readonly currency: string;
  /** What the merchant should do next, in a code a screen can word. */
  readonly next_action:
    | 'wait_for_payments'
    | 'confirm'
    | 'fulfil'
    | 'wait_for_buyer'
    | 'respond_to_return'
    | 'wait_for_decision'
    | 'none';
  readonly created_at: string;
}

const INCLUDE = { layaway_instalment: true, layaway_refund: true, listing: true } as const;

function serialiseSchedule(lines: ScheduleLine[]): PlanOffer['instalments'] {
  return lines.map((line) => ({ ...line, amount_minor: line.amount_minor.toString() }));
}

function buyerView(row: Purchase, listingTitle: string): BuyerPurchaseView {
  const refund = row.layaway_refund;
  return {
    id: row.id,
    status: row.status as PurchaseStatus,
    plan_status: row.plan_status as PlanStatus,
    plan_type: row.plan_type as PlanType,
    listing_id: row.listing_id,
    listing_title: listingTitle,
    total_minor: row.total_minor.toString(),
    paid_minor: row.paid_minor.toString(),
    currency: row.currency,
    receive_after_last_payment: row.plan_type === 'layaway',
    instalments: [...row.layaway_instalment]
      .sort((a, b) => a.seq - b.seq)
      .map((line) => ({
        seq: line.seq,
        due_on: line.due_on.toISOString().slice(0, 10),
        amount_minor: line.amount_minor.toString(),
        // A claim in progress is shown as what it is to the buyer: being checked.
        status: line.status === 'submitting' ? 'pending' : line.status,
      })),
    refund: refund
      ? {
          paid_minor: refund.paid_minor.toString(),
          fee_minor: refund.fee_minor.toString(),
          refund_minor: refund.refund_minor.toString(),
          status: refund.status,
        }
      : null,
    created_at: row.created_at.toISOString(),
  };
}

function merchantView(row: PurchaseRow & { listing: { title: string } }): MerchantPurchaseView {
  const status = row.status as PurchaseStatus;
  // A credit order is paid by KELO on fulfilment, so it never waits for the buyer's payments.
  const paidInFull = row.plan_type !== 'layaway' || row.plan_status === 'paid_in_full';
  const next: MerchantPurchaseView['next_action'] =
    status === 'placed'
      ? 'wait_for_payments'
      : status === 'payment_ready'
        ? 'confirm'
        : status === 'merchant_confirmed'
          ? paidInFull
            ? 'fulfil'
            : 'wait_for_payments'
          : 'none';
  return {
    id: row.id,
    status,
    plan_status: row.plan_status as PlanStatus,
    plan_type: row.plan_type as PlanType,
    listing_title: row.listing.title,
    total_minor: row.total_minor.toString(),
    paid_minor: row.paid_minor.toString(),
    merchant_fee_minor: row.merchant_fee_minor.toString(),
    net_minor: (row.total_minor - row.merchant_fee_minor).toString(),
    currency: row.currency,
    next_action: next,
    created_at: row.created_at.toISOString(),
  };
}

/**
 * KELO layaway (ADRs 0017, 0018; journey K4). No credit: the buyer pays in
 * instalments before receiving the item; KELO holds the money for the buyer
 * until fulfilment, then settles the merchant net of the discount fee.
 */
@Injectable()
export class LayawayService implements OnModuleInit {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(SimulatorProvider) private readonly simulator: SimulatorProvider,
    @Inject(ReconciliationService) private readonly reconciliation: ReconciliationService,
    @Inject(FeatureFlagsService) private readonly flags: FeatureFlagsService,
  ) {}

  onModuleInit(): void {
    this.outbox.register(EVENT_LAYAWAY_PAYMENT_RESULT, (event) => this.handlePaymentResult(event));
    this.outbox.register(EVENT_REFUND_SUBMIT, (event) =>
      this.submitRefund(payloadId(event, 'refund_id')),
    );
    this.outbox.register(EVENT_REFUND_INQUIRY, (event) =>
      this.inquireRefund(payloadId(event, 'refund_id')),
    );
  }

  // --- Plans: the merchant's choice, and what the buyer is shown ---

  async planOptions(
    tenantId: string,
    listingId: string,
  ): Promise<
    {
      template_key: string;
      name: string;
      plan_type: string;
      instalment_count: number;
      interval_days: number;
      merchant_fee_bps: number;
      offered: boolean;
    }[]
  > {
    return this.db.asPlatform(async (tx) => {
      const listing = await tx.listing.findFirst({ where: { id: listingId, tenant_id: tenantId } });
      if (!listing) throw new AppError('not_found', 'Listing not found.');
      const templates = await this.allowedTemplates(tx, listing.category_slug);
      const offers = await tx.listing_plan_offer.findMany({
        where: { listing_id: listing.id, withdrawn_at: null },
      });
      const offered = new Set(offers.map((offer) => offer.template_key));
      return templates.map((template) => ({
        template_key: template.key,
        name: template.name,
        plan_type: template.plan_type,
        instalment_count: template.instalment_count,
        interval_days: template.interval_days,
        merchant_fee_bps: template.merchant_fee_bps,
        offered: offered.has(template.key),
      }));
    });
  }

  async offerPlan(
    actor: { tenantId: string; accountId: string; requestId: string },
    listingId: string,
    templateKey: string,
  ): Promise<{ template_key: string; offered: true }> {
    return this.db.asPlatform(async (tx) => {
      const listing = await tx.listing.findFirst({
        where: { id: listingId, tenant_id: actor.tenantId },
      });
      if (!listing) throw new AppError('not_found', 'Listing not found.');
      if (listing.type === 'quote_service') {
        throw new AppError('invalid_request', 'A service by quote has no fixed price to plan.');
      }
      const allowed = await this.allowedTemplates(tx, listing.category_slug);
      if (!allowed.some((template) => template.key === templateKey)) {
        throw new AppError(
          'invalid_request',
          'Invalid request: template_key is not allowed in this category.',
        );
      }
      await tx.$executeRaw`
        insert into kelo.listing_plan_offer (tenant_id, listing_id, template_key, created_by)
        values (${actor.tenantId}::uuid, ${listing.id}::uuid, ${templateKey}, ${actor.accountId}::uuid)
        on conflict (listing_id, template_key) where withdrawn_at is null do nothing`;
      await this.audit.record(tx, {
        tenantId: actor.tenantId,
        actorKind: 'user',
        actorAccountId: actor.accountId,
        action: 'kelo.plan.offered',
        subjectType: 'kelo_listing',
        subjectId: listing.id,
        outcome: 'success',
        requestId: actor.requestId,
        detail: { template_key: templateKey },
      });
      return { template_key: templateKey, offered: true };
    });
  }

  /** Every plan the buyer may choose for this price, computed by the one schedule engine. */
  async plansFor(
    listingId: string,
    choice: { variantId: string | null; sessionId: string | null },
  ): Promise<(PlanOffer | CreditOffer)[]> {
    return this.db.asPlatform(async (tx) => {
      const listing = await tx.listing.findFirst({ where: { id: listingId, status: 'published' } });
      if (!listing) throw new AppError('not_found', 'Listing not found.');
      const price = await priceOf(tx, listing.id, choice);
      const offers = await tx.listing_plan_offer.findMany({
        where: { listing_id: listing.id, withdrawn_at: null },
      });
      const allowed = await this.allowedTemplates(tx, listing.category_slug);
      const today = nairobiToday();
      const shown = allowed
        .filter((template) => offers.some((offer) => offer.template_key === template.key))
        .filter((template) => template.currency === listing.currency)
        .filter(
          (template) => price >= template.min_order_minor && price <= template.max_order_minor,
        )
        .filter((template) => price >= BigInt(template.instalment_count));
      const credit = await Promise.all(
        shown
          .filter((template) => template.plan_type !== 'layaway')
          .map(async (template) =>
            creditOffer(template, price, today, await this.creditDocuments(tx, template.key)),
          ),
      );
      const layaway = shown.filter((template) => template.plan_type === 'layaway');
      if (layaway.length === 0) return credit;
      const rule = await this.refundRule(tx, listing.category_slug);
      const terms = await this.currentTerms(tx);
      const layawayOffers: PlanOffer[] = layaway.map((template) => ({
        template_key: template.key,
        name: template.name,
        plan_type: 'layaway' as const,
        instalments: serialiseSchedule(
          layawaySchedule({
            totalMinor: price,
            instalmentCount: template.instalment_count,
            intervalDays: template.interval_days,
            startDate: today,
          }),
        ),
        total_minor: price.toString(),
        fees_minor: '0',
        currency: listing.currency,
        receive_after_last_payment: true as const,
        cancellation: {
          fee_bps: rule.fee_bps,
          fee_cap_minor: rule.fee_cap_minor.toString(),
          after_start_returned_bps: rule.after_start_returned_bps,
        },
        terms: { key: terms.key, version: terms.version },
      }));
      return [...layawayOffers, ...credit];
    });
  }

  // --- The buyer ---

  async purchase(
    actor: { accountId: string; requestId: string },
    idempotencyKey: string,
    input: {
      listingId: string;
      variantId: string | null;
      sessionId: string | null;
      templateKey: string;
      expectedTotalMinor: bigint;
      termsVersion: string;
    },
  ): Promise<{ purchase: BuyerPurchaseView; replayed: boolean }> {
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ ...input, expectedTotalMinor: input.expectedTotalMinor.toString() }))
      .digest('hex');
    return this.db.asPlatform(async (tx) => {
      const earlier = await tx.purchase.findUnique({
        where: {
          consumer_account_id_idempotency_key: {
            consumer_account_id: actor.accountId,
            idempotency_key: idempotencyKey,
          },
        },
        include: INCLUDE,
      });
      if (earlier) {
        if (earlier.request_hash !== requestHash) {
          throw new AppError(
            'idempotency_key_reused',
            'This Idempotency-Key was already used with a different request.',
          );
        }
        return { purchase: buyerView(earlier, earlier.listing.title), replayed: true };
      }

      const listing = await tx.listing.findFirst({
        where: { id: input.listingId, status: 'published' },
      });
      if (!listing) throw new AppError('not_found', 'Listing not found.');
      const offer = await tx.listing_plan_offer.findFirst({
        where: { listing_id: listing.id, template_key: input.templateKey, withdrawn_at: null },
      });
      const template = (await this.allowedTemplates(tx, listing.category_slug)).find(
        (row) => row.key === input.templateKey,
      );
      if (!offer || !template)
        throw new AppError('invalid_request', 'Invalid request: template_key.');
      // A credit plan is bought with an approved decision (P8-5), never here.
      if (template.plan_type !== 'layaway') {
        throw new AppError('invalid_request', 'A credit plan needs a decision_id.');
      }
      const price = await priceOf(tx, listing.id, input);
      // What the buyer was shown is what is charged, to the minor unit (ADR 0018).
      if (price !== input.expectedTotalMinor) {
        throw new AppError(
          'fee_changed',
          'The total has changed. Review the new total before you agree.',
        );
      }
      if (price < template.min_order_minor || price > template.max_order_minor) {
        throw new AppError('invalid_request', 'This plan is not available for this price.');
      }
      const now = new Date();
      const terms = await tx.terms_document.findFirst({
        where: {
          key: TERMS_KEY,
          version: input.termsVersion,
          effective_from: { lte: now },
          OR: [{ effective_to: null }, { effective_to: { gt: now } }],
        },
      });
      if (!terms) throw new AppError('invalid_request', 'That terms version is not in effect.');
      const rule = await this.refundRule(tx, listing.category_slug);

      await reserve(tx, listing.id, input);

      const account = await tx.user_account.findUniqueOrThrow({ where: { id: actor.accountId } });
      const consent = await tx.consent_record.create({
        data: {
          person_id: account.person_id,
          account_id: account.id,
          capacity: 'personal',
          action: 'kelo.layaway.accept',
          terms_document_id: terms.id,
          request_id: actor.requestId,
        },
      });
      const created = await tx.purchase.create({
        data: {
          tenant_id: listing.tenant_id,
          consumer_account_id: actor.accountId,
          idempotency_key: idempotencyKey,
          request_hash: requestHash,
          listing_id: listing.id,
          variant_id: input.variantId,
          session_id: input.sessionId,
          plan_type: 'layaway',
          template_id: template.id,
          refund_rule_id: rule.id,
          consent_id: consent.id,
          total_minor: price,
          merchant_fee_minor: basisPoints(price, template.merchant_fee_bps),
          currency: listing.currency,
        },
      });
      const schedule = layawaySchedule({
        totalMinor: price,
        instalmentCount: template.instalment_count,
        intervalDays: template.interval_days,
        startDate: nairobiToday(now),
      });
      await tx.layaway_instalment.createMany({
        data: schedule.map((line) => ({
          tenant_id: listing.tenant_id,
          consumer_account_id: actor.accountId,
          purchase_id: created.id,
          seq: line.seq,
          due_on: new Date(`${line.due_on}T00:00:00Z`),
          amount_minor: line.amount_minor,
        })),
      });
      await purchaseEvent(tx, created, 'status', null, 'placed', 'user', actor.accountId);
      await this.audit.record(tx, {
        tenantId: listing.tenant_id,
        actorKind: 'user',
        actorAccountId: actor.accountId,
        action: 'kelo.purchase.placed',
        subjectType: 'kelo_purchase',
        subjectId: created.id,
        outcome: 'success',
        requestId: actor.requestId,
        detail: { plan_type: 'layaway', template: template.key, version: template.version },
      });
      return {
        purchase: buyerView(
          await tx.purchase.findUniqueOrThrow({ where: { id: created.id }, include: INCLUDE }),
          listing.title,
        ),
        replayed: false,
      };
    });
  }

  async mine(accountId: string): Promise<BuyerPurchaseView[]> {
    const rows = await this.db.withConsumer(accountId, (tx) =>
      tx.purchase.findMany({
        where: { consumer_account_id: accountId },
        include: { layaway_instalment: true, layaway_refund: true },
        orderBy: { created_at: 'desc' },
        take: 100,
      }),
    );
    return this.withTitles(rows);
  }

  async one(accountId: string, purchaseId: string): Promise<BuyerPurchaseView> {
    const row = await this.db.withConsumer(accountId, (tx) =>
      tx.purchase.findFirst({
        where: { id: purchaseId, consumer_account_id: accountId },
        include: { layaway_instalment: true, layaway_refund: true },
      }),
    );
    if (!row) throw new AppError('not_found', 'Purchase not found.');
    const [view] = await this.withTitles([row]);
    if (!view) throw new AppError('not_found', 'Purchase not found.');
    return view;
  }

  /**
   * Starts the payment of the next instalment. The instalment is claimed for
   * this request first, so a second request can never push a second payment.
   */
  async payInstalment(
    actor: { accountId: string; requestId: string },
    idempotencyKey: string,
    input: {
      purchaseId: string;
      seq: number;
      scenario: Scenario | null;
      payerPhone: string | null;
    },
  ): Promise<{ seq: number; status: string; payment_intent_id: string }> {
    const claimKey = createHash('sha256').update(idempotencyKey).digest('hex');
    const claimed = await this.db.asPlatform(async (tx) => {
      const purchase = await lockPurchaseForBuyer(tx, actor.accountId, input.purchaseId);
      if (purchase.plan_status !== 'active' || purchase.status === 'cancelled') {
        throw new AppError('invalid_state_transition', 'This purchase takes no more payments.');
      }
      const lines = await tx.$queryRaw<
        {
          id: string;
          seq: number;
          status: string;
          claim_key: string | null;
          claimed_at: Date | null;
          amount_minor: bigint;
          payment_intent_id: string | null;
        }[]
      >`
        select id, seq, status, claim_key, claimed_at, amount_minor, payment_intent_id
          from kelo.layaway_instalment where purchase_id = ${purchase.id}::uuid order by seq for update`;
      const next = lines.find((line) => line.status !== 'paid' && line.status !== 'cancelled');
      if (!next || next.seq !== input.seq) {
        throw new AppError('invalid_state_transition', 'Instalments are paid in order.');
      }
      if (next.status === 'pending') {
        throw new AppError(
          'invalid_state_transition',
          'This payment is being checked. Wait for its result.',
        );
      }
      if (next.status === 'submitting' && next.claim_key !== claimKey) {
        const stale =
          next.claimed_at && next.claimed_at.getTime() < Date.now() - STALE_CLAIM_SECONDS * 1000;
        const abandoned = stale
          ? !(await tx.payment_intent.findFirst({
              where: { idempotency_key: intentKey(next.id, next.claim_key ?? '') },
            }))
          : false;
        if (!abandoned) {
          throw new AppError(
            'invalid_state_transition',
            'A payment for this instalment is being started.',
          );
        }
      }
      await tx.layaway_instalment.update({
        where: { id: next.id },
        data: { status: 'submitting', claim_key: claimKey, claimed_at: new Date() },
      });
      return {
        instalmentId: next.id,
        amount: next.amount_minor,
        tenantId: purchase.tenant_id,
        currency: purchase.currency,
      };
    });

    // The payment, in its own transaction; a repeat of this request replays it.
    const { intent } = await this.payments.createIntent({
      tenantId: claimed.tenantId,
      accountId: actor.accountId,
      requestId: actor.requestId,
      idempotencyKey: intentKey(claimed.instalmentId, claimKey),
      amount: claimed.amount,
      assetCode: claimed.currency,
      rail: 'mpesa',
      branchId: null,
      reference: null,
      scenario: input.scenario,
      payerPhone: input.payerPhone,
      purpose: 'kelo_layaway',
    });
    return this.db.asPlatform(async (tx) => {
      const updated = await tx.layaway_instalment.updateMany({
        where: { id: claimed.instalmentId, status: 'submitting', claim_key: claimKey },
        data: { status: 'pending', payment_intent_id: intent.id },
      });
      const line = await tx.layaway_instalment.findUniqueOrThrow({
        where: { id: claimed.instalmentId },
      });
      if (updated.count !== 1 && line.payment_intent_id !== intent.id) {
        throw new AppError(
          'invalid_state_transition',
          'This instalment changed while the payment started.',
        );
      }
      return { seq: line.seq, status: 'pending', payment_intent_id: intent.id };
    });
  }

  /** An instalment's payment reached a final state (from payments, through the outbox). */
  private async handlePaymentResult(event: OutboxEvent): Promise<void> {
    const intentId = payloadId(event, 'intent_id');
    const outcome = (event.payload as { outcome?: unknown }).outcome;
    await this.db.asPlatform(async (tx) => {
      const line = await tx.layaway_instalment.findFirst({
        where: { payment_intent_id: intentId },
      });
      if (!line) return;
      const purchase = await this.lockPurchase(tx, line.purchase_id);
      await tx.$queryRaw`select id from kelo.layaway_instalment where id = ${line.id}::uuid for update`;
      const current = await tx.layaway_instalment.findUniqueOrThrow({ where: { id: line.id } });
      // At least once: a result already applied changes nothing.
      if (current.status !== 'pending' || current.payment_intent_id !== intentId) return;
      if (outcome === 'failed') {
        await tx.layaway_instalment.update({
          where: { id: line.id },
          data: { status: 'due', payment_intent_id: null, claim_key: null, claimed_at: null },
        });
        return;
      }
      await tx.layaway_instalment.update({
        where: { id: line.id },
        data: { status: 'paid', paid_at: new Date() },
      });
      const paid = purchase.paid_minor + line.amount_minor;
      const paidInFull = paid === purchase.total_minor;
      await tx.purchase.update({
        where: { id: purchase.id },
        data: { paid_minor: paid, ...(paidInFull ? { plan_status: 'paid_in_full' } : {}) },
      });
      if (paidInFull)
        await purchaseEvent(tx, purchase, 'plan_status', 'active', 'paid_in_full', 'system', null);
      if (purchase.status === 'placed')
        await movePurchase(tx, purchase, 'payment_ready', 'system', null);
    });
  }

  async cancel(
    actor: { accountId: string; requestId: string },
    purchaseId: string,
  ): Promise<BuyerPurchaseView> {
    await this.db.asPlatform(async (tx) => {
      const purchase = await lockPurchaseForBuyer(tx, actor.accountId, purchaseId);
      if (purchase.plan_type !== 'layaway') {
        throw new AppError(
          'invalid_state_transition',
          'A credit purchase is cancelled by KELO credit.',
        );
      }
      if (!['placed', 'payment_ready', 'merchant_confirmed'].includes(purchase.status)) {
        throw new AppError('invalid_state_transition', 'This purchase can no longer be cancelled.');
      }
      const lines = await tx.layaway_instalment.findMany({ where: { purchase_id: purchase.id } });
      if (lines.some((line) => line.status === 'pending' || line.status === 'submitting')) {
        throw new AppError(
          'invalid_state_transition',
          'A payment is being checked. Cancel once it has a result.',
        );
      }
      const rule = await tx.refund_rule.findUniqueOrThrow({
        where: { id: purchase.refund_rule_id ?? '' },
      });
      const session = purchase.session_id
        ? await tx.listing_session.findUniqueOrThrow({ where: { id: purchase.session_id } })
        : null;
      const split = cancellationRefund({
        paidMinor: purchase.paid_minor,
        rule: {
          feeBps: rule.fee_bps,
          feeCapMinor: rule.fee_cap_minor,
          afterStartReturnedBps: rule.after_start_returned_bps,
        },
        sessionStarted: session !== null && session.starts_at.getTime() <= Date.now(),
      });
      await tx.layaway_instalment.updateMany({
        where: { purchase_id: purchase.id, status: 'due' },
        data: { status: 'cancelled' },
      });
      await release(tx, purchase);
      await movePurchase(tx, purchase, 'cancelled', 'user', actor.accountId);
      await tx.purchase.update({ where: { id: purchase.id }, data: { plan_status: 'cancelled' } });
      await purchaseEvent(
        tx,
        purchase,
        'plan_status',
        purchase.plan_status,
        'cancelled',
        'user',
        actor.accountId,
      );

      if (purchase.paid_minor > 0n) {
        const refund = await tx.layaway_refund.create({
          data: {
            tenant_id: purchase.tenant_id,
            consumer_account_id: purchase.consumer_account_id,
            purchase_id: purchase.id,
            paid_minor: purchase.paid_minor,
            fee_minor: split.feeMinor,
            refund_minor: split.refundMinor,
            currency: purchase.currency,
            status: split.refundMinor > 0n ? 'requested' : 'succeeded',
          },
        });
        // What was held for the buyer becomes what is owed back to them, less the fee.
        await this.ledger.post(tx, {
          idempotencyKey: `kelo.layaway.cancel:${purchase.id}`,
          tenantId: null,
          entryType: 'kelo_layaway_cancellation',
          operationType: 'kelo_purchase',
          operationId: purchase.id,
          postings: [
            {
              accountId: await this.account(tx, 'kelo_layaway_funds_held', purchase.currency),
              direction: 'debit',
              amount: purchase.paid_minor,
            },
            ...(split.refundMinor > 0n
              ? [
                  {
                    accountId: await this.account(tx, 'kelo_refunds_payable', purchase.currency),
                    direction: 'credit' as const,
                    amount: split.refundMinor,
                  },
                ]
              : []),
            ...(split.feeMinor > 0n
              ? [
                  {
                    accountId: await this.account(tx, 'kelo_fee_revenue', purchase.currency),
                    direction: 'credit' as const,
                    amount: split.feeMinor,
                  },
                ]
              : []),
          ],
        });
        if (split.refundMinor > 0n) {
          await this.outbox.enqueue(tx, {
            tenantId: purchase.tenant_id,
            type: EVENT_REFUND_SUBMIT,
            payload: { refund_id: refund.id },
          });
        } else {
          await tx.purchase.update({
            where: { id: purchase.id },
            data: { plan_status: 'refunded' },
          });
        }
      }
      await this.audit.record(tx, {
        tenantId: purchase.tenant_id,
        actorKind: 'user',
        actorAccountId: actor.accountId,
        action: 'kelo.purchase.cancelled',
        subjectType: 'kelo_purchase',
        subjectId: purchase.id,
        outcome: 'success',
        requestId: actor.requestId,
        detail: {
          paid_minor: purchase.paid_minor.toString(),
          fee_minor: split.feeMinor.toString(),
          refund_minor: split.refundMinor.toString(),
        },
      });
    });
    return this.one(actor.accountId, purchaseId);
  }

  /** For categories fulfilled by the buyer's word: confirming delivery settles the merchant. */
  async confirmDelivery(
    actor: { accountId: string; requestId: string },
    purchaseId: string,
  ): Promise<BuyerPurchaseView> {
    await this.db.asPlatform(async (tx) => {
      const purchase = await lockPurchaseForBuyer(tx, actor.accountId, purchaseId);
      const evidence = await this.evidenceRule(tx, purchase);
      if (evidence !== 'consumer_confirmation') {
        throw new AppError(
          'invalid_state_transition',
          'The merchant confirms delivery of this purchase.',
        );
      }
      await this.fulfil(
        tx,
        purchase,
        'consumer_confirmation',
        'user',
        actor.accountId,
        actor.requestId,
      );
    });
    return this.one(actor.accountId, purchaseId);
  }

  // --- The merchant ---

  async merchantList(tenantId: string): Promise<MerchantPurchaseView[]> {
    const rows = await this.db.withTenant(tenantId, (tx) =>
      tx.purchase.findMany({
        where: { tenant_id: tenantId },
        include: { listing: { select: { title: true } } },
        orderBy: { created_at: 'desc' },
        take: 200,
      }),
    );
    return rows.map(merchantView);
  }

  async merchantConfirm(
    actor: { tenantId: string; accountId: string; requestId: string },
    purchaseId: string,
  ): Promise<MerchantPurchaseView> {
    return this.db.asPlatform(async (tx) => {
      const purchase = await this.lockForMerchant(tx, actor.tenantId, purchaseId);
      await movePurchase(tx, purchase, 'merchant_confirmed', 'user', actor.accountId);
      await this.merchantAudit(tx, actor, 'kelo.purchase.merchant_confirmed', purchase.id);
      return this.merchantReload(tx, purchase.id);
    });
  }

  async merchantFulfil(
    actor: { tenantId: string; accountId: string; requestId: string },
    purchaseId: string,
    proofReference: string | null,
  ): Promise<MerchantPurchaseView> {
    return this.db.asPlatform(async (tx) => {
      const purchase = await this.lockForMerchant(tx, actor.tenantId, purchaseId);
      const evidence = await this.evidenceRule(tx, purchase);
      if (evidence === 'consumer_confirmation') {
        throw new AppError(
          'invalid_state_transition',
          'The buyer confirms delivery of this purchase.',
        );
      }
      if (evidence === 'merchant_proof' && !proofReference) {
        throw new AppError(
          'invalid_request',
          'Invalid request: proof_reference is required for this category.',
        );
      }
      if (evidence === 'session_start') {
        const session = purchase.session_id
          ? await tx.listing_session.findUniqueOrThrow({ where: { id: purchase.session_id } })
          : null;
        if (!session || session.starts_at.getTime() > Date.now()) {
          throw new AppError(
            'invalid_state_transition',
            'A dated service is fulfilled when it starts.',
          );
        }
      }
      await this.fulfil(
        tx,
        purchase,
        proofReference ? `merchant_proof:${proofReference}` : evidence,
        'user',
        actor.accountId,
        actor.requestId,
      );
      return this.merchantReload(tx, purchase.id);
    });
  }

  // --- Internals ---

  /**
   * Fulfilment, and in the same transaction the settlement it unlocks: the held
   * funds move to the merchant net of the discount fee, exactly (P4-9).
   */
  private async fulfil(
    tx: Tx,
    purchase: PurchaseRow,
    evidence: string,
    actorKind: 'user' | 'system',
    actorAccountId: string | null,
    requestId: string,
  ): Promise<void> {
    if (purchase.status !== 'merchant_confirmed') {
      throw new AppError(
        'invalid_state_transition',
        'The merchant has not confirmed this purchase yet.',
      );
    }
    const credit = purchase.plan_type !== 'layaway';
    if (credit) {
      // KELO pays the merchant once the agreement is in force (P8-8).
      const agreement = await tx.credit_agreement.findFirst({
        where: { purchase_id: purchase.id },
      });
      if (!agreement || !['active', 'paid_off'].includes(agreement.status)) {
        throw new AppError('invalid_state_transition', 'The credit agreement is not in force.');
      }
    } else if (purchase.plan_status !== 'paid_in_full') {
      throw new AppError(
        'invalid_state_transition',
        'Layaway items are fulfilled after the last payment.',
      );
    }
    await movePurchase(tx, purchase, 'fulfilled', actorKind, actorAccountId);
    await tx.purchase.update({
      where: { id: purchase.id },
      data: { fulfilment_evidence: evidence.slice(0, 120) },
    });
    const net = purchase.total_minor - purchase.merchant_fee_minor;
    const clawbackAccount = await this.ledger.tenantAccount(tx, {
      tenantId: purchase.tenant_id,
      type: 'merchant_kelo_clawback_receivable',
      assetCode: purchase.currency,
    });
    // One settlement at a time per workspace nets its clawback, so it is never netted twice.
    await tx.$executeRaw`select pg_advisory_xact_lock(hashtextextended(${`kelo.clawback:${purchase.tenant_id}`}, 0))`;
    const owedBack = await this.ledger.balanceOf(tx, clawbackAccount);
    const offset = owedBack < net ? owedBack : net;
    await this.ledger.post(tx, {
      idempotencyKey: `kelo.${credit ? 'credit' : 'layaway'}.settle:${purchase.id}`,
      tenantId: purchase.tenant_id,
      entryType: credit ? 'kelo_credit_settlement' : 'kelo_layaway_settlement',
      operationType: 'kelo_purchase',
      operationId: purchase.id,
      postings: [
        {
          accountId: await this.account(
            tx,
            credit ? 'kelo_merchant_payable_pending' : 'kelo_layaway_funds_held',
            purchase.currency,
          ),
          direction: 'debit',
          amount: purchase.total_minor,
        },
        // A clawback the merchant owes for an accepted return is netted first (ADR 0017).
        ...(offset > 0n
          ? [{ accountId: clawbackAccount, direction: 'credit' as const, amount: offset }]
          : []),
        ...(net - offset > 0n
          ? [
              {
                accountId: await this.ledger.findAccount(tx, {
                  tenantId: purchase.tenant_id,
                  type: 'merchant_available',
                  assetCode: purchase.currency,
                }),
                direction: 'credit' as const,
                amount: net - offset,
              },
            ]
          : []),
        ...(purchase.merchant_fee_minor > 0n
          ? [
              {
                accountId: await this.account(tx, 'kelo_fee_revenue', purchase.currency),
                direction: 'credit' as const,
                amount: purchase.merchant_fee_minor,
              },
            ]
          : []),
      ],
    });
    if (purchase.variant_id) {
      // Sold: out of stock on hand and out of the reservation together.
      await tx.$executeRaw`
        update kelo.listing_variant
           set stock_on_hand = stock_on_hand - 1, stock_reserved = stock_reserved - 1
         where id = ${purchase.variant_id}::uuid`;
    }
    const fulfilled = await tx.purchase.findUniqueOrThrow({ where: { id: purchase.id } });
    await movePurchase(tx, fulfilled, 'completed', 'system', null);
    await tx.purchase.update({ where: { id: purchase.id }, data: { plan_status: 'settled' } });
    await purchaseEvent(
      tx,
      purchase,
      'plan_status',
      purchase.plan_status,
      'settled',
      'system',
      null,
    );
    await this.audit.record(tx, {
      tenantId: purchase.tenant_id,
      actorKind,
      actorAccountId,
      action: 'kelo.purchase.settled',
      subjectType: 'kelo_purchase',
      subjectId: purchase.id,
      outcome: 'success',
      requestId,
      detail: {
        total_minor: purchase.total_minor.toString(),
        merchant_fee_minor: purchase.merchant_fee_minor.toString(),
        net_minor: net.toString(),
        clawback_netted_minor: offset.toString(),
      },
    });
  }

  private async submitRefund(refundId: string): Promise<void> {
    const refund = await this.db.asPlatform(async (tx) => {
      await tx.$queryRaw`select id from kelo.layaway_refund where id = ${refundId}::uuid for update`;
      const row = await tx.layaway_refund.findUnique({ where: { id: refundId } });
      if (!row || row.status !== 'requested') return null;
      await tx.layaway_refund.update({
        where: { id: row.id },
        data: { status: 'pending_provider' },
      });
      return row;
    });
    if (!refund) return;
    // SANDBOX: refunds to buyers go through the simulator only (X-14 for Daraja).
    const outcome = await this.simulator.moveMoney({
      kind: 'refund',
      operationRef: refund.id,
      amount: refund.refund_minor,
      assetCode: refund.currency,
      scenario: null,
    });
    await this.db.asPlatform(async (tx) => {
      if (outcome.kind === 'accepted')
        return this.refundSucceeded(tx, refund.id, outcome.providerReference);
      if (outcome.kind === 'rejected') return this.refundFailed(tx, refund.id);
      await tx.layaway_refund.update({
        where: { id: refund.id },
        data: { status: 'status_unknown' },
      });
      await this.scheduleRefundInquiry(tx, refund.id, refund.tenant_id);
    });
  }

  private async inquireRefund(refundId: string): Promise<void> {
    const current = await this.db.asPlatform((tx) =>
      tx.layaway_refund.findUnique({ where: { id: refundId } }),
    );
    if (!current || !['pending_provider', 'status_unknown'].includes(current.status)) return;
    const status = await this.simulator.queryStatus(refundId);
    await this.db.asPlatform(async (tx) => {
      await tx.$queryRaw`select id from kelo.layaway_refund where id = ${refundId}::uuid for update`;
      const row = await tx.layaway_refund.findUniqueOrThrow({ where: { id: refundId } });
      if (!['pending_provider', 'status_unknown'].includes(row.status)) return;
      if (status.kind === 'succeeded')
        return this.refundSucceeded(tx, row.id, status.providerReference);
      if (status.kind === 'failed') return this.refundFailed(tx, row.id);
      if (row.inquiries + 1 >= this.config.payments.maxStatusInquiries) {
        await tx.layaway_refund.update({
          where: { id: row.id },
          data: { status: 'reconciliation_required', inquiries: { increment: 1 } },
        });
        await this.reconciliation.openException(tx, {
          runId: null,
          tenantId: row.tenant_id,
          type: 'stuck_status_unknown',
          subjectType: 'kelo_layaway_refund',
          subjectRef: row.id,
          detail: { refund_minor: row.refund_minor.toString() },
        });
        return;
      }
      await tx.layaway_refund.update({
        where: { id: row.id },
        data: { inquiries: { increment: 1 } },
      });
      await this.scheduleRefundInquiry(tx, row.id, row.tenant_id);
    });
  }

  private async refundSucceeded(tx: Tx, refundId: string, reference: string): Promise<void> {
    const refund = await tx.layaway_refund.findUniqueOrThrow({ where: { id: refundId } });
    await tx.layaway_refund.update({
      where: { id: refund.id },
      data: { status: 'succeeded', provider_reference: reference },
    });
    await this.ledger.post(tx, {
      idempotencyKey: `kelo.layaway.refund:${refund.id}`,
      tenantId: null,
      entryType: 'kelo_layaway_refund',
      operationType: 'kelo_layaway_refund',
      operationId: refund.id,
      postings: [
        {
          accountId: await this.account(tx, 'kelo_refunds_payable', refund.currency),
          direction: 'debit',
          amount: refund.refund_minor,
        },
        {
          accountId: await this.ledger.findAccount(tx, {
            tenantId: null,
            type: 'provider_payout_float',
            assetCode: refund.currency,
            qualifier: SANDBOX_PROVIDER,
          }),
          direction: 'credit',
          amount: refund.refund_minor,
        },
      ],
    });
    await tx.purchase.update({
      where: { id: refund.purchase_id },
      data: { plan_status: 'refunded' },
    });
    const purchase = await tx.purchase.findUniqueOrThrow({ where: { id: refund.purchase_id } });
    await purchaseEvent(tx, purchase, 'plan_status', 'cancelled', 'refunded', 'provider', null);
  }

  /** The money stays owed in "refunds payable"; an operator follows it up. */
  private async refundFailed(tx: Tx, refundId: string): Promise<void> {
    const refund = await tx.layaway_refund.update({
      where: { id: refundId },
      data: { status: 'failed' },
    });
    await this.audit.record(tx, {
      tenantId: refund.tenant_id,
      actorKind: 'provider',
      action: 'kelo.layaway.refund_failed',
      subjectType: 'kelo_layaway_refund',
      subjectId: refund.id,
      outcome: 'failure',
      detail: { refund_minor: refund.refund_minor.toString() },
    });
  }

  private scheduleRefundInquiry(tx: Tx, refundId: string, tenantId: string): Promise<string> {
    return this.outbox.enqueue(tx, {
      tenantId,
      type: EVENT_REFUND_INQUIRY,
      payload: { refund_id: refundId },
      availableAt: new Date(Date.now() + this.config.payments.statusInquiryDelaySeconds * 1000),
    });
  }

  /** Layaway always; credit templates only while the `kelo_credit` flag is on (P8-1). */
  private async allowedTemplates(tx: Tx, categorySlug: string): Promise<PlanTemplate[]> {
    const credit = await this.flags.isEnabled('kelo_credit', tx);
    return allowedTemplates(
      tx,
      categorySlug,
      credit ? ['layaway', 'pay_in_n', 'monthly_financing'] : ['layaway'],
    );
  }

  private async refundRule(
    tx: Tx,
    categorySlug: string,
  ): Promise<Prisma.refund_ruleGetPayload<object>> {
    const now = new Date();
    const rule = await tx.refund_rule.findFirst({
      where: { category_slug: categorySlug, ...effective(now) },
      orderBy: { version: 'desc' },
    });
    if (!rule) throw new AppError('invalid_request', 'Layaway is not available in this category.');
    return rule;
  }

  /** The current key information document and agreement versions for a credit template. */
  private async creditDocuments(
    tx: Tx,
    templateKey: string,
  ): Promise<{ kidVersion: string; termsVersion: string }> {
    const now = new Date();
    const [kid, terms] = await Promise.all(
      [kidKey(templateKey), AGREEMENT_TERMS_KEY].map((key) =>
        tx.terms_document.findFirst({
          where: { key, language: 'en', ...effective(now) },
          orderBy: { effective_from: 'desc' },
        }),
      ),
    );
    if (!kid || !terms) throw new AppError('internal_error', 'Credit documents are not published.');
    return { kidVersion: kid.version, termsVersion: terms.version };
  }

  private async currentTerms(tx: Tx): Promise<{ key: string; version: string }> {
    const now = new Date();
    const terms = await tx.terms_document.findFirst({
      where: { key: TERMS_KEY, language: 'en', ...effective(now) },
      orderBy: { effective_from: 'desc' },
    });
    if (!terms) throw new AppError('internal_error', 'Layaway terms are not published.');
    return { key: terms.key, version: terms.version };
  }

  private async evidenceRule(tx: Tx, purchase: PurchaseRow): Promise<string> {
    const listing = await tx.listing.findUniqueOrThrow({ where: { id: purchase.listing_id } });
    const category = await tx.category.findUniqueOrThrow({
      where: { slug_version: { slug: listing.category_slug, version: listing.category_version } },
    });
    return category.fulfilment_evidence;
  }

  private async lockPurchase(tx: Tx, purchaseId: string): Promise<PurchaseRow> {
    await tx.$queryRaw`select id from kelo.purchase where id = ${purchaseId}::uuid for update`;
    return tx.purchase.findUniqueOrThrow({ where: { id: purchaseId } });
  }

  private async lockForMerchant(
    tx: Tx,
    tenantId: string,
    purchaseId: string,
  ): Promise<PurchaseRow> {
    await tx.$queryRaw`
      select id from kelo.purchase where id = ${purchaseId}::uuid and tenant_id = ${tenantId}::uuid for update`;
    const row = await tx.purchase.findFirst({ where: { id: purchaseId, tenant_id: tenantId } });
    if (!row) throw new AppError('not_found', 'Purchase not found.');
    return row;
  }

  private account(
    tx: Tx,
    type:
      | 'kelo_layaway_funds_held'
      | 'kelo_fee_revenue'
      | 'kelo_refunds_payable'
      | 'kelo_merchant_payable_pending',
    assetCode: string,
  ): Promise<string> {
    return this.ledger.findAccount(tx, { tenantId: null, type, assetCode });
  }

  private async merchantReload(tx: Tx, purchaseId: string): Promise<MerchantPurchaseView> {
    return merchantView(
      await tx.purchase.findUniqueOrThrow({
        where: { id: purchaseId },
        include: { listing: { select: { title: true } } },
      }),
    );
  }

  private merchantAudit(
    tx: Tx,
    actor: { tenantId: string; accountId: string; requestId: string },
    action: string,
    purchaseId: string,
  ): Promise<void> {
    return this.audit.record(tx, {
      tenantId: actor.tenantId,
      actorKind: 'user',
      actorAccountId: actor.accountId,
      action,
      subjectType: 'kelo_purchase',
      subjectId: purchaseId,
      outcome: 'success',
      requestId: actor.requestId,
    });
  }

  /** Listing titles are public facts of published listings; read them past the buyer barrier. */
  private async withTitles(
    rows: Prisma.purchaseGetPayload<{
      include: { layaway_instalment: true; layaway_refund: true };
    }>[],
  ): Promise<BuyerPurchaseView[]> {
    const titles = await this.db.asPlatform((tx) =>
      tx.listing.findMany({
        where: { id: { in: rows.map((row) => row.listing_id) } },
        select: { id: true, title: true },
      }),
    );
    const titleOf = new Map(titles.map((row) => [row.id, row.title]));
    return rows.map((row) => buyerView(row, titleOf.get(row.listing_id) ?? ''));
  }
}

function intentKey(instalmentId: string, claimKey: string): string {
  return `kelo:${instalmentId}:${claimKey}`;
}
