import { type ChiwoReceipt, formatMinor, type List } from '@aora/api-client';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { api, exponentOf, isNotFound } from '../../../lib/api';
import { formatDate, t } from '../../../lib/messages';

export default async function Payment({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const client = await api();
  let receipt: ChiwoReceipt;
  try {
    receipt = await client.get<ChiwoReceipt>(
      `/v1/chiwo/receipts/merchant_payment/${encodeURIComponent(id)}`,
    );
  } catch (error) {
    if (isNotFound(error)) notFound();
    throw error;
  }
  const assets = await client.get<List<{ code: string; exponent: number }>>('/v1/assets');
  const money = (minor: string): string =>
    `${receipt.currency} ${formatMinor(minor, exponentOf(assets.data, receipt.currency))}`;
  const final = receipt.status === 'succeeded' || receipt.status === 'failed';
  return (
    <div className="card">
      <h1>{t('payment.title', { merchant: receipt.merchant.trading_name })}</h1>
      <p>
        <span className="pill">{t(`payment.status.${receipt.status}`)}</span>
      </p>
      <p>{t(`payment.explain.${receipt.status}`)}</p>
      <p>{t('pay.amount', { amount: money(receipt.amount_minor) })}</p>
      <p>
        {receipt.fee_minor === '0'
          ? t('pay.fee_none')
          : t('pay.fee', { amount: money(receipt.fee_minor) })}
      </p>
      <p>
        <strong>{t('pay.total', { amount: money(receipt.total_minor) })}</strong>
      </p>
      <p className="muted">{t('receipt.code', { code: receipt.merchant.code })}</p>
      <p className="muted">{t('receipt.when', { date: formatDate(receipt.created_at) })}</p>
      <p className="muted">{t('receipt.reference', { reference: receipt.reference })}</p>
      {!final && (
        <p>
          <Link href={`/payments/${receipt.id}`}>{t('payment.refresh')}</Link>
        </p>
      )}
    </div>
  );
}
