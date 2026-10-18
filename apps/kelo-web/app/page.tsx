import {
  formatMinor,
  type KeloCategory,
  type KeloListingSummary,
  type List,
} from '@aora/api-client';
import Link from 'next/link';
import { exponentOf, publicApi } from '../lib/api';
import { t } from '../lib/messages';

export default async function Browse({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}): Promise<React.JSX.Element> {
  const query = await searchParams;
  const client = publicApi();
  const params = new URLSearchParams();
  if (query['q']) params.set('q', query['q']);
  if (query['category']) params.set('category', query['category']);
  if (query['cursor']) params.set('cursor', query['cursor']);
  const [categories, page, assets] = await Promise.all([
    client.get<List<KeloCategory>>('/v1/kelo/categories'),
    client.get<{ data: KeloListingSummary[]; next_cursor: string | null }>(
      `/v1/kelo/marketplace/listings?${params.toString()}`,
    ),
    client.get<List<{ code: string; exponent: number }>>('/v1/assets'),
  ]);
  const price = (item: KeloListingSummary): string =>
    item.from_price_minor
      ? t('listing.from', {
          amount: `${item.currency} ${formatMinor(item.from_price_minor, exponentOf(assets.data, item.currency))}`,
        })
      : t('listing.by_quote');
  const next = new URLSearchParams(params);
  if (page.next_cursor) next.set('cursor', page.next_cursor);

  return (
    <>
      <h1>{t('browse.title')}</h1>
      <p className="muted">{t('app.tagline')}</p>
      <form className="card" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <label>
          {t('browse.search_label')}
          <input name="q" defaultValue={query['q'] ?? ''} maxLength={100} />
        </label>
        <select
          name="category"
          defaultValue={query['category'] ?? ''}
          aria-label={t('browse.all_categories')}
        >
          <option value="">{t('browse.all_categories')}</option>
          {categories.data.map((category) => (
            <option key={category.slug} value={category.slug}>
              {category.name}
            </option>
          ))}
        </select>
        <button type="submit">{t('browse.search_button')}</button>
      </form>
      {page.data.length === 0 && <p className="muted">{t('browse.empty')}</p>}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
          gap: 12,
        }}
      >
        {page.data.map((item) => (
          <Link key={item.id} href={`/l/${item.id}`} className="card" style={{ display: 'block' }}>
            {item.image_url && (
              // Sized to its slot; the text shows first on a slow connection.
              <img
                src={item.image_url}
                alt=""
                width={200}
                height={150}
                loading="lazy"
                style={{ objectFit: 'cover', width: '100%' }}
              />
            )}
            <strong>{item.title}</strong>
            <div>{price(item)}</div>
            <div className="muted">{t('listing.sold_by', { store: item.store_name })}</div>
          </Link>
        ))}
      </div>
      {page.next_cursor && (
        <p>
          <Link href={`/?${next.toString()}`}>{t('browse.more')}</Link>
        </p>
      )}
    </>
  );
}
