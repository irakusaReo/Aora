import type { KeloCreditPlan } from '@aora/api-client';
import { t } from '../../lib/messages';

/**
 * The plan-at-a-glance card for a credit plan (kelo-experience.md §2), in its
 * fixed order: price; deposit or first payment; every part; interest or fees;
 * the total; what happens if a payment is late. Every figure is the API's.
 */
export function CreditPlanCard({
  plan,
  money,
}: {
  plan: KeloCreditPlan;
  money: (minor: string) => string;
}): React.JSX.Element {
  const checkout = plan.instalments.find((line) => line.seq === plan.checkout_seq);
  const later = plan.instalments.filter((line) => line.seq !== plan.checkout_seq);
  const interest = plan.interest_total_minor !== '0';
  return (
    <ol style={{ listStyle: 'none', padding: 0 }}>
      <li>{t('plan.price', { amount: money(plan.total_minor) })}</li>
      {checkout && (
        <li>
          {t(plan.checkout_seq === 0 ? 'credit.deposit' : 'credit.first_payment', {
            amount: money(checkout.amount_minor),
          })}
        </li>
      )}
      {later.map((line) => (
        <li key={line.seq}>
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
        </li>
      ))}
      <li>
        {interest
          ? t('credit.cost', {
              amount: money(plan.interest_total_minor),
              daily: plan.daily_rate_text,
            })
          : t('credit.cost_none')}
      </li>
      <li className="muted">{t('credit.apr', { apr: plan.apr_text })}</li>
      <li>
        <strong>{t('credit.total', { amount: money(plan.total_payable_minor) })}</strong>
      </li>
      <li>
        {t('credit.late', {
          days: String(plan.late_charges.grace_days),
          fee: money(plan.late_charges.fee_minor),
          cap: money(plan.late_charges.total_cap_minor),
        })}
      </li>
      <li>{t('credit.early')}</li>
      <li>{t('credit.receive_first')}</li>
      <li className="muted">{t('credit.sandbox_lender', { lender: plan.lender_of_record })}</li>
      <li className="muted">
        <a href={`/terms/${plan.kid.key}`}>{t('credit.kid', { version: plan.kid.version })}</a>
        {' · '}
        <a href={`/terms/${plan.terms.key}`}>
          {t('credit.agreement', { version: plan.terms.version })}
        </a>
      </li>
    </ol>
  );
}
