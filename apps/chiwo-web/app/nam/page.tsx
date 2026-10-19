import {
  formatMinor,
  type List,
  type NamOrder,
  type NamOverview,
  type NamRedemption,
  toMinorUnits,
} from '@aora/api-client';
import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { api, back, field, messageOf } from '../../lib/api';
import { formatDate, t } from '../../lib/messages';

const USDC_DECIMALS = 6;

async function placeOrder(form: FormData): Promise<void> {
  'use server';
  if (form.get('accept') !== 'yes')
    redirect(`/nam?error=${encodeURIComponent(t('nam.accept_first'))}`);
  const minor = toMinorUnits(field(form, 'amount'), USDC_DECIMALS);
  if (!minor) redirect(`/nam?error=${encodeURIComponent(t('pay.bad_amount'))}`);
  let target = '/nam?ok=order';
  try {
    await (
      await api()
    ).post(
      '/v1/chiwo/nam/orders',
      { amount_minor: minor, disclosure_version: field(form, 'disclosure_version') },
      field(form, 'key'),
    );
  } catch (error) {
    target = back('/nam', error, t('error.generic'));
  }
  redirect(target);
}

async function redeem(form: FormData): Promise<void> {
  'use server';
  const shares = field(form, 'shares');
  let target = '/nam?ok=redemption';
  try {
    await (
      await api()
    ).post('/v1/chiwo/nam/redemptions', shares ? { shares } : { all: true }, field(form, 'key'));
  } catch (error) {
    target = back('/nam', error, t('error.generic'));
  }
  redirect(target);
}

/** NAM Vault inside CHIWO: personal, never a workspace's. SANDBOX: no return is offered. */
export default async function Nam({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}): Promise<React.JSX.Element> {
  const query = await searchParams;
  const client = await api();
  let nam: NamOverview;
  try {
    nam = await client.get<NamOverview>('/v1/chiwo/nam');
  } catch (error) {
    return (
      <>
        <h1>{t('nam.title')}</h1>
        <p className="error">{messageOf(error, t('error.generic'))}</p>
      </>
    );
  }
  const [orders, redemptions] = await Promise.all([
    client.get<List<NamOrder>>('/v1/chiwo/nam/orders'),
    client.get<List<NamRedemption>>('/v1/chiwo/nam/redemptions'),
  ]);
  const usdc = (minor: string): string => `USDC ${formatMinor(minor, USDC_DECIMALS)}`;
  return (
    <>
      <h1>{nam.product.name}</h1>
      <p className="muted">{nam.note}</p>
      {query['error'] && <p className="error">{query['error']}</p>}
      {query['ok'] === 'order' && <p className="ok">{t('nam.ok_order')}</p>}
      {query['ok'] === 'redemption' && <p className="ok">{t('nam.ok_redemption')}</p>}
      <div className="card">
        <h2>{t('nam.position')}</h2>
        <p className="muted">{t('nam.position_help')}</p>
        <dl>
          <dt>{t('nam.funding')}</dt>
          <dd>{usdc(nam.funding_pending_minor)}</dd>
          <dt>{t('nam.shares')}</dt>
          <dd>{nam.holding.shares}</dd>
          <dt>{t('nam.value_now')}</dt>
          <dd>{usdc(nam.holding.current_value_minor)}</dd>
          <dt>{t('nam.cost')}</dt>
          <dd>{usdc(nam.holding.cost_minor)}</dd>
        </dl>
      </div>
      <div className="card">
        <h2>{t('nam.about')}</h2>
        <dl>
          <dt>{t('nam.control')}</dt>
          <dd>{nam.product.asset_control}</dd>
          <dt>{t('nam.owns')}</dt>
          <dd>{nam.product.customer_owns}</dd>
          <dt>{t('nam.fees')}</dt>
          <dd>{nam.product.fee_bps === 0 ? t('nam.fees_none') : String(nam.product.fee_bps)}</dd>
          <dt>{t('nam.withdrawals')}</dt>
          <dd>{nam.product.withdrawal_terms}</dd>
          <dt>{t('nam.contract')}</dt>
          <dd>
            <code>{nam.product.vault_address}</code> · {nam.product.network}
          </dd>
        </dl>
      </div>
      <div className="card">
        <h2>{t('nam.add')}</h2>
        <h3>{nam.disclosure.title}</h3>
        <pre style={{ whiteSpace: 'pre-wrap' }}>{nam.disclosure.body}</pre>
        <form action={placeOrder} className="stack">
          <input type="hidden" name="key" value={randomUUID()} />
          <input type="hidden" name="disclosure_version" value={nam.disclosure.version} />
          <label>
            {t('usdc.amount')}
            <input name="amount" required inputMode="decimal" />
          </label>
          <label>
            <input type="checkbox" name="accept" value="yes" required />{' '}
            {t('nam.accept', { version: nam.disclosure.version })}
          </label>
          <button type="submit">{t('nam.order')}</button>
        </form>
      </div>
      <div className="card">
        <h2>{t('nam.redeem_title')}</h2>
        <form action={redeem} className="stack">
          <input type="hidden" name="key" value={randomUUID()} />
          <label>
            {t('nam.redeem_shares')}
            <input name="shares" pattern="^[1-9][0-9]*$" />
          </label>
          <button type="submit" className="secondary">
            {t('nam.redeem')}
          </button>
        </form>
      </div>
      <div className="card">
        <h2>{t('nam.history')}</h2>
        <table>
          <tbody>
            {orders.data.map((row) => (
              <tr key={row.id}>
                <td>{t('nam.order_row')}</td>
                <td>{usdc(row.amount_minor)}</td>
                <td>
                  <span className="pill">{row.status}</span>
                </td>
                <td className="muted">{formatDate(row.created_at)}</td>
              </tr>
            ))}
            {redemptions.data.map((row) => (
              <tr key={row.id}>
                <td>{t('nam.redemption_row')}</td>
                <td>{row.assets_minor ? usdc(row.assets_minor) : `${row.shares} shares`}</td>
                <td>
                  <span className="pill">{row.status}</span>
                </td>
                <td className="muted">{formatDate(row.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
