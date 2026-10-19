import { type ChiwoRecipient, type ChiwoUsdc, type List, toMinorUnits } from '@aora/api-client';
import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { api, back, field } from '../../lib/api';
import { t } from '../../lib/messages';

async function find(form: FormData): Promise<void> {
  'use server';
  let target: string;
  try {
    const found = await (
      await api()
    ).post<ChiwoRecipient>('/v1/chiwo/recipients', {
      phone: field(form, 'phone'),
    });
    target = `/send?found=${found.id}`;
  } catch (error) {
    target = back('/send', error, t('error.generic'));
  }
  redirect(target);
}

async function confirm(form: FormData): Promise<void> {
  'use server';
  let target = '/send';
  try {
    await (await api()).post(`/v1/chiwo/recipients/${field(form, 'id')}/confirm`);
  } catch (error) {
    target = back(`/send?found=${field(form, 'id')}`, error, t('error.generic'));
  }
  redirect(target);
}

async function send(form: FormData): Promise<void> {
  'use server';
  const amount = toMinorUnits(field(form, 'amount'), Number(field(form, 'decimals')));
  const note = field(form, 'note');
  let target = '/send?ok=1';
  try {
    if (!amount) throw new Error('amount');
    await (
      await api()
    ).post(
      '/v1/chiwo/transfers',
      {
        recipient_id: field(form, 'recipient_id'),
        amount_minor: amount,
        ...(note ? { note } : {}),
      },
      field(form, 'key'),
    );
  } catch (error) {
    target = back('/send', error, t('error.generic'));
  }
  redirect(target);
}

export default async function Send({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}): Promise<React.JSX.Element> {
  const query = await searchParams;
  const client = await api();
  const [recipients, usdc] = await Promise.all([
    client.get<List<ChiwoRecipient>>('/v1/chiwo/recipients'),
    client.get<ChiwoUsdc>('/v1/chiwo/usdc'),
  ]);
  const found = recipients.data.find((r) => r.id === query['found'] && !r.confirmed);
  const confirmed = recipients.data.filter((r) => r.confirmed);
  return (
    <>
      <h1>{t('send.title')}</h1>
      {query['error'] && <p className="error">{query['error']}</p>}
      {query['ok'] && <p className="ok">{t('send.sent')}</p>}
      <p className="muted">{t('send.free')}</p>
      <div className="card">
        <form action={find} className="stack">
          <label>
            {t('send.find')}
            <input name="phone" placeholder="+254712345678" required inputMode="tel" />
          </label>
          <button type="submit" className="secondary">
            {t('send.find_button')}
          </button>
        </form>
        {found && (
          <form action={confirm} className="stack">
            <input type="hidden" name="id" value={found.id} />
            <p>{t('send.confirm_who', { name: found.display_name })}</p>
            <button type="submit">{t('send.confirm_button')}</button>
          </form>
        )}
      </div>
      <div className="card">
        <h2>{t('send.people')}</h2>
        {confirmed.length === 0 ? (
          <p className="muted">{t('send.none')}</p>
        ) : (
          <form action={send} className="stack">
            <input type="hidden" name="key" value={randomUUID()} />
            <input type="hidden" name="decimals" value={usdc.asset.decimals} />
            <select name="recipient_id" required>
              {confirmed.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.display_name}
                </option>
              ))}
            </select>
            <label>
              {t('send.amount')}
              <input name="amount" required inputMode="decimal" placeholder="5.00" />
            </label>
            <label>
              {t('send.note')}
              <input name="note" maxLength={140} />
            </label>
            <button type="submit">{t('send.button')}</button>
          </form>
        )}
      </div>
    </>
  );
}
