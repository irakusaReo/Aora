import { redirect } from 'next/navigation';
import { api, back, field } from '../../lib/api';
import { t } from '../../lib/messages';

async function setPin(form: FormData): Promise<void> {
  'use server';
  let target = '/security?ok=pin';
  try {
    await (await api()).put('/v1/auth/pin', { pin: field(form, 'pin') });
  } catch (error) {
    target = back('/security', error, t('error.generic'));
  }
  redirect(target);
}

async function stepUp(form: FormData): Promise<void> {
  'use server';
  let target = '/security?ok=step_up';
  try {
    await (await api()).post('/v1/auth/step-up', { pin: field(form, 'pin') });
  } catch (error) {
    target = back('/security', error, t('error.generic'));
  }
  redirect(target);
}

export default async function Security({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}): Promise<React.JSX.Element> {
  await api(); // signed in, or sent to sign in
  const query = await searchParams;
  return (
    <>
      <h1>{t('security.title')}</h1>
      {query['error'] && <p className="error">{query['error']}</p>}
      {query['ok'] === 'pin' && <p className="ok">{t('security.ok_pin')}</p>}
      {query['ok'] === 'step_up' && <p className="ok">{t('security.ok_step_up')}</p>}
      <div className="card">
        <h2>{t('security.confirm_title')}</h2>
        <p className="muted">{t('security.confirm_help')}</p>
        <form action={stepUp} className="stack">
          <label>
            {t('security.pin')}
            <input name="pin" type="password" inputMode="numeric" autoComplete="off" required />
          </label>
          <button type="submit">{t('security.confirm')}</button>
        </form>
      </div>
      <div className="card">
        <h2>{t('security.set_title')}</h2>
        <p className="muted">{t('security.set_help')}</p>
        <form action={setPin} className="stack">
          <label>
            {t('security.pin')}
            <input name="pin" type="password" inputMode="numeric" autoComplete="off" required />
          </label>
          <button type="submit" className="secondary">
            {t('security.save')}
          </button>
        </form>
      </div>
    </>
  );
}
