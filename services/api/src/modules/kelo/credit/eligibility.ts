import { z } from 'zod';
import type { BureauResult } from './bureau.js';

/** An eligibility rule set as stored (`kelo.eligibility_rule_set.rules`, versioned data, P8-5). */
export const ruleSetSchema = z.object({
  require_phone: z.boolean(),
  max_open_agreements: z.number().int().min(0),
  /** The largest single payment may be at most this share of declared monthly income. */
  max_instalment_income_bps: z.number().int().min(1).max(10_000),
  decline_on_adverse_bureau: z.boolean(),
  decision_ttl_minutes: z.number().int().min(1).max(1_440),
});
export type RuleSet = z.infer<typeof ruleSetSchema>;

/** Every reason a decision can give, in the order they are checked and shown. */
export const REASON_CODES = [
  'phone_missing',
  'overdue_instalment',
  'too_many_open_agreements',
  'order_out_of_range',
  'unaffordable',
  'over_limit',
  'bureau_adverse',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/** Plain words for each reason, shown at once with a decline (r. 28). */
export const REASON_TEXT: Readonly<Record<ReasonCode, string>> = {
  phone_missing: 'Add your phone number to your profile first.',
  overdue_instalment: 'You have a KELO payment that is overdue. Pay it first.',
  too_many_open_agreements: 'You already have the most KELO plans that can be open at once.',
  order_out_of_range: 'This plan is not available for this price.',
  unaffordable: 'The largest payment would be more than the share of your monthly income we allow.',
  over_limit: 'This purchase would take you over your KELO spending limit.',
  bureau_adverse: 'The credit bureau check you allowed did not support this plan.',
};

export interface Facts {
  readonly hasPhone: boolean;
  readonly overdueInstalments: number;
  readonly openAgreements: number;
  readonly orderInRange: boolean;
  readonly largestInstalmentMinor: bigint;
  readonly declaredMonthlyIncomeMinor: bigint;
  readonly financedMinor: bigint;
  readonly limitMinor: bigint;
  readonly limitUsedMinor: bigint;
  readonly bureau: BureauResult | 'not_requested';
}

/** The rules, applied to the facts: no reason means approved. Pure and exact. */
export function evaluate(rules: RuleSet, facts: Facts): ReasonCode[] {
  const failed: Record<ReasonCode, boolean> = {
    phone_missing: rules.require_phone && !facts.hasPhone,
    overdue_instalment: facts.overdueInstalments > 0,
    too_many_open_agreements: facts.openAgreements >= rules.max_open_agreements,
    order_out_of_range: !facts.orderInRange,
    unaffordable:
      facts.largestInstalmentMinor * 10_000n >
      facts.declaredMonthlyIncomeMinor * BigInt(rules.max_instalment_income_bps),
    over_limit: facts.limitUsedMinor + facts.financedMinor > facts.limitMinor,
    bureau_adverse: rules.decline_on_adverse_bureau && facts.bureau === 'adverse',
  };
  return REASON_CODES.filter((code) => failed[code]);
}

/** The limit policy (P8-6): a starting limit, a step per agreement repaid on time, a maximum. */
export function limitFor(
  policy: { start_minor: bigint; step_minor: bigint; max_minor: bigint },
  repaidOnTime: number,
): bigint {
  const grown = policy.start_minor + policy.step_minor * BigInt(repaidOnTime);
  return grown > policy.max_minor ? policy.max_minor : grown;
}
