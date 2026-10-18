import { auth } from '@clerk/nextjs/server';
import { formatMinor, type KeloPublicListing, type List } from '@aora/api-client';
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
          <p className="muted">{t('listing.ways_to_pay_soon')}</p>
        </div>
      )}
    </>
  );
}
