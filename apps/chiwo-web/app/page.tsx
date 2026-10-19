import { type ChiwoMe, type ChiwoMerchantPayment, formatMinor, type List } from '@aora/api-client';
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
    client.get<List<ChiwoMerchantPayment>>('/v1/chiwo/activity'),
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
              {activity.data.map((payment) => (
                <tr key={payment.id}>
                  <td>
                    <Link href={`/payments/${payment.id}`}>{payment.merchant.trading_name}</Link>
                  </td>
                  <td>
                    {payment.currency}{' '}
                    {formatMinor(payment.total_minor, exponentOf(assets.data, payment.currency))}
                  </td>
                  <td>
                    <span className="pill">{t(`payment.status.${payment.status}`)}</span>
                  </td>
                  <td className="muted">{formatDate(payment.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
