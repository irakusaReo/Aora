import { createHash } from 'node:crypto';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client.js';
import { Database, type Tx } from '../../../platform/database.js';
import { AppError } from '../../../platform/errors.js';
import { AuditService } from '../../audit/audit.service.js';
import { LedgerService } from '../../ledger/ledger.service.js';
import { OutboxService, type OutboxEvent } from '../../outbox/outbox.service.js';
import { FeatureFlagsService } from '../../ops/feature-flags.js';
import { EVENT_CREDIT_PAYMENT_RESULT, PaymentsService } from '../../payments/payments.service.js';
import type { Scenario } from '../../payments/simulator.js';
import {
  allowedTemplates,
  EVENT_REFUND_SUBMIT,
  effective,
  lockPurchaseForBuyer,
  movePurchase,
  payloadId,
  type PlanTemplate,
  priceOf,
  purchaseEvent,
  release,
  reserve,
} from '../purchase-common.js';
import { aprText, basisPoints, creditSchedule, dailyRateText, nairobiToday } from '../schedule.js';
import { type BureauResult, sandboxBureau } from './bureau.js';
import {
  evaluate,
  type Facts,
  limitFor,
  REASON_TEXT,
  type ReasonCode,
  ruleSetSchema,
} from './eligibility.js';
import {
  AGREEMENT_TERMS_KEY,
  type CreditLineView,
  type CreditOffer,
  creditOffer,
  creditTerms,
  kidKey,
} from './offer.js';

export type AgreementStatus =
  'pending_first_payment' | 'active' | 'paid_off' | 'cancelled' | 'defaulted' | 'paused';

/** The agreement machine (phase-8 plan §3). The order machine of ADR 0017 is unchanged. */
export const AGREEMENT_TRANSITIONS: Readonly<Record<AgreementStatus, readonly AgreementStatus[]>> =
  {
    pending_first_payment: ['active', 'cancelled'],
    active: ['paid_off', 'cancelled', 'defaulted', 'paused'],
    defaulted: ['paused', 'active', 'paid_off'],
    paused: ['active', 'defaulted'],
    paid_off: [],
    cancelled: [],
  };

const BUREAU_CONSENT_KEY = 'kelo_bureau_check_consent';
const CREDIT_PLAN_TYPES = ['pay_in_n', 'monthly_financing'] as const;
/** Agreements that still use the limit. */
const OPEN: AgreementStatus[] = ['pending_first_payment', 'active', 'defaulted', 'paused'];
/** A claim older than this with no payment behind it is taken to have been abandoned. */
const STALE_CLAIM_SECONDS = 120;

type Agreement = Prisma.credit_agreementGetPayload<object>;
type Decision = Prisma.credit_decisionGetPayload<object>;
type Instalment = Prisma.credit_instalmentGetPayload<object>;

export interface LimitView {
  readonly limit_minor: string;
  readonly limit_used_minor: string;
  readonly limit_unused_minor: string;
  readonly currency: string;
  readonly policy_version: number;
}

export interface DecisionView {
  readonly id: string;
  readonly outcome: 'approved' | 'declined';
  readonly reason_codes: ReasonCode[];
  readonly reasons: string[];
  readonly listing_id: string;
  readonly variant_id: string | null;
  readonly session_id: string | null;
  readonly plan: CreditOffer;
  readonly limit: { limit_minor: string; limit_used_minor: string; currency: string };
  readonly lender_of_record: string;
  readonly expires_at: string;
  readonly created_at: string;
  readonly mode: string;
}

export interface CreditView {
  readonly agreement_id: string;
  readonly status: AgreementStatus;
  readonly plan_type: string;
  readonly lender_of_record: string;
  readonly price_minor: string;
  readonly deposit_minor: string;
  /** What is lent: the price less the deposit. */
  readonly principal_minor: string;
  readonly interest_total_minor: string;
  readonly total_payable_minor: string;
  readonly daily_rate_text: string;
  readonly apr_text: string;
  readonly checkout_seq: number;
  readonly late_charges: { fee_minor: string; total_cap_minor: string; grace_days: number };
  readonly instalments: (CreditLineView & { paid_minor: string; status: string })[];
  readonly documents: {
    agreement: { key: string; version: string };
    kid: { key: string; version: string };
  };
  readonly created_at: string;
}

interface Policy {
  version: number;
  currency: string;
  start_minor: bigint;
  step_minor: bigint;
  max_minor: bigint;
}

const lineDue = (line: Instalment): bigint =>
  line.principal_minor - line.paid_principal_minor + line.interest_minor - line.paid_interest_minor;

/**
 * KELO credit (phase 8A; ADRs 0017, 0018). SANDBOX: the lender of record is
 * the simulated KELO book, not licensed (O-16). Every route is `not_found`
 * while the `kelo_credit` flag is off (P8-1). Consumer-isolated throughout:
 * no merchant ever reads a limit, decision, agreement or instalment (P8-9).
 */
@Injectable()
export class CreditService implements OnModuleInit {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(FeatureFlagsService) private readonly flags: FeatureFlagsService,
  ) {}

  onModuleInit(): void {
    this.outbox.register(EVENT_CREDIT_PAYMENT_RESULT, (event) => this.handlePaymentResult(event));
  }

  // --- Limit (P8-6) ---

  async limit(accountId: string): Promise<LimitView> {
    await this.flags.require('kelo_credit');
    return this.db.asPlatform(async (tx) => {
      const policy = await this.policy(tx);
      const { limit, used } = await this.limitState(tx, accountId, policy);
      return {
        limit_minor: limit.toString(),
        limit_used_minor: used.toString(),
        limit_unused_minor: (limit > used ? limit - used : 0n).toString(),
        currency: policy.currency,
        policy_version: policy.version,
      };
    });
  }

  // --- Decisions (P8-5, K6) ---

  async decide(
    actor: { accountId: string; requestId: string },
    idempotencyKey: string,
    input: {
      listingId: string;
      variantId: string | null;
      sessionId: string | null;
      templateKey: string;
      declaredMonthlyIncomeMinor: bigint;
      bureau: { consentVersion: string; scripted: BureauResult | null } | null;
    },
  ): Promise<{ decision: DecisionView; replayed: boolean }> {
    await this.flags.require('kelo_credit');
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          ...input,
          declaredMonthlyIncomeMinor: input.declaredMonthlyIncomeMinor.toString(),
        }),
      )
      .digest('hex');
    return this.db.asPlatform(async (tx) => {
      const earlier = await tx.credit_decision.findUnique({
        where: {
          consumer_account_id_idempotency_key: {
            consumer_account_id: actor.accountId,
            idempotency_key: idempotencyKey,
          },
        },
      });
      if (earlier) {
        if (earlier.request_hash !== requestHash) {
          throw new AppError(
            'idempotency_key_reused',
            'This Idempotency-Key was already used with a different request.',
          );
        }
        return { decision: await this.decisionView(tx, earlier), replayed: true };
      }
      // One decision at a time per person, so two cannot both fit under the limit.
      await tx.$executeRaw`select pg_advisory_xact_lock(hashtextextended(${`kelo.credit:${actor.accountId}`}, 0))`;

      const listing = await tx.listing.findFirst({
        where: { id: input.listingId, status: 'published' },
      });
      if (!listing) throw new AppError('not_found', 'Listing not found.');
      const template = await this.offeredTemplate(tx, listing, input.templateKey);
      const price = await priceOf(tx, listing.id, input);
      const now = new Date();
      const schedule = creditSchedule({
        priceMinor: price,
        terms: creditTerms(template),
        startDate: nairobiToday(now),
      });
      const rules = await this.ruleSet(tx);
      const policy = await this.policy(tx);
      const account = await tx.user_account.findUniqueOrThrow({ where: { id: actor.accountId } });

      let bureau: BureauResult | 'not_requested' = 'not_requested';
      let bureauConsentId: string | null = null;
      if (input.bureau) {
        // Its own consent, separate from the credit terms (r. 58, P8-7).
        const document = await tx.terms_document.findFirst({
          where: {
            key: BUREAU_CONSENT_KEY,
            version: input.bureau.consentVersion,
            ...effective(now),
          },
        });
        if (!document) {
          throw new AppError('invalid_request', 'That bureau consent version is not in effect.');
        }
        const consent = await tx.consent_record.create({
          data: {
            person_id: account.person_id,
            account_id: account.id,
            capacity: 'personal',
            action: 'kelo.credit.bureau_check',
            terms_document_id: document.id,
            request_id: actor.requestId,
          },
        });
        bureauConsentId = consent.id;
        bureau = sandboxBureau(input.bureau.scripted);
      }

      const { limit, used, open } = await this.limitState(tx, actor.accountId, policy);
      const overdue = await tx.credit_instalment.count({
        where: {
          consumer_account_id: actor.accountId,
          status: { in: ['due', 'late'] },
          due_on: { lt: new Date(`${nairobiToday(now)}T00:00:00Z`) },
          credit_agreement: { status: { in: ['active', 'defaulted'] } },
        },
      });
      const largest = schedule.lines.reduce(
        (max, line) => (line.amount_minor > max ? line.amount_minor : max),
        0n,
      );
      const facts: Facts = {
        hasPhone: account.phone_e164 !== null,
        overdueInstalments: overdue,
        openAgreements: open,
        orderInRange:
          listing.currency === template.currency &&
          price >= template.min_order_minor &&
          price <= template.max_order_minor,
        largestInstalmentMinor: largest,
        declaredMonthlyIncomeMinor: input.declaredMonthlyIncomeMinor,
        financedMinor: schedule.financed_minor,
        limitMinor: limit,
        limitUsedMinor: used,
        bureau,
      };
      const reasons = evaluate(rules.rules, facts);
      const created = await tx.credit_decision.create({
        data: {
          consumer_account_id: actor.accountId,
          idempotency_key: idempotencyKey,
          request_hash: requestHash,
          listing_id: listing.id,
          variant_id: input.variantId,
          session_id: input.sessionId,
          template_id: template.id,
          price_minor: price,
          financed_minor: schedule.financed_minor,
          currency: template.currency,
          outcome: reasons.length === 0 ? 'approved' : 'declined',
          reason_codes: reasons,
          inputs: {
            template: { key: template.key, version: template.version },
            price_minor: price.toString(),
            financed_minor: schedule.financed_minor.toString(),
            largest_instalment_minor: largest.toString(),
            declared_monthly_income_minor: input.declaredMonthlyIncomeMinor.toString(),
            has_phone: facts.hasPhone,
            overdue_instalments: overdue,
            open_agreements: open,
            order_in_range: facts.orderInRange,
            limit_minor: limit.toString(),
            limit_used_minor: used.toString(),
            bureau,
          },
          rule_set_version: rules.version,
          limit_policy_version: policy.version,
          bureau_consent_id: bureauConsentId,
          expires_at: new Date(now.getTime() + rules.rules.decision_ttl_minutes * 60_000),
        },
      });
      // No tenant: the decision is the buyer's alone, never in a merchant's trail.
      await this.audit.record(tx, {
        actorKind: 'user',
        actorAccountId: actor.accountId,
        action: 'kelo.credit.decided',
        subjectType: 'kelo_credit_decision',
        subjectId: created.id,
        outcome: 'success',
        requestId: actor.requestId,
        detail: {
          outcome: created.outcome,
          reason_codes: reasons,
          rule_set_version: rules.version,
        },
      });
      return { decision: await this.decisionView(tx, created), replayed: false };
    });
  }

  async decision(accountId: string, decisionId: string): Promise<DecisionView> {
    await this.flags.require('kelo_credit');
    const row = await this.db.withConsumer(accountId, (tx) =>
      tx.credit_decision.findFirst({ where: { id: decisionId, consumer_account_id: accountId } }),
    );
    if (!row) throw new AppError('not_found', 'Decision not found.');
    return this.db.asPlatform((tx) => this.decisionView(tx, row));
  }

  // --- Checkout and agreement (K2) ---

  /** Returns the purchase id; the controller answers with the buyer's view of it. */
  async purchase(
    actor: { accountId: string; requestId: string },
    idempotencyKey: string,
    input: {
      decisionId: string;
      expectedTotalPayableMinor: bigint;
      agreementVersion: string;
      kidVersion: string;
    },
  ): Promise<{ purchaseId: string; replayed: boolean }> {
    await this.flags.require('kelo_credit');
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          ...input,
          expectedTotalPayableMinor: input.expectedTotalPayableMinor.toString(),
        }),
      )
      .digest('hex');
    return this.db.asPlatform(async (tx) => {
      const earlier = await tx.purchase.findUnique({
        where: {
          consumer_account_id_idempotency_key: {
            consumer_account_id: actor.accountId,
            idempotency_key: idempotencyKey,
          },
        },
      });
      if (earlier) {
        if (earlier.request_hash !== requestHash) {
          throw new AppError(
            'idempotency_key_reused',
            'This Idempotency-Key was already used with a different request.',
          );
        }
        return { purchaseId: earlier.id, replayed: true };
      }
      const decision = await tx.credit_decision.findFirst({
        where: { id: input.decisionId, consumer_account_id: actor.accountId },
      });
      // Someone else's decision looks like one that does not exist.
      if (!decision) throw new AppError('not_found', 'Decision not found.');
      // A decision is used at most once, even by racing requests.
      await tx.$executeRaw`select pg_advisory_xact_lock(hashtextextended(${`kelo.decision:${decision.id}`}, 0))`;
      if (decision.outcome !== 'approved') {
        throw new AppError('invalid_state_transition', 'This decision was a decline.');
      }
      if (decision.expires_at.getTime() <= Date.now()) {
        throw new AppError('invalid_state_transition', 'This decision has expired. Ask again.');
      }
      if (await tx.credit_agreement.findUnique({ where: { decision_id: decision.id } })) {
        throw new AppError('invalid_state_transition', 'This decision has already been used.');
      }
      const listing = await tx.listing.findFirst({
        where: { id: decision.listing_id, status: 'published' },
      });
      if (!listing) throw new AppError('not_found', 'Listing not found.');
      const template = await tx.plan_template.findUniqueOrThrow({
        where: { id: decision.template_id },
      });
      await this.offeredTemplate(tx, listing, template.key);
      const choice = { variantId: decision.variant_id, sessionId: decision.session_id };
      const price = await priceOf(tx, listing.id, choice);
      const now = new Date();
      const schedule = creditSchedule({
        priceMinor: price,
        terms: creditTerms(template),
        startDate: nairobiToday(now),
      });
      // What the buyer was shown is what they agree to, to the minor unit (ADR 0018).
      if (
        price !== decision.price_minor ||
        schedule.total_payable_minor !== input.expectedTotalPayableMinor
      ) {
        throw new AppError(
          'fee_changed',
          'The total has changed. Review the new total before you agree.',
        );
      }
      const agreementDoc = await tx.terms_document.findFirst({
        where: { key: AGREEMENT_TERMS_KEY, version: input.agreementVersion, ...effective(now) },
      });
      const kidDoc = await tx.terms_document.findFirst({
        where: { key: kidKey(template.key), version: input.kidVersion, ...effective(now) },
      });
      if (!agreementDoc || !kidDoc) {
        throw new AppError(
          'invalid_request',
          'That agreement or key information version is not in effect.',
        );
      }
      if (schedule.checkout_seq === null) {
        throw new AppError('internal_error', 'A credit template must take a payment at checkout.');
      }
      await reserve(tx, listing.id, choice);

      const account = await tx.user_account.findUniqueOrThrow({ where: { id: actor.accountId } });
      const consent = await tx.consent_record.create({
        data: {
          person_id: account.person_id,
          account_id: account.id,
          capacity: 'personal',
          action: 'kelo.credit.accept',
          terms_document_id: agreementDoc.id,
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
          variant_id: decision.variant_id,
          session_id: decision.session_id,
          plan_type: template.plan_type,
          template_id: template.id,
          refund_rule_id: null,
          consent_id: consent.id,
          total_minor: price,
          merchant_fee_minor: basisPoints(price, template.merchant_fee_bps),
          currency: listing.currency,
        },
      });
      const agreement = await tx.credit_agreement.create({
        data: {
          tenant_id: listing.tenant_id,
          consumer_account_id: actor.accountId,
          purchase_id: created.id,
          decision_id: decision.id,
          template_id: template.id,
          agreement_terms_id: agreementDoc.id,
          kid_terms_id: kidDoc.id,
          consent_id: consent.id,
          lender_of_record: template.lender_of_record ?? '',
          plan_type: template.plan_type,
          price_minor: price,
          deposit_minor: schedule.deposit_minor,
          principal_minor: schedule.financed_minor,
          interest_total_minor: schedule.interest_total_minor,
          daily_rate_ppm: template.daily_rate_ppm,
          grace_days: template.grace_days,
          late_fee_minor: template.late_fee_minor,
          late_fee_total_cap_minor: template.late_fee_total_cap_minor,
          default_after_days: template.default_after_days ?? 0,
          currency: template.currency,
        },
      });
      await tx.credit_instalment.createMany({
        data: schedule.lines.map((line) => ({
          agreement_id: agreement.id,
          consumer_account_id: actor.accountId,
          seq: line.seq,
          due_on: new Date(`${line.due_on}T00:00:00Z`),
          principal_minor: line.principal_minor,
          interest_minor: line.interest_minor,
        })),
      });
      await this.agreementEvent(
        tx,
        agreement,
        null,
        'pending_first_payment',
        'user',
        actor.accountId,
      );
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
        // The merchant's trail names the plan, never the buyer's credit.
        detail: {
          plan_type: template.plan_type,
          template: template.key,
          version: template.version,
        },
      });
      return { purchaseId: created.id, replayed: false };
    });
  }

  // --- Payments ---

  /**
   * Starts the payment of the next line: at checkout the deposit or first part,
   * then each part once it is due. Paying ahead is 8B's early repayment. The
   * line is claimed for this request first, so a second request can never push
   * a second payment.
   */
  async pay(
    actor: { accountId: string; requestId: string },
    idempotencyKey: string,
    input: {
      purchaseId: string;
      seq: number;
      scenario: Scenario | null;
      payerPhone: string | null;
    },
  ): Promise<{ seq: number; status: string; payment_intent_id: string }> {
    await this.flags.require('kelo_credit');
    const claimKey = createHash('sha256').update(idempotencyKey).digest('hex');
    const claimed = await this.db.asPlatform(async (tx) => {
      const purchase = await lockPurchaseForBuyer(tx, actor.accountId, input.purchaseId);
      const agreement = await this.lockAgreement(tx, purchase.id);
      if (!['pending_first_payment', 'active'].includes(agreement.status)) {
        throw new AppError('invalid_state_transition', 'This agreement takes no payments now.');
      }
      const lines = await tx.$queryRaw<Instalment[]>`
        select * from kelo.credit_instalment where agreement_id = ${agreement.id}::uuid
         order by seq for update`;
      const next = lines.find((line) => line.status !== 'paid' && line.status !== 'cancelled');
      if (!next || next.seq !== input.seq) {
        throw new AppError('invalid_state_transition', 'Instalments are paid in order.');
      }
      const checkout = agreement.status === 'pending_first_payment';
      const due = next.due_on.toISOString().slice(0, 10) <= nairobiToday();
      if (!checkout && !due) {
        throw new AppError('invalid_state_transition', 'This part is not due yet.');
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
      await tx.credit_instalment.update({
        where: { id: next.id },
        data: { status: 'submitting', claim_key: claimKey, claimed_at: new Date() },
      });
      return {
        instalmentId: next.id,
        amount: lineDue(next),
        tenantId: purchase.tenant_id,
        currency: agreement.currency,
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
      purpose: 'kelo_credit',
    });
    return this.db.asPlatform(async (tx) => {
      const updated = await tx.credit_instalment.updateMany({
        where: { id: claimed.instalmentId, status: 'submitting', claim_key: claimKey },
        data: { status: 'pending', payment_intent_id: intent.id },
      });
      const line = await tx.credit_instalment.findUniqueOrThrow({
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

  /**
   * A repayment reached a final state (from payments, through the outbox; at
   * least once). The first one puts the agreement in force; each is allocated
   * to principal, then charges, then interest (r. 56(2)).
   */
  private async handlePaymentResult(event: OutboxEvent): Promise<void> {
    const intentId = payloadId(event, 'intent_id');
    const outcome = (event.payload as { outcome?: unknown }).outcome;
    await this.db.asPlatform(async (tx) => {
      const found = await tx.credit_instalment.findFirst({
        where: { payment_intent_id: intentId },
      });
      if (!found) return;
      const agreement = await this.lockAgreement(tx, null, found.agreement_id);
      await tx.$queryRaw`select id from kelo.credit_instalment where id = ${found.id}::uuid for update`;
      const line = await tx.credit_instalment.findUniqueOrThrow({ where: { id: found.id } });
      // A result already applied changes nothing.
      if (line.status !== 'pending' || line.payment_intent_id !== intentId) return;
      if (outcome === 'failed') {
        await tx.credit_instalment.update({
          where: { id: line.id },
          data: { status: 'due', payment_intent_id: null, claim_key: null, claimed_at: null },
        });
        return;
      }
      const intent = await tx.payment_intent.findUniqueOrThrow({ where: { id: intentId } });
      const purchase = await tx.purchase.findUniqueOrThrow({
        where: { id: agreement.purchase_id },
      });
      const receivable = await this.ledger.consumerAccount(tx, {
        accountId: agreement.consumer_account_id,
        type: 'consumer_kelo_credit_receivable',
        assetCode: agreement.currency,
      });
      if (agreement.status === 'pending_first_payment') {
        // In force: the buyer owes KELO the price; KELO owes the merchant on fulfilment.
        await this.ledger.post(tx, {
          idempotencyKey: `kelo.credit.activate:${agreement.id}`,
          tenantId: null,
          entryType: 'kelo_credit_agreement',
          operationType: 'kelo_credit_agreement',
          operationId: agreement.id,
          postings: [
            { accountId: receivable, direction: 'debit', amount: agreement.price_minor },
            {
              accountId: await this.platformAccount(
                tx,
                'kelo_merchant_payable_pending',
                agreement.currency,
              ),
              direction: 'credit',
              amount: agreement.price_minor,
            },
          ],
        });
        await this.moveAgreement(tx, agreement, 'active', 'provider', null);
        await movePurchase(tx, purchase, 'payment_ready', 'system', null);
      }
      // Principal first, then charges (8B), then interest (r. 56(2)).
      const principal = line.principal_minor - line.paid_principal_minor;
      const interest = intent.amount - principal;
      if (interest < 0n || interest > line.interest_minor - line.paid_interest_minor) {
        throw new Error(`Repayment ${intentId} does not match instalment ${line.id}.`);
      }
      await this.ledger.post(tx, {
        idempotencyKey: `kelo.credit.allocate:${intentId}`,
        tenantId: null,
        entryType: 'kelo_credit_allocation',
        operationType: 'kelo_credit_instalment',
        operationId: line.id,
        postings: [
          {
            accountId: await this.platformAccount(
              tx,
              'kelo_credit_repayments_unapplied',
              intent.asset_code,
            ),
            direction: 'debit',
            amount: intent.amount,
          },
          ...(principal > 0n
            ? [{ accountId: receivable, direction: 'credit' as const, amount: principal }]
            : []),
          ...(interest > 0n
            ? [
                {
                  accountId: await this.platformAccount(
                    tx,
                    'kelo_interest_income',
                    intent.asset_code,
                  ),
                  direction: 'credit' as const,
                  amount: interest,
                },
              ]
            : []),
        ],
      });
      await tx.credit_instalment.update({
        where: { id: line.id },
        data: {
          status: 'paid',
          paid_at: new Date(),
          paid_principal_minor: line.principal_minor,
          paid_interest_minor: line.paid_interest_minor + interest,
        },
      });
      const open = await tx.credit_instalment.count({
        where: { agreement_id: agreement.id, status: { notIn: ['paid', 'cancelled'] } },
      });
      if (open === 0) {
        const current = await tx.credit_agreement.findUniqueOrThrow({
          where: { id: agreement.id },
        });
        await this.moveAgreement(tx, current, 'paid_off', 'provider', null);
      }
    });
  }

  // --- Cancellation before fulfilment (P8-8) ---

  async cancel(actor: { accountId: string; requestId: string }, purchaseId: string): Promise<void> {
    await this.flags.require('kelo_credit');
    await this.db.asPlatform(async (tx) => {
      const purchase = await lockPurchaseForBuyer(tx, actor.accountId, purchaseId);
      if (!['placed', 'payment_ready', 'merchant_confirmed'].includes(purchase.status)) {
        throw new AppError('invalid_state_transition', 'This purchase can no longer be cancelled.');
      }
      const agreement = await this.lockAgreement(tx, purchase.id);
      const lines = await tx.credit_instalment.findMany({ where: { agreement_id: agreement.id } });
      if (lines.some((line) => line.status === 'pending' || line.status === 'submitting')) {
        throw new AppError(
          'invalid_state_transition',
          'A payment is being checked. Cancel once it has a result.',
        );
      }
      const paidPrincipal = lines.reduce((sum, line) => sum + line.paid_principal_minor, 0n);
      const paidInterest = lines.reduce((sum, line) => sum + line.paid_interest_minor, 0n);
      const paid = paidPrincipal + paidInterest;
      await tx.credit_instalment.updateMany({
        where: { agreement_id: agreement.id, status: { in: ['due', 'late'] } },
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
      const wasActive = agreement.status === 'active';
      await this.moveAgreement(tx, agreement, 'cancelled', 'user', actor.accountId);

      if (wasActive) {
        // The agreement entry is undone: the merchant is owed nothing, the buyer
        // owes nothing, and everything the buyer paid is owed back to them.
        const receivable = await this.ledger.consumerAccount(tx, {
          accountId: agreement.consumer_account_id,
          type: 'consumer_kelo_credit_receivable',
          assetCode: agreement.currency,
        });
        const owed = agreement.price_minor - paidPrincipal;
        await this.ledger.post(tx, {
          idempotencyKey: `kelo.credit.cancel:${agreement.id}`,
          tenantId: null,
          entryType: 'kelo_credit_cancellation',
          operationType: 'kelo_credit_agreement',
          operationId: agreement.id,
          postings: [
            {
              accountId: await this.platformAccount(
                tx,
                'kelo_merchant_payable_pending',
                agreement.currency,
              ),
              direction: 'debit',
              amount: agreement.price_minor,
            },
            ...(owed > 0n
              ? [{ accountId: receivable, direction: 'credit' as const, amount: owed }]
              : []),
            ...(paidInterest > 0n
              ? [
                  {
                    accountId: await this.platformAccount(
                      tx,
                      'kelo_interest_income',
                      agreement.currency,
                    ),
                    direction: 'debit' as const,
                    amount: paidInterest,
                  },
                ]
              : []),
            ...(paid > 0n
              ? [
                  {
                    accountId: await this.platformAccount(
                      tx,
                      'kelo_refunds_payable',
                      agreement.currency,
                    ),
                    direction: 'credit' as const,
                    amount: paid,
                  },
                ]
              : []),
          ],
        });
        if (paid > 0n) {
          // Paid back through the same refund path as layaway, with no fee.
          const refund = await tx.layaway_refund.create({
            data: {
              tenant_id: purchase.tenant_id,
              consumer_account_id: purchase.consumer_account_id,
              purchase_id: purchase.id,
              paid_minor: paid,
              fee_minor: 0n,
              refund_minor: paid,
              currency: agreement.currency,
            },
          });
          await this.outbox.enqueue(tx, {
            tenantId: purchase.tenant_id,
            type: EVENT_REFUND_SUBMIT,
            payload: { refund_id: refund.id },
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
        detail: { plan_type: purchase.plan_type },
      });
    });
  }

  /** Whether a purchase of this buyer is a credit purchase (for routing a cancellation). */
  async isCredit(accountId: string, purchaseId: string): Promise<boolean> {
    const row = await this.db.withConsumer(accountId, (tx) =>
      tx.purchase.findFirst({
        where: { id: purchaseId, consumer_account_id: accountId },
        select: { plan_type: true },
      }),
    );
    return row !== null && row.plan_type !== 'layaway';
  }

  // --- Views ---

  /** The buyer's agreements, keyed by purchase. Read through the buyer's own barrier. */
  async views(accountId: string, purchaseIds: string[]): Promise<Map<string, CreditView>> {
    if (purchaseIds.length === 0) return new Map();
    const agreements = await this.db.withConsumer(accountId, (tx) =>
      tx.credit_agreement.findMany({
        where: { consumer_account_id: accountId, purchase_id: { in: purchaseIds } },
        include: { credit_instalment: true },
      }),
    );
    if (agreements.length === 0) return new Map();
    const documents = await this.db.asPlatform((tx) =>
      tx.terms_document.findMany({
        where: {
          id: { in: agreements.flatMap((row) => [row.agreement_terms_id, row.kid_terms_id]) },
        },
        select: { id: true, key: true, version: true },
      }),
    );
    const document = new Map(
      documents.map((row) => [row.id, { key: row.key, version: row.version }]),
    );
    return new Map(
      agreements.map((row) => {
        const lines = [...row.credit_instalment].sort((a, b) => a.seq - b.seq);
        const view: CreditView = {
          agreement_id: row.id,
          status: row.status as AgreementStatus,
          plan_type: row.plan_type,
          lender_of_record: row.lender_of_record,
          price_minor: row.price_minor.toString(),
          deposit_minor: row.deposit_minor.toString(),
          principal_minor: row.principal_minor.toString(),
          interest_total_minor: row.interest_total_minor.toString(),
          total_payable_minor: (row.price_minor + row.interest_total_minor).toString(),
          daily_rate_text: dailyRateText(row.daily_rate_ppm),
          apr_text: aprText(row.daily_rate_ppm),
          checkout_seq: row.deposit_minor > 0n ? 0 : 1,
          late_charges: {
            fee_minor: row.late_fee_minor.toString(),
            total_cap_minor: row.late_fee_total_cap_minor.toString(),
            grace_days: row.grace_days,
          },
          instalments: lines.map((line) => ({
            seq: line.seq,
            due_on: line.due_on.toISOString().slice(0, 10),
            principal_minor: line.principal_minor.toString(),
            interest_minor: line.interest_minor.toString(),
            amount_minor: (line.principal_minor + line.interest_minor).toString(),
            paid_minor: (line.paid_principal_minor + line.paid_interest_minor).toString(),
            // A claim in progress is shown as what it is to the buyer: being checked.
            status: line.status === 'submitting' ? 'pending' : line.status,
          })),
          documents: {
            agreement: document.get(row.agreement_terms_id) ?? {
              key: AGREEMENT_TERMS_KEY,
              version: '',
            },
            kid: document.get(row.kid_terms_id) ?? { key: '', version: '' },
          },
          created_at: row.created_at.toISOString(),
        };
        return [row.purchase_id, view];
      }),
    );
  }

  // --- Internals ---

  private async decisionView(tx: Tx, row: Decision): Promise<DecisionView> {
    const template = await tx.plan_template.findUniqueOrThrow({ where: { id: row.template_id } });
    const now = new Date();
    const [kid, terms] = await Promise.all(
      [kidKey(template.key), AGREEMENT_TERMS_KEY].map((key) =>
        tx.terms_document.findFirst({
          where: { key, language: 'en', ...effective(now) },
          orderBy: { effective_from: 'desc' },
        }),
      ),
    );
    const inputs = row.inputs as { limit_minor?: string; limit_used_minor?: string };
    const reasons = row.reason_codes as ReasonCode[];
    return {
      id: row.id,
      outcome: row.outcome as DecisionView['outcome'],
      reason_codes: reasons,
      reasons: reasons.map((code) => REASON_TEXT[code]),
      listing_id: row.listing_id,
      variant_id: row.variant_id,
      session_id: row.session_id,
      plan: creditOffer(template, row.price_minor, nairobiToday(row.created_at), {
        kidVersion: kid?.version ?? '',
        termsVersion: terms?.version ?? '',
      }),
      limit: {
        limit_minor: inputs.limit_minor ?? '0',
        limit_used_minor: inputs.limit_used_minor ?? '0',
        currency: row.currency,
      },
      lender_of_record: template.lender_of_record ?? '',
      expires_at: row.expires_at.toISOString(),
      created_at: row.created_at.toISOString(),
      mode: row.mode,
    };
  }

  /** A credit template this listing's merchant offers and its category allows. */
  private async offeredTemplate(
    tx: Tx,
    listing: { id: string; category_slug: string },
    templateKey: string,
  ): Promise<PlanTemplate> {
    const template = (await allowedTemplates(tx, listing.category_slug, CREDIT_PLAN_TYPES)).find(
      (row) => row.key === templateKey,
    );
    const offer = await tx.listing_plan_offer.findFirst({
      where: { listing_id: listing.id, template_key: templateKey, withdrawn_at: null },
    });
    if (!template || !offer)
      throw new AppError('invalid_request', 'Invalid request: template_key.');
    return template;
  }

  private async ruleSet(
    tx: Tx,
  ): Promise<{ version: number; rules: ReturnType<typeof ruleSetSchema.parse> }> {
    const row = await tx.eligibility_rule_set.findFirst({
      where: effective(new Date()),
      orderBy: { version: 'desc' },
    });
    if (!row) throw new AppError('internal_error', 'No eligibility rule set is in effect.');
    return { version: row.version, rules: ruleSetSchema.parse(row.rules) };
  }

  private async policy(tx: Tx): Promise<Policy> {
    const row = await tx.limit_policy.findFirst({
      where: effective(new Date()),
      orderBy: { version: 'desc' },
    });
    if (!row) throw new AppError('internal_error', 'No limit policy is in effect.');
    return row;
  }

  /** The limit grows with each agreement repaid on time; "used" is principal still owed. */
  private async limitState(
    tx: Tx,
    accountId: string,
    policy: Policy,
  ): Promise<{ limit: bigint; used: bigint; open: number }> {
    const rows = await tx.$queryRaw<{ repaid: number; used: bigint; open: number }[]>`
      select
        (select count(*)::int from kelo.credit_agreement a
          where a.consumer_account_id = ${accountId}::uuid and a.status = 'paid_off'
            and not exists (select 1 from kelo.credit_instalment i
                             where i.agreement_id = a.id and i.paid_at::date > i.due_on)) as repaid,
        (select coalesce(sum(i.principal_minor - i.paid_principal_minor), 0)::bigint
           from kelo.credit_instalment i join kelo.credit_agreement a on a.id = i.agreement_id
          where a.consumer_account_id = ${accountId}::uuid and a.status = any(${OPEN}::text[])
            and i.status <> 'cancelled') as used,
        (select count(*)::int from kelo.credit_agreement a
          where a.consumer_account_id = ${accountId}::uuid and a.status = any(${OPEN}::text[])) as open`;
    const row = rows[0] ?? { repaid: 0, used: 0n, open: 0 };
    return { limit: limitFor(policy, row.repaid), used: row.used, open: row.open };
  }

  private async lockAgreement(
    tx: Tx,
    purchaseId: string | null,
    agreementId?: string,
  ): Promise<Agreement> {
    if (purchaseId) {
      await tx.$queryRaw`select id from kelo.credit_agreement where purchase_id = ${purchaseId}::uuid for update`;
      const row = await tx.credit_agreement.findFirst({ where: { purchase_id: purchaseId } });
      if (!row) throw new AppError('not_found', 'Agreement not found.');
      return row;
    }
    await tx.$queryRaw`select id from kelo.credit_agreement where id = ${agreementId ?? ''}::uuid for update`;
    return tx.credit_agreement.findUniqueOrThrow({ where: { id: agreementId ?? '' } });
  }

  private async moveAgreement(
    tx: Tx,
    agreement: Agreement,
    to: AgreementStatus,
    actorKind: 'user' | 'system' | 'provider',
    actorAccountId: string | null,
  ): Promise<void> {
    const from = agreement.status as AgreementStatus;
    if (!AGREEMENT_TRANSITIONS[from].includes(to)) {
      throw new AppError(
        'invalid_state_transition',
        `Cannot move an agreement from ${from} to ${to}.`,
      );
    }
    const updated = await tx.credit_agreement.updateMany({
      where: { id: agreement.id, status: from },
      data: { status: to },
    });
    if (updated.count !== 1) {
      throw new AppError('invalid_state_transition', 'Agreement status changed concurrently.');
    }
    await this.agreementEvent(tx, agreement, from, to, actorKind, actorAccountId);
  }

  private async agreementEvent(
    tx: Tx,
    agreement: Agreement,
    from: AgreementStatus | null,
    to: AgreementStatus,
    actorKind: 'user' | 'system' | 'provider',
    actorAccountId: string | null,
  ): Promise<void> {
    await tx.credit_agreement_event.create({
      data: {
        agreement_id: agreement.id,
        consumer_account_id: agreement.consumer_account_id,
        from_status: from,
        to_status: to,
        actor_kind: actorKind,
        actor_account_id: actorAccountId,
      },
    });
  }

  private platformAccount(
    tx: Tx,
    type:
      | 'kelo_merchant_payable_pending'
      | 'kelo_credit_repayments_unapplied'
      | 'kelo_interest_income'
      | 'kelo_refunds_payable',
    assetCode: string,
  ): Promise<string> {
    return this.ledger.findAccount(tx, { tenantId: null, type, assetCode });
  }
}

function intentKey(instalmentId: string, claimKey: string): string {
  return `kelo-credit:${instalmentId}:${claimKey}`;
}
