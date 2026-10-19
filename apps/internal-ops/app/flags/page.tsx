import type { FeatureFlag, List } from '@aora/api-client';
import { redirect } from 'next/navigation';
import { api, field, messageOf } from '../../lib/api';

/** What each flag switches, in words an operator can check before acting. */
const DESCRIPTIONS: Record<string, string> = {
  kelo_credit:
    'KELO credit: Pay in N and monthly financing plans, decisions and agreements. Off: every credit route answers "not found" and no screen mentions credit. Layaway is unaffected. SANDBOX: the lender of record is simulated, not licensed.',
};

/** The switch needs the operator's PIN (a step-up) and a reason; both are checked by the API. */
async function setFlag(form: FormData): Promise<void> {
  'use server';
  let target = '/flags?ok=1';
  try {
    const client = await api();
    await client.post('/v1/auth/step-up', { pin: field(form, 'pin') });
    await client.post(`/v1/ops/feature-flags/${encodeURIComponent(field(form, 'key'))}`, {
      enabled: field(form, 'enabled') === 'true',
      reason: field(form, 'reason'),
    });
  } catch (error) {
    target = `/flags?error=${encodeURIComponent(messageOf(error))}`;
  }
  redirect(target);
}

export default async function FlagsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}): Promise<React.JSX.Element> {
  const query = await searchParams;
  const flags = await (await api()).get<List<FeatureFlag>>('/v1/ops/feature-flags');
  return (
    <>
      <h1>Feature flags</h1>
      <p className="muted">
        Each switch takes effect at once on every instance and is recorded in the audit trail with
        its reason.
      </p>
      {query['ok'] && <p className="ok">Saved.</p>}
      {query['error'] && <p className="error">{query['error']}</p>}
      {flags.data.map((flag) => (
        <div className="card" key={flag.key}>
          <p>
            <strong>{flag.key}</strong> <span className="pill">{flag.enabled ? 'on' : 'off'}</span>
          </p>
          <p>{DESCRIPTIONS[flag.key] ?? ''}</p>
          <p className="muted">
            Last changed {new Date(flag.changed_at).toISOString()}
            {flag.reason ? `: ${flag.reason}` : ''}
          </p>
          <form action={setFlag} className="stack">
            <input type="hidden" name="key" value={flag.key} />
            <input type="hidden" name="enabled" value={flag.enabled ? 'false' : 'true'} />
            <label>
              Reason
              <input name="reason" required minLength={3} maxLength={300} />
            </label>
            <label>
              Your PIN
              <input
                name="pin"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                required
                pattern="[0-9]{6}"
              />
            </label>
            <button type="submit" className={flag.enabled ? 'secondary' : undefined}>
              {flag.enabled ? `Switch ${flag.key} off` : `Switch ${flag.key} on`}
            </button>
          </form>
        </div>
      ))}
    </>
  );
}
