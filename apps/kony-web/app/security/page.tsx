import { auth } from '@clerk/nextjs/server';
import { setPin, stepUp } from './actions';

const NOTICES: Record<string, string> = {
  pin: 'Your PIN is set.',
  step_up: 'Confirmed. For the next few minutes you can approve sensitive actions.',
};

export default async function Security({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}): Promise<React.JSX.Element> {
  const session = await auth();
  if (!session.userId) return session.redirectToSignIn();
  const params = await searchParams;
  return (
    <>
      <h1>Security</h1>
      {params['error'] && <p className="error">{params['error']}</p>}
      {params['ok'] && <p className="ok">{NOTICES[params['ok']]}</p>}
      <div className="card">
        <h2>Confirm with your PIN</h2>
        <p className="muted">
          Inviting staff, payouts and refunds need a recent PIN confirmation. It lasts a few
          minutes.
        </p>
        <form action={stepUp} className="stack">
          <label>
            PIN
            <input name="pin" type="password" inputMode="numeric" autoComplete="off" required />
          </label>
          <button type="submit">Confirm</button>
        </form>
      </div>
      <div className="card">
        <h2>Set or change your PIN</h2>
        <p className="muted">
          Six digits, not all the same and not a straight run. You must have signed in within the
          last ten minutes; if not, sign out and back in first.
        </p>
        <form action={setPin} className="stack">
          <label>
            New PIN
            <input name="pin" type="password" inputMode="numeric" autoComplete="off" required />
          </label>
          <button type="submit" className="secondary">
            Save PIN
          </button>
        </form>
      </div>
    </>
  );
}
