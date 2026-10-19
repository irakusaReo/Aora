import { type ChiwoUsdc, formatMinor, toMinorUnits } from '@aora/api-client';
import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { api, back, field } from '../../lib/api';
import { t } from '../../lib/messages';

async function challenge(): Promise<void> {
  'use server';
  let target: string;
  try {
    const created = await (
      await api()
    ).post<{ id: string; message: string }>('/v1/chiwo/usdc/address-challenges');
    target = `/usdc?challenge_id=${created.id}&challenge=${encodeURIComponent(created.message)}`;
  } catch (error) {
    target = back('/usdc', error, t('error.generic'));
  }
  redirect(target);
}

async function register(form: FormData): Promise<void> {
  'use server';
  let target = '/usdc';
  try {
    await (
      await api()
    ).post('/v1/chiwo/usdc/addresses', {
      challenge_id: field(form, 'challenge_id'),
      address: field(form, 'address'),
      signature: field(form, 'signature'),
    });
  } catch (error) {
    target = back('/usdc', error, t('error.generic'));
  }
  redirect(target);
}

async function withdraw(form: FormData): Promise<void> {
  'use server';
  const amount = toMinorUnits(field(form, 'amount'), Number(field(form, 'decimals')));
  let target = '/usdc?ok=withdraw';
  try {
    if (!amount) throw new Error('amount');
    await (
      await api()
    ).post(
      '/v1/chiwo/usdc/withdrawals',
      { amount_minor: amount, address_id: field(form, 'address_id') },
      field(form, 'key'),
    );
  } catch (error) {
    target = back('/usdc', error, t('error.generic'));
  }
  redirect(target);
}

export default async function Usdc({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}): Promise<React.JSX.Element> {
  const query = await searchParams;
  const usdc = await (await api()).get<ChiwoUsdc>('/v1/chiwo/usdc');
  const money = (minor: string): string =>
    `${usdc.asset.code} ${formatMinor(minor, usdc.asset.decimals)}`;
  return (
    <>
      <h1>{t('usdc.title')}</h1>
      {query['error'] && <p className="error">{query['error']}</p>}
      {query['ok'] === 'withdraw' && <p className="ok">{t('usdc.withdraw_started')}</p>}
      <p className="muted">{t('usdc.explain')}</p>
      <div className="card">
        <p>
          <strong>{t('usdc.available', { amount: money(usdc.balances.available_minor) })}</strong>
        </p>
        <p className="muted">
          {t('usdc.in_flight', { amount: money(usdc.balances.withdrawals_in_flight_minor) })}
        </p>
        <p className="muted">
          {usdc.network.label} · {usdc.asset.contract}
        </p>
      </div>
      {!usdc.deposit_address && <p className="muted">{t('usdc.chain_off')}</p>}
      {usdc.deposit_address && (
        <>
          <div className="card">
            <h2>{t('usdc.receive_title')}</h2>
            <p className="muted">{t('usdc.receive_help')}</p>
            <p>
              <code>{t('usdc.wallet', { address: usdc.deposit_address })}</code>
            </p>
            {usdc.addresses.length > 0 && (
              <>
                <h3>{t('usdc.addresses')}</h3>
                <ul>
                  {usdc.addresses.map((address) => (
                    <li key={address.id}>
                      <code>{address.address}</code>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {query['challenge_id'] && query['challenge'] ? (
              <form action={register} className="stack">
                <input type="hidden" name="challenge_id" value={query['challenge_id']} />
                <p className="muted">{t('usdc.sign_help')}</p>
                <pre style={{ whiteSpace: 'pre-wrap' }}>{query['challenge']}</pre>
                <label>
                  {t('usdc.address')}
                  <input name="address" required pattern="^0x[0-9a-fA-F]{40}$" />
                </label>
                <label>
                  {t('usdc.signature')}
                  <input name="signature" required pattern="^0x[0-9a-fA-F]+$" />
                </label>
                <button type="submit">{t('usdc.save_address')}</button>
              </form>
            ) : (
              <form action={challenge}>
                <button type="submit" className="secondary">
                  {t('usdc.register')}
                </button>
              </form>
            )}
          </div>
          {usdc.addresses.length > 0 && (
            <div className="card">
              <h2>{t('usdc.withdraw_title')}</h2>
              <p className="muted">{t('usdc.withdraw_help')}</p>
              <form action={withdraw} className="stack">
                <input type="hidden" name="key" value={randomUUID()} />
                <input type="hidden" name="decimals" value={usdc.asset.decimals} />
                <label>
                  {t('usdc.address')}
                  <select name="address_id" required>
                    {usdc.addresses.map((address) => (
                      <option key={address.id} value={address.id}>
                        {address.address}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t('usdc.amount')}
                  <input name="amount" required inputMode="decimal" placeholder="10.00" />
                </label>
                <button type="submit">{t('usdc.withdraw')}</button>
              </form>
            </div>
          )}
        </>
      )}
    </>
  );
}
