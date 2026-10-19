import { type ChiwoPaymentRequest, formatMinor } from '@aora/api-client';
import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { api, back, field } from '../../lib/api';
import { formatDate, t } from '../../lib/messages';

async function act(form: FormData): Promise<void> {
  'use server';
  const id = field(form, 'id');
  let target = `/requests/${id}`;
  try {
    const client = await api();
    if (field(form, 'action') === 'pay') {
      await client.post(`/v1/chiwo/requests/${id}/pay`, {}, field(form, 'key'));
    } else {
      await client.post(`/v1/chiwo/requests/${id}/cancel`);
    }
  } catch (error) {
    target = back(`/requests/${id}`, error, t('error.generic'));
  }
  redirect(target);
}

/** One request, with the action open to this viewer: pay it, or cancel it if it is theirs. */
export function RequestCard({
  request,
  decimals,
}: {
  request: ChiwoPaymentRequest;
  decimals: number;
}): React.JSX.Element {
  const money = `${request.currency} ${formatMinor(request.amount_minor, decimals)}`;
  const open = request.status === 'open';
  return (
    <div className="card">
      <p>
        <strong>{money}</strong>{' '}
        <span className="pill">{t(`requests.status.${request.status}`)}</span>
      </p>
      {request.note && <p>{request.note}</p>}
      <p className="muted">
        {request.role === 'requester'
          ? t('requests.to', { name: request.payer?.display_name ?? t('requests.anyone') })
          : t('requests.from', { name: request.requester.display_name })}
      </p>
      {open && (
        <p className="muted">{t('requests.expires', { date: formatDate(request.expires_at) })}</p>
      )}
      {open && request.role !== 'requester' && (
        <form action={act}>
          <input type="hidden" name="id" value={request.id} />
          <input type="hidden" name="action" value="pay" />
          <input type="hidden" name="key" value={randomUUID()} />
          <button type="submit">{t('requests.pay', { amount: money })}</button>
        </form>
      )}
      {open && request.role === 'requester' && (
        <form action={act}>
          <input type="hidden" name="id" value={request.id} />
          <input type="hidden" name="action" value="cancel" />
          <button type="submit" className="secondary">
            {t('requests.cancel')}
          </button>
        </form>
      )}
    </div>
  );
}
