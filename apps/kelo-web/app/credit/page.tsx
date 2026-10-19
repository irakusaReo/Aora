import { formatMinor, type KeloCreditLimit, type List } from '@aora/api-client';
import { notFound } from 'next/navigation';
import { api, exponentOf, isNotFound } from '../../lib/api';
import { t } from '../../lib/messages';

/**
 * How much a person can spread (kelo-experience.md §2): never a headline on a
 * home screen, never worded as money they hold, always with what grows it.
 */
export default async function CreditLimitPage(): Promise<React.JSX.Element> {
  const client = await api();
  let limit: KeloCreditLimit;
  try {
    limit = await client.get<KeloCreditLimit>('/v1/kelo/credit/limit');
  } catch (error) {
    // With the credit flag off, credit does not exist.
    if (isNotFound(error)) notFound();
    throw error;
  }
  const assets = await client.get<List<{ code: string; exponent: number }>>('/v1/assets');
  const money = (minor: string): string =>
    `${limit.currency} ${formatMinor(minor, exponentOf(assets.data, limit.currency))}`;
  return (
    <>
      <h1>{t('credit.limit_title')}</h1>
      <div className="card">
        <p>{t('credit.spread_up_to', { amount: money(limit.limit_minor) })}</p>
        <p>{t('credit.spread_in_use', { amount: money(limit.limit_used_minor) })}</p>
        <p className="muted">{t('credit.grows')}</p>
      </div>
    </>
  );
}
