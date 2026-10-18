import { formatMinor, type List } from '@aora/api-client';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { api, exponentOf, field, messageOf } from '../../lib/api';
import { formatDate, t } from '../../lib/messages';

interface Quote {
  id: string;
  price_minor: string;
  currency: string;
  expires_at: string;
  status: 'offered' | 'accepted' | 'declined' | 'expired';
}
interface QuoteRequest {
  id: string;
  listing_id: string;
  listing_title: string;
  details: string;
  status: string;
  quotes: Quote[];
}

async function decline(form: FormData): Promise<void> {
  'use server';
  let target = '/quotes';
  try {
    await (await api()).post(`/v1/kelo/me/quotes/${field(form, 'quote_id')}/decline`);
  } catch (error) {
    target = `/quotes?error=${encodeURIComponent(messageOf(error, t('error.generic')))}`;
  }
  redirect(target);
}

export default async function Quotes({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}): Promise<React.JSX.Element> {
  const query = await searchParams;
  const client = await api();
  const [requests, assets] = await Promise.all([
    client.get<List<QuoteRequest>>('/v1/kelo/me/quote-requests'),
    client.get<List<{ code: string; exponent: number }>>('/v1/assets'),
  ]);
  return (
    <>
      <h1>{t('quotes.title')}</h1>
      {query['error'] && <p className="error">{query['error']}</p>}
      {requests.data.length === 0 && <p className="muted">{t('quotes.empty')}</p>}
      {requests.data.map((request) => (
        <div className="card" key={request.id}>
          <p>
            <Link href={`/l/${request.listing_id}`}>
              <strong>{request.listing_title}</strong>
            </Link>
          </p>
          <p className="muted">{request.details}</p>
          {request.quotes.length === 0 && <p>{t('quotes.waiting')}</p>}
          {request.quotes.map((quote) => (
            <div key={quote.id} style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <span>
                {t('quotes.price', {
                  amount: `${quote.currency} ${formatMinor(quote.price_minor, exponentOf(assets.data, quote.currency))}`,
                  date: formatDate(quote.expires_at),
                })}
              </span>
              <span className="pill">{t(`quotes.status.${quote.status}`)}</span>
              {quote.status === 'offered' && (
                <form action={decline}>
                  <input type="hidden" name="quote_id" value={quote.id} />
                  <button type="submit" className="secondary">
                    {t('quotes.decline')}
                  </button>
                </form>
              )}
            </div>
          ))}
        </div>
      ))}
    </>
  );
}
