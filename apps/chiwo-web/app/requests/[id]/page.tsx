import { type ChiwoPaymentRequest, type ChiwoUsdc } from '@aora/api-client';
import { notFound } from 'next/navigation';
import { api, isNotFound } from '../../../lib/api';
import { t } from '../../../lib/messages';
import { RequestCard } from '../request-card';

export default async function RequestPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const query = await searchParams;
  const client = await api();
  let request: ChiwoPaymentRequest;
  try {
    request = await client.get<ChiwoPaymentRequest>(`/v1/chiwo/requests/${encodeURIComponent(id)}`);
  } catch (error) {
    if (isNotFound(error)) notFound();
    throw error;
  }
  const usdc = await client.get<ChiwoUsdc>('/v1/chiwo/usdc');
  return (
    <>
      <h1>{t('requests.title')}</h1>
      {query['error'] && <p className="error">{query['error']}</p>}
      <RequestCard request={request} decimals={usdc.asset.decimals} />
      {request.role === 'requester' && request.payer === null && request.status === 'open' && (
        <p className="muted">{t('requests.link', { link: `/requests/${request.id}` })}</p>
      )}
    </>
  );
}
