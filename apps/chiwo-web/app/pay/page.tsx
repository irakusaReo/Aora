import {
  type ChiwoMerchantPayment,
  type ChiwoPaymentQuote,
  formatMinor,
  type List,
  toMinorUnits,
} from '@aora/api-client';
import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { api, exponentOf, field, messageOf } from '../../lib/api';
import { t } from '../../lib/messages';

const CURRENCY = 'KES';

async function review(form: FormData): Promise<void> {
  'use server';
  const code = field(form, 'code').toUpperCase().replaceAll(' ', '');
  const assets = await (await api()).get<List<{ code: string; exponent: number }>>('/v1/assets');
  const amount = toMinorUnits(field(form, 'amount'), exponentOf(assets.data, CURRENCY));
  if (!amount)
    redirect(
      `/pay?code=${encodeURIComponent(code)}&error=${encodeURIComponent(t('pay.bad_amount'))}`,
    );
  redirect(`/pay?code=${encodeURIComponent(code)}&amount=${amount}`);
}

async function confirm(form: FormData): Promise<void> {
  'use server';
  let target: string;
  try {
    // What the consumer was shown goes back with the payment; a changed fee is refused (P7-5).
    const payment = await (
      await api()
    ).post<ChiwoMerchantPayment>(
      '/v1/chiwo/payments',
      {
        pay_code: field(form, 'code'),
        amount_minor: field(form, 'amount'),
        currency: CURRENCY,
        expected_fee_minor: field(form, 'fee'),
        expected_total_minor: field(form, 'total'),
        ...(field(form, 'rail') === 'simulator' ? { sandbox_scenario: 'success' } : {}),
      },
      field(form, 'key'),
    );
    target = `/payments/${payment.id}`;
  } catch (error) {
    target = `/pay?error=${encodeURIComponent(messageOf(error, t('error.generic')))}`;
  }
  redirect(target);
}

export default async function Pay({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}): Promise<React.JSX.Element> {
  const query = await searchParams;
  const client = await api();
  const code = query['code'] ?? '';
  const amount = query['amount'] ?? '';
  let quote: ChiwoPaymentQuote | null = null;
  let error = query['error'] ?? null;
  if (code && amount && !error) {
    try {
      quote = await client.post<ChiwoPaymentQuote>('/v1/chiwo/payments/quote', {
        pay_code: code,
        amount_minor: amount,
        currency: CURRENCY,
      });
    } catch (caught) {
      error = messageOf(caught, t('error.generic'));
    }
  }
  const assets = await client.get<List<{ code: string; exponent: number }>>('/v1/assets');
  const money = (minor: string): string =>
    `${CURRENCY} ${formatMinor(minor, exponentOf(assets.data, CURRENCY))}`;

  return (
    <>
      <h1>{t('pay.title')}</h1>
      {error && <p className="error">{error}</p>}
      {!quote && (
        <div className="card">
          <form action={review} className="stack">
            <label>
              {t('pay.code_label')}
              <input
                name="code"
                defaultValue={code}
                required
                maxLength={9}
                autoCapitalize="characters"
                autoComplete="off"
              />
            </label>
            <label>
              {t('pay.amount_label', { currency: CURRENCY })}
              <input name="amount" required inputMode="decimal" placeholder="150.00" />
            </label>
            <button type="submit">{t('pay.review')}</button>
          </form>
        </div>
      )}
      {quote && (
        <div className="card">
          <h2>{t('pay.to', { merchant: quote.merchant.trading_name })}</h2>
          <p>{t('pay.amount', { amount: money(quote.amount_minor) })}</p>
          <p>
            {quote.fee_minor === '0'
              ? t('pay.fee_none')
              : t('pay.fee', { amount: money(quote.fee_minor) })}
          </p>
          <p>
            <strong>{t('pay.total', { amount: money(quote.total_minor) })}</strong>
          </p>
          <p className="muted">{t('pay.timing', { timing: quote.timing })}</p>
          <form action={confirm} className="stack">
            <input type="hidden" name="code" value={quote.pay_code} />
            <input type="hidden" name="amount" value={quote.amount_minor} />
            <input type="hidden" name="fee" value={quote.fee_minor} />
            <input type="hidden" name="total" value={quote.total_minor} />
            <input type="hidden" name="key" value={randomUUID()} />
            <fieldset>
              <legend>{t('pay.rail_label')}</legend>
              <label style={{ display: 'block' }}>
                <input type="radio" name="rail" value="mpesa" required /> {t('pay.rail_mpesa')}
              </label>
              <label style={{ display: 'block' }}>
                <input type="radio" name="rail" value="simulator" required />{' '}
                {t('pay.rail_simulator')}
              </label>
            </fieldset>
            <button type="submit">{t('pay.confirm', { amount: money(quote.total_minor) })}</button>
          </form>
          <p>
            <Link href={`/pay?code=${encodeURIComponent(quote.pay_code)}`}>{t('pay.change')}</Link>
          </p>
        </div>
      )}
    </>
  );
}
