import {
  AoraApiError,
  formatMinor,
  type KeloCreditDecision,
  type KeloPurchase,
  type List,
} from '@aora/api-client';
import { randomUUID } from 'node:crypto';
import { notFound, redirect } from 'next/navigation';
import { api, exponentOf, field, isNotFound, messageOf } from '../../../../lib/api';
import { formatDate, t } from '../../../../lib/messages';
import { CreditPlanCard } from '../../plan-card';

// Safaricom's published sandbox test number: the only payer Daraja's sandbox allows.
const DARAJA_TEST_NUMBER = '+254708374149';

/** Agree to the plan and take the deposit or first part, in one deliberate step. */
async function agree(form: FormData): Promise<void> {
  'use server';
  const decisionId = field(form, 'decision_id');
  let target = '/purchases';
  try {
    const client = await api();
    const purchase = await client.post<KeloPurchase>(
      '/v1/kelo/purchases',
      {
        decision_id: decisionId,
        expected_total_payable_minor: field(form, 'total_payable_minor'),
        agreement_version: field(form, 'agreement_version'),
        kid_version: field(form, 'kid_version'),
      },
      field(form, 'purchase_key'),
    );
    await client.post(
      `/v1/kelo/me/purchases/${purchase.id}/credit/instalments/${field(form, 'checkout_seq')}/pay`,
      field(form, 'rail') === 'mpesa'
        ? { payer_phone: DARAJA_TEST_NUMBER }
        : { sandbox_scenario: 'success' },
      field(form, 'pay_key'),
    );
  } catch (error) {
    const message =
      error instanceof AoraApiError && error.code === 'sold_out'
        ? t('checkout.sold_out')
        : messageOf(error, t('error.generic'));
    target = `/credit/checkout/${decisionId}?error=${encodeURIComponent(message)}`;
  }
  redirect(target);
}

/** Checkout for a credit plan: the decision, the plan card, the payment method and one button. */
export default async function CreditCheckout({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const query = await searchParams;
  const client = await api();
  let decision: KeloCreditDecision;
  try {
    decision = await client.get<KeloCreditDecision>(
      `/v1/kelo/credit/decisions/${encodeURIComponent(id)}`,
    );
  } catch (error) {
    if (isNotFound(error)) notFound();
    throw error;
  }
  const assets = await client.get<List<{ code: string; exponent: number }>>('/v1/assets');
  const plan = decision.plan;
  const money = (minor: string): string =>
    `${plan.currency} ${formatMinor(minor, exponentOf(assets.data, plan.currency))}`;
  const checkout = plan.instalments.find((line) => line.seq === plan.checkout_seq);

  return (
    <>
      <h1>{t('plan.title', { name: plan.name })}</h1>
      {query['error'] && <p className="error">{query['error']}</p>}
      {decision.outcome === 'declined' ? (
        <div className="card">
          <p>
            <strong>{t('credit.declined')}</strong>
          </p>
          <ul>
            {decision.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <p>{t('credit.declined_other_ways')}</p>
          <p>
            <a href={`/l/${decision.listing_id}`}>{t('nav.browse')}</a>
          </p>
        </div>
      ) : (
        <div className="card">
          <p>
            <strong>{t('credit.approved')}</strong>
          </p>
          <p className="muted">{t('credit.expires', { date: formatDate(decision.expires_at) })}</p>
          <CreditPlanCard plan={plan} money={money} />
          <form action={agree} className="stack">
            <input type="hidden" name="decision_id" value={decision.id} />
            <input type="hidden" name="total_payable_minor" value={plan.total_payable_minor} />
            <input type="hidden" name="agreement_version" value={plan.terms.version} />
            <input type="hidden" name="kid_version" value={plan.kid.version} />
            <input type="hidden" name="checkout_seq" value={String(plan.checkout_seq ?? '')} />
            <input type="hidden" name="purchase_key" value={randomUUID()} />
            <input type="hidden" name="pay_key" value={randomUUID()} />
            <fieldset>
              <legend>{t('checkout.rail_label')}</legend>
              {/* Nothing is pre-selected that spends money (kelo-experience.md §5). */}
              <label style={{ display: 'block' }}>
                <input type="radio" name="rail" value="simulator" required />{' '}
                {t('checkout.rail_simulator')}
              </label>
              <label style={{ display: 'block' }}>
                <input type="radio" name="rail" value="mpesa" required /> {t('checkout.rail_mpesa')}
              </label>
            </fieldset>
            <p className="muted">{t('credit.agree_terms')}</p>
            <button type="submit">
              {t('credit.agree', { amount: money(checkout?.amount_minor ?? '0') })}
            </button>
          </form>
        </div>
      )}
    </>
  );
}
