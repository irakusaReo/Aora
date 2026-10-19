import { type ChiwoActivityItem, type ChiwoMe, formatMinor, type List } from '@aora/api-client';
import { auth } from '@clerk/nextjs/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { api, exponentOf, field, messageOf } from '../lib/api';
import { formatDate, t } from '../lib/messages';

async function savePhone(form: FormData): Promise<void> {
  'use server';
  let target = '/';
  try {
    await (await api()).put('/v1/me/phone', { phone: field(form, 'phone') });
  } catch (error) {
    target = `/?error=${encodeURIComponent(messageOf(error, t('error.generic')))}`;
  }
  redirect(target);
}

async function signUp(form: FormData): Promise<void> {
  'use server';
  let target = '/';
  try {
    await (await api()).post('/v1/chiwo/sign-up', { terms_version: field(form, 'terms_version') });
  } catch (error) {
    target = `/?error=${encodeURIComponent(messageOf(error, t('error.generic')))}`;
  }
  redirect(target);
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}): Promise<React.JSX.Element> {
  const query = await searchParams;
  const session = await auth();
  if (!session.userId) {
    return (
      <div className="card">
        <h1>{t('app.name')}</h1>
        <p>{t('app.tagline')}</p>
        <p className="muted">{t('home.signed_out')}</p>
      </div>
    );
  }
  const client = await api();
  const me = await client.get<ChiwoMe>('/v1/chiwo/me');
  if (!me.signed_up) {
    return (
      <>
        <h1>{t('signup.title')}</h1>
        {query['error'] && <p className="error">{query['error']}</p>}
        <p>{t('signup.personal')}</p>
        {!me.phone_on_file && (
          <div className="card">
            <h2>{t('signup.phone_title')}</h2>
            <p className="muted">{t('signup.phone_help')}</p>
            <form action={savePhone} className="stack">
              <input name="phone" placeholder="+254712345678" required inputMode="tel" />
              <button type="submit">{t('signup.phone_save')}</button>
            </form>
          </div>
        )}
        {me.phone_on_file && (
          <div className="card">
            <form action={signUp} className="stack">
              <input type="hidden" name="terms_version" value={me.terms.version} />
              <label>
                <input type="checkbox" required />{' '}
                {t('signup.terms', { version: me.terms.version })}{' '}
                <Link href={`/terms/${me.terms.key}`}>{t('signup.read_terms')}</Link>
              </label>
              <button type="submit">{t('signup.agree')}</button>
            </form>
          </div>
        )}
      </>
    );
  }
  const [activity, assets] = await Promise.all([
    client.get<List<ChiwoActivityItem>>('/v1/chiwo/activity'),
    client.get<List<{ code: string; exponent: number }>>('/v1/assets'),
  ]);
  return (
    <>
      <h1>{t('home.activity')}</h1>
      <p>
        <Link href="/pay">{t('nav.pay')}</Link>
      </p>
      {activity.data.length === 0 && <p className="muted">{t('home.empty')}</p>}
      {activity.data.length > 0 && (
        <div className="card">
          <table>
            <tbody>
              {activity.data.map((item) => (
                <tr key={`${item.kind}:${item.id}`}>
                  <td>
                    {item.kind === 'merchant_payment' ? (
                      <Link href={`/payments/${item.id}`}>{item.counterparty}</Link>
                    ) : (
                      <span title={item.counterparty}>{item.counterparty.slice(0, 24)}</span>
                    )}
                  </td>
                  <td className="muted">{t(`activity.kind.${item.kind}`)}</td>
                  <td>
                    {item.direction === 'in' ? '+' : '−'}
                    {item.currency}{' '}
                    {formatMinor(item.amount_minor, exponentOf(assets.data, item.currency))}
                  </td>
                  <td>
                    <span className="pill">
                      {item.kind === 'merchant_payment'
                        ? t(`payment.status.${item.status}`)
                        : item.status}
                    </span>
                  </td>
                  <td className="muted">{formatDate(item.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
