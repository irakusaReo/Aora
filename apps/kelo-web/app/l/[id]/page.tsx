import { auth } from '@clerk/nextjs/server';
import {
  AoraApiError,
  formatMinor,
  type KeloPlan,
  type KeloPublicListing,
  type KeloPurchase,
  type List,
} from '@aora/api-client';
import { randomUUID } from 'node:crypto';
import { notFound, redirect } from 'next/navigation';
import { api, exponentOf, field, isNotFound, messageOf, publicApi } from '../../../lib/api';
import { formatDate, t } from '../../../lib/messages';

async function askForQuote(form: FormData): Promise<void> {
  'use server';
  const listingId = field(form, 'listing_id');
  let target = `/l/${listingId}?sent=1`;
  try {
    await (
      await api()
    ).post(
      '/v1/kelo/quote-requests',
      { listing_id: listingId, details: field(form, 'details') },
      field(form, 'idempotency_key'),
    );
  } catch (error) {
    target = `/l/${listingId}?error=${encodeURIComponent(messageOf(error, t('error.generic')))}`;
  }
  redirect(target);
}

async function buy(form: FormData): Promise<void> {
  'use server';
  const listingId = field(form, 'listing_id');
  const option = field(form, 'option');
  const [kind, optionId] = option.split(':');
  let target = '/purchases';
  try {
    const client = await api();
    const purchase = await client.post<KeloPurchase>(
      '/v1/kelo/purchases',
      {
        listing_id: listingId,
        ...(kind === 'session' ? { session_id: optionId } : { variant_id: optionId }),
        template_key: field(form, 'template_key'),
        expected_total_minor: field(form, 'total_minor'),
        terms_version: field(form, 'terms_version'),
      },
      field(form, 'purchase_key'),
    );
    await client.post(
      `/v1/kelo/me/purchases/${purchase.id}/instalments/1/pay`,
      payBody(field(form, 'rail')),
      field(form, 'pay_key'),
    );
  } catch (error) {
    const message =
      error instanceof AoraApiError && error.code === 'sold_out'
        ? t('checkout.sold_out')
        : messageOf(error, t('error.generic'));
    target = `/l/${listingId}?option=${encodeURIComponent(option)}&error=${encodeURIComponent(message)}`;
  }
  redirect(target);
}

/** SANDBOX: the simulator succeeds; the M-Pesa sandbox only accepts Safaricom's test number. */
function payBody(rail: string): Record<string, string> {
  return rail === 'mpesa' ? { payer_phone: DARAJA_TEST_NUMBER } : { sandbox_scenario: 'success' };
}
// Safaricom's published sandbox test number: the only payer Daraja's sandbox allows.
const DARAJA_TEST_NUMBER = '+254708374149';

export default async function ListingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const query = await searchParams;
  const client = publicApi();
  let listing: KeloPublicListing;
  try {
    listing = await client.get<KeloPublicListing>(
      `/v1/kelo/marketplace/listings/${encodeURIComponent(id)}`,
    );
  } catch (error) {
    if (isNotFound(error)) notFound();
    throw error;
  }
  const [assets, session] = await Promise.all([
    client.get<List<{ code: string; exponent: number }>>('/v1/assets'),
    auth(),
  ]);
  const exponent = exponentOf(assets.data, listing.currency);
  const money = (minor: string): string => `${listing.currency} ${formatMinor(minor, exponent)}`;
  const percent = (bps: number): string => formatMinor(String(bps), 2);
  const options = [
    ...listing.variants
      .filter((v) => v.in_stock)
      .map((v) => ({ key: `variant:${v.id}`, label: `${v.name}: ${money(v.price_minor)}` })),
    ...listing.sessions
      .filter((s) => s.available)
      .map((s) => ({
        key: `session:${s.id}`,
        label: `${formatDate(s.starts_at)}: ${money(s.price_minor)}`,
      })),
  ];
  const chosen = options.find((o) => o.key === query['option']) ?? options[0];
  let plans: KeloPlan[] = [];
  if (chosen && listing.type !== 'quote_service') {
    const [kind, optionId] = chosen.key.split(':');
    plans = (
      await client.get<List<KeloPlan>>(
        `/v1/kelo/marketplace/listings/${listing.id}/plans?${kind === 'session' ? 'session_id' : 'variant_id'}=${optionId ?? ''}`,
      )
    ).data;
  }

  return (
    <>
      <h1>{listing.title}</h1>
      <p className="muted">{t('listing.sold_by', { store: listing.store.display_name })}</p>
      {listing.images.length > 0 && (
        <div style={{ display: 'flex', gap: 8, overflowX: 'auto' }}>
          {listing.images.map((image) => (
            <img
              key={image.url}
              src={image.url}
              alt=""
              width={320}
              height={240}
              loading="lazy"
              style={{ objectFit: 'cover' }}
            />
          ))}
        </div>
      )}
      <div className="card">
        <p>{listing.description}</p>
        {listing.variants.length > 0 && (
          <ul>
            {listing.variants.map((variant) => (
              <li key={variant.id}>
                {variant.name}: {money(variant.price_minor)} ·{' '}
                {variant.in_stock ? t('listing.in_stock') : t('listing.out_of_stock')}
              </li>
            ))}
          </ul>
        )}
        {listing.sessions.length > 0 && (
          <ul>
            {listing.sessions.map((session) => (
              <li key={session.id}>
                {formatDate(session.starts_at)}: {money(session.price_minor)} ·{' '}
                {session.available ? t('listing.places_left') : t('listing.full')}
              </li>
            ))}
          </ul>
        )}
      </div>

      {listing.type === 'quote_service' ? (
        <div className="card">
          <h2>{t('quote.title')}</h2>
          {query['sent'] && <p className="ok">{t('quote.sent')}</p>}
          {query['error'] && <p className="error">{query['error']}</p>}
          {session.userId ? (
            <form action={askForQuote} className="stack">
              <input type="hidden" name="listing_id" value={listing.id} />
              <input type="hidden" name="idempotency_key" value={randomUUID()} />
              <label>
                {t('quote.details_label')}
                <textarea name="details" required minLength={10} maxLength={1000} rows={4} />
              </label>
              <button type="submit">{t('quote.send')}</button>
            </form>
          ) : (
            <p>{t('quote.sign_in')}</p>
          )}
        </div>
      ) : (
        <div className="card">
          <h2>{t('listing.ways_to_pay')}</h2>
          {query['error'] && <p className="error">{query['error']}</p>}
          {options.length > 1 && (
            <form style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <select name="option" defaultValue={chosen?.key} aria-label={t('plan.choose_option')}>
                {options.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
              <button type="submit" className="secondary">
                {t('browse.search_button')}
              </button>
            </form>
          )}
          {!chosen && <p className="muted">{t('listing.out_of_stock')}</p>}
          {chosen && plans.length === 0 && <p className="muted">{t('plan.none')}</p>}
          {chosen &&
            plans.map((plan) => (
              // The plan-at-a-glance card (kelo-experience.md §2), in its fixed order.
              <section key={plan.template_key} className="card" aria-label={plan.name}>
                <h3>{t('plan.title', { name: plan.name })}</h3>
                <ol style={{ listStyle: 'none', padding: 0 }}>
                  <li>{t('plan.price', { amount: money(plan.total_minor) })}</li>
                  <li>
                    {t('plan.first_payment', {
                      amount: money(plan.instalments[0]?.amount_minor ?? '0'),
                    })}
                  </li>
                  {plan.instalments.map((line) => (
                    <li key={line.seq}>
                      {t('plan.instalment', {
                        seq: String(line.seq),
                        date: line.due_on,
                        amount: money(line.amount_minor),
                      })}
                    </li>
                  ))}
                  <li>{t('plan.fees_none')}</li>
                  <li>
                    <strong>{t('plan.total', { amount: money(plan.total_minor) })}</strong>
                  </li>
                  <li>{t('plan.late')}</li>
                  <li>{t('plan.receive_after')}</li>
                  <li>
                    {t('plan.cancel_rule', {
                      percent: percent(plan.cancellation.fee_bps),
                      cap: money(plan.cancellation.fee_cap_minor),
                    })}
                  </li>
                  {listing.type === 'scheduled_service' && (
                    <li>
                      {t('plan.cancel_after_start', {
                        percent: percent(plan.cancellation.after_start_returned_bps),
                      })}
                    </li>
                  )}
                </ol>
                {session.userId ? (
                  <form action={buy} className="stack">
                    <input type="hidden" name="listing_id" value={listing.id} />
                    <input type="hidden" name="option" value={chosen.key} />
                    <input type="hidden" name="template_key" value={plan.template_key} />
                    <input type="hidden" name="total_minor" value={plan.total_minor} />
                    <input type="hidden" name="terms_version" value={plan.terms.version} />
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
                        <input type="radio" name="rail" value="mpesa" required />{' '}
                        {t('checkout.rail_mpesa')}
                      </label>
                    </fieldset>
                    <p className="muted">
                      <a href={`/terms/${plan.terms.key}`}>
                        {t('checkout.terms', { version: plan.terms.version })}
                      </a>
                    </p>
                    <button type="submit">
                      {t('checkout.agree', {
                        amount: money(plan.instalments[0]?.amount_minor ?? '0'),
                      })}
                    </button>
                  </form>
                ) : (
                  <p>{t('checkout.sign_in')}</p>
                )}
              </section>
            ))}
        </div>
      )}
    </>
  );
}
