import type { KeloCreditPlan, KeloPlan } from '@aora/api-client';
import { Body, Muted } from '@aora/mobile';
import { formatMinor } from '@aora/api-client';
import { t } from './messages';

// The plan-at-a-glance card (kelo-experience.md §2), in its fixed order:
// price; deposit or first payment; every instalment; fees or interest; the
// total; what happens if a payment is late. Every figure is the API's.

export function LayawayPlanCard({
  plan,
  money,
  scheduled,
}: {
  plan: KeloPlan;
  money: (minor: string) => string;
  scheduled: boolean;
}): React.JSX.Element {
  const percent = (bps: number): string => formatMinor(String(bps), 2);
  return (
    <>
      <Body>{t('plan.price', { amount: money(plan.total_minor) })}</Body>
      <Body>
        {t('plan.first_payment', { amount: money(plan.instalments[0]?.amount_minor ?? '0') })}
      </Body>
      {plan.instalments.map((line) => (
        <Muted key={line.seq}>
          {t('plan.instalment', {
            seq: String(line.seq),
            date: line.due_on,
            amount: money(line.amount_minor),
          })}
        </Muted>
      ))}
      <Body>{t('plan.fees_none')}</Body>
      <Body strong>{t('plan.total', { amount: money(plan.total_minor) })}</Body>
      <Muted>{t('plan.late')}</Muted>
      <Muted>{t('plan.receive_after')}</Muted>
      <Muted>
        {t('plan.cancel_rule', {
          percent: percent(plan.cancellation.fee_bps),
          cap: money(plan.cancellation.fee_cap_minor),
        })}
      </Muted>
      {scheduled ? (
        <Muted>
          {t('plan.cancel_after_start', {
            percent: percent(plan.cancellation.after_start_returned_bps),
          })}
        </Muted>
      ) : null}
    </>
  );
}

export function CreditPlanCard({
  plan,
  money,
}: {
  plan: KeloCreditPlan;
  money: (minor: string) => string;
}): React.JSX.Element {
  const checkout = plan.instalments.find((line) => line.seq === plan.checkout_seq);
  const later = plan.instalments.filter((line) => line.seq !== plan.checkout_seq);
  return (
    <>
      <Body>{t('plan.price', { amount: money(plan.total_minor) })}</Body>
      {checkout ? (
        <Body>
          {t(plan.checkout_seq === 0 ? 'credit.deposit' : 'credit.first_payment', {
            amount: money(checkout.amount_minor),
          })}
        </Body>
      ) : null}
      {later.map((line) => (
        <Muted key={line.seq}>
          {line.interest_minor === '0'
            ? t('credit.part_no_interest', {
                seq: String(line.seq),
                date: line.due_on,
                amount: money(line.amount_minor),
              })
            : t('credit.part', {
                seq: String(line.seq),
                date: line.due_on,
                amount: money(line.amount_minor),
                principal: money(line.principal_minor),
                interest: money(line.interest_minor),
              })}
        </Muted>
      ))}
      <Body>
        {plan.interest_total_minor === '0'
          ? t('credit.cost_none')
          : t('credit.cost', {
              amount: money(plan.interest_total_minor),
              daily: plan.daily_rate_text,
            })}
      </Body>
      <Muted>{t('credit.apr', { apr: plan.apr_text })}</Muted>
      <Body strong>{t('credit.total', { amount: money(plan.total_payable_minor) })}</Body>
      <Muted>
        {t('credit.late', {
          days: String(plan.late_charges.grace_days),
          fee: money(plan.late_charges.fee_minor),
          cap: money(plan.late_charges.total_cap_minor),
        })}
      </Muted>
      <Muted>{t('credit.early')}</Muted>
      <Muted>{t('credit.receive_first')}</Muted>
      <Muted>{t('credit.sandbox_lender', { lender: plan.lender_of_record })}</Muted>
      <Muted>
        {t('credit.kid', { version: plan.kid.version })} ·{' '}
        {t('credit.agreement', { version: plan.terms.version })}
      </Muted>
    </>
  );
}
