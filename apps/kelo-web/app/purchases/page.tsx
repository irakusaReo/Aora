import { formatMinor, type KeloCreditQuote, type KeloPurchase, type List } from '@aora/api-client';
import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { api, exponentOf, field, messageOf } from '../../lib/api';
import { t } from '../../lib/messages';
import { CreditPurchaseCard } from '../credit/purchase-card';

// Safaricom's published sandbox test number: the only payer Daraja's sandbox allows.
const DARAJA_TEST_NUMBER = '+254708374149';

async function act(form: FormData): Promise<void> {
  'use server';
  const id = field(form, 'purchase_id');
  const action = field(form, 'action');
  let target = '/purchases';
  try {
    const client = await api();
    if (action === 'pay') {
      await client.post(
        `/v1/kelo/me/purchases/${id}/instalments/${field(form, 'seq')}/pay`,
        field(form, 'rail') === 'mpesa'
          ? { payer_phone: DARAJA_TEST_NUMBER }
          : { sandbox_scenario: 'success' },
        field(form, 'pay_key'),
      );
    } else if (action === 'pay_credit') {
      await client.post(
        `/v1/kelo/me/purchases/${id}/credit/instalments/${field(form, 'seq')}/pay`,
        field(form, 'rail') === 'mpesa'
          ? { payer_phone: DARAJA_TEST_NUMBER }
          : { sandbox_scenario: 'success' },
        field(form, 'pay_key'),
      );
    } else if (action === 'repay') {
      await client.post(
        `/v1/kelo/me/purchases/${id}/credit/repay`,
        {
          kind: field(form, 'kind'),
          expected_amount_minor: field(form, 'expected_amount_minor'),
          ...(field(form, 'rail') === 'mpesa'
            ? { payer_phone: DARAJA_TEST_NUMBER }
            : { sandbox_scenario: 'success' }),
        },
        field(form, 'pay_key'),
      );
    } else if (action === 'cancel') {
      await client.post(`/v1/kelo/me/purchases/${id}/cancel`);
    } else if (action === 'confirm_delivery') {
      await client.post(`/v1/kelo/me/purchases/${id}/confirm-delivery`);
    }
  } catch (error) {
    target = `/purchases?error=${encodeURIComponent(messageOf(error, t('error.generic')))}`;
  }
  redirect(target);
}

export default async function Purchases({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}): Promise<React.JSX.Element> {
  const query = await searchParams;
  const client = await api();
  // Nairobi's date (UTC+3 all year), the calendar KELO's schedules are dated in.
  const today = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
  const [purchases, assets] = await Promise.all([
    client.get<List<KeloPurchase>>('/v1/kelo/me/purchases'),
    client.get<List<{ code: string; exponent: number }>>('/v1/assets'),
  ]);
  // Today's exact amounts for each open credit plan, from the API.
  const quotes = new Map(
    await Promise.all(
      purchases.data
        .filter(
          (purchase) => purchase.credit && ['active', 'defaulted'].includes(purchase.credit.status),
        )
        .map(
          async (purchase) =>
            [
              purchase.id,
              await client.get<KeloCreditQuote>(
                `/v1/kelo/me/purchases/${purchase.id}/credit/quote`,
              ),
            ] as const,
        ),
    ),
  );
  return (
    <>
      <h1>{t('purchases.title')}</h1>
      {query['error'] && <p className="error">{query['error']}</p>}
      {purchases.data.length === 0 && <p className="muted">{t('purchases.empty')}</p>}
      {purchases.data.map((purchase) => {
        const money = (minor: string): string =>
          `${purchase.currency} ${formatMinor(minor, exponentOf(assets.data, purchase.currency))}`;
        if (purchase.credit) {
          return (
            <CreditPurchaseCard
              key={purchase.id}
              purchase={{ ...purchase, credit: purchase.credit }}
              money={money}
              act={act}
              today={today}
              quote={quotes.get(purchase.id) ?? null}
            />
          );
        }
        const open = purchase.instalments.filter(
          (line) => line.status !== 'paid' && line.status !== 'cancelled',
        );
        const next = open[0];
        const left = open.reduce((sum, line) => sum + BigInt(line.amount_minor), 0n).toString();
        const active = purchase.plan_status === 'active' && purchase.status !== 'cancelled';
        const hidden = <input type="hidden" name="purchase_id" value={purchase.id} />;
        return (
          <div className="card" key={purchase.id}>
            <p>
              <Link href={`/l/${purchase.listing_id}`}>
                <strong>{purchase.listing_title}</strong>
              </Link>{' '}
              <span className="pill">{t(`purchases.status.${purchase.status}`)}</span>
            </p>
            <p>
              {t('purchases.paid_of', {
                paid: money(purchase.paid_minor),
                total: money(purchase.total_minor),
              })}
            </p>
            <ol>
              {purchase.instalments.map((line) => (
                <li key={line.seq}>
                  {line.due_on}: {money(line.amount_minor)}{' '}
                  <span className="pill">{t(`instalment.status.${line.status}`)}</span>
                </li>
              ))}
            </ol>
            {active && next && (
              <>
                <p>
                  {t('purchases.next', { amount: money(next.amount_minor), date: next.due_on })}
                </p>
                <p className="muted">{t('purchases.left', { amount: money(left) })}</p>
                {next.status === 'pending' ? (
                  <p className="muted">{t('purchases.checking')}</p>
                ) : (
                  <form action={act} className="stack">
                    {hidden}
                    <input type="hidden" name="action" value="pay" />
                    <input type="hidden" name="seq" value={next.seq} />
                    <input type="hidden" name="pay_key" value={randomUUID()} />
                    <fieldset>
                      <legend>{t('checkout.rail_label')}</legend>
                      <label style={{ display: 'block' }}>
                        <input type="radio" name="rail" value="simulator" required />{' '}
                        {t('checkout.rail_simulator')}
                      </label>
                      <label style={{ display: 'block' }}>
                        <input type="radio" name="rail" value="mpesa" required />{' '}
                        {t('checkout.rail_mpesa')}
                      </label>
                    </fieldset>
                    <button type="submit">
                      {t('purchases.pay_next', { amount: money(next.amount_minor) })}
                    </button>
                  </form>
                )}
              </>
            )}
            {purchase.plan_status === 'paid_in_full' && <p>{t('purchases.receive')}</p>}
            {purchase.plan_status === 'paid_in_full' &&
              purchase.status === 'merchant_confirmed' && (
                <form action={act}>
                  {hidden}
                  <input type="hidden" name="action" value="confirm_delivery" />
                  <button type="submit">{t('purchases.confirm_delivery')}</button>
                </form>
              )}
            {purchase.refund && (
              <p>
                {t('purchases.refund', {
                  refund: money(purchase.refund.refund_minor),
                  paid: money(purchase.refund.paid_minor),
                  fee: money(purchase.refund.fee_minor),
                  status: purchase.refund.status,
                })}
              </p>
            )}
            {['placed', 'payment_ready', 'merchant_confirmed'].includes(purchase.status) && (
              <form action={act}>
                {hidden}
                <input type="hidden" name="action" value="cancel" />
                <button type="submit" className="secondary">
                  {t('purchases.cancel')}
                </button>
              </form>
            )}
          </div>
        );
      })}
    </>
  );
}
