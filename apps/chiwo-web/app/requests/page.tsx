import {
  type ChiwoPaymentRequest,
  type ChiwoUsdc,
  type List,
  toMinorUnits,
} from '@aora/api-client';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { api, back, field } from '../../lib/api';
import { t } from '../../lib/messages';
import { RequestCard } from './request-card';

async function create(form: FormData): Promise<void> {
  'use server';
  const amount = toMinorUnits(field(form, 'amount'), Number(field(form, 'decimals')));
  const note = field(form, 'note');
  const phone = field(form, 'phone');
  let target: string;
  try {
    if (!amount) throw new Error('amount');
    const created = await (
      await api()
    ).post<ChiwoPaymentRequest>('/v1/chiwo/requests', {
      amount_minor: amount,
      ...(note ? { note } : {}),
      ...(phone ? { payer_phone: phone } : {}),
    });
    target = `/requests/${created.id}`;
  } catch (error) {
    target = back('/requests', error, t('error.generic'));
  }
  redirect(target);
}

export default async function Requests({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}): Promise<React.JSX.Element> {
  const query = await searchParams;
  const client = await api();
  const [requests, usdc] = await Promise.all([
    client.get<List<ChiwoPaymentRequest>>('/v1/chiwo/requests'),
    client.get<ChiwoUsdc>('/v1/chiwo/usdc'),
  ]);
  return (
    <>
      <h1>{t('requests.title')}</h1>
      {query['error'] && <p className="error">{query['error']}</p>}
      <div className="card">
        <h2>{t('requests.new')}</h2>
        <form action={create} className="stack">
          <input type="hidden" name="decimals" value={usdc.asset.decimals} />
          <label>
            {t('send.amount')}
            <input name="amount" required inputMode="decimal" placeholder="5.00" />
          </label>
          <label>
            {t('send.note')}
            <input name="note" maxLength={140} />
          </label>
          <label>
            {t('requests.payer')}
            <input name="phone" inputMode="tel" placeholder="+254712345678" />
          </label>
          <button type="submit">{t('requests.create')}</button>
        </form>
      </div>
      {requests.data.length === 0 && <p className="muted">{t('requests.empty')}</p>}
      {requests.data.map((request) => (
        <div key={request.id}>
          <RequestCard request={request} decimals={usdc.asset.decimals} />
          <p>
            <Link href={`/requests/${request.id}`}>{request.id.slice(0, 8)}</Link>
          </p>
        </div>
      ))}
    </>
  );
}
