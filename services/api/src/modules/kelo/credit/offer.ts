import type { PlanTemplate } from '../purchase-common.js';
import { type CreditSchedule, type CreditTerms, creditSchedule } from '../schedule.js';

/** The credit agreement every credit plan is accepted under (P8-12). */
export const AGREEMENT_TERMS_KEY = 'kelo_credit_agreement';
/** The key information document of a template (r. 54). */
export const kidKey = (templateKey: string): string => `kelo_credit_kid_${templateKey}`;

export function creditTerms(template: PlanTemplate): CreditTerms {
  return {
    instalmentCount: template.instalment_count,
    intervalDays: template.interval_days,
    dailyRatePpm: template.daily_rate_ppm,
    depositBps: template.deposit_bps,
    firstPaymentAtCheckout: template.first_payment_at_checkout,
    lateFeeTotalCapMinor: template.late_fee_total_cap_minor,
  };
}

export interface CreditLineView {
  readonly seq: number;
  readonly due_on: string;
  readonly principal_minor: string;
  readonly interest_minor: string;
  readonly amount_minor: string;
}

/** A credit plan as the buyer sees it before any decision: the whole cost, nothing hidden. */
export interface CreditOffer {
  readonly template_key: string;
  readonly name: string;
  readonly plan_type: 'pay_in_n' | 'monthly_financing';
  readonly pricing_model: string;
  readonly instalments: CreditLineView[];
  /** The price of the item. */
  readonly total_minor: string;
  readonly deposit_minor: string;
  readonly financed_minor: string;
  readonly interest_total_minor: string;
  readonly total_payable_minor: string;
  /** What the buyer pays on top of the price: the total cost of credit. */
  readonly fees_minor: string;
  readonly currency: string;
  readonly daily_rate_text: string;
  readonly apr_text: string;
  readonly checkout_seq: number | null;
  readonly receive_after_last_payment: false;
  readonly needs_decision: true;
  readonly lender_of_record: string;
  readonly late_charges: { fee_minor: string; total_cap_minor: string; grace_days: number };
  readonly kid: { key: string; version: string };
  readonly terms: { key: string; version: string };
}

export function serialiseLines(schedule: CreditSchedule): CreditLineView[] {
  return schedule.lines.map((line) => ({
    seq: line.seq,
    due_on: line.due_on,
    principal_minor: line.principal_minor.toString(),
    interest_minor: line.interest_minor.toString(),
    amount_minor: line.amount_minor.toString(),
  }));
}

/** Every figure from the one schedule engine; screens compute nothing (ADR 0018). */
export function creditOffer(
  template: PlanTemplate,
  priceMinor: bigint,
  startDate: string,
  documents: { kidVersion: string; termsVersion: string },
): CreditOffer {
  const schedule = creditSchedule({ priceMinor, terms: creditTerms(template), startDate });
  return {
    template_key: template.key,
    name: template.name,
    plan_type: template.plan_type as CreditOffer['plan_type'],
    pricing_model: template.pricing_model,
    instalments: serialiseLines(schedule),
    total_minor: priceMinor.toString(),
    deposit_minor: schedule.deposit_minor.toString(),
    financed_minor: schedule.financed_minor.toString(),
    interest_total_minor: schedule.interest_total_minor.toString(),
    total_payable_minor: schedule.total_payable_minor.toString(),
    fees_minor: schedule.interest_total_minor.toString(),
    currency: template.currency,
    daily_rate_text: schedule.daily_rate_text,
    apr_text: schedule.apr_text,
    checkout_seq: schedule.checkout_seq,
    receive_after_last_payment: false,
    needs_decision: true,
    lender_of_record: template.lender_of_record ?? '',
    late_charges: {
      fee_minor: template.late_fee_minor.toString(),
      total_cap_minor: template.late_fee_total_cap_minor.toString(),
      grace_days: template.grace_days,
    },
    kid: { key: kidKey(template.key), version: documents.kidVersion },
    terms: { key: AGREEMENT_TERMS_KEY, version: documents.termsVersion },
  };
}
