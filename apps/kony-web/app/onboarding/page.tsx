import type { Application, List, MyInvitation } from '@aora/api-client';
import { randomUUID } from 'node:crypto';
import { api } from '../../lib/api';
import { acceptInvitation, apply, savePhone } from './actions';

const REASONS: Record<string, string> = {
  business_already_onboarded:
    'This business already has a KONY workspace. Ask its admin to invite you by email.',
};

export default async function Onboarding({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const client = await api();
  const [applications, invitations] = await Promise.all([
    client.get<List<Application>>('/v1/onboarding/applications'),
    client.get<List<MyInvitation>>('/v1/me/invitations'),
  ]);
  return (
    <>
      <h1>Get started</h1>
      {params['error'] && <p className="error">{params['error']}</p>}
      {params['ok'] === 'phone' && <p className="ok">Phone number saved.</p>}

      {invitations.data.length > 0 && (
        <div className="card">
          <h2>Invitations for you</h2>
          {invitations.data.map((invitation) => (
            <form key={invitation.id} action={acceptInvitation} className="stack">
              <input type="hidden" name="id" value={invitation.id} />
              <p>
                Join <strong>{invitation.workspace_name}</strong> as {invitation.role}.
              </p>
              <button type="submit">Accept</button>
            </form>
          ))}
        </div>
      )}

      <div className="card">
        <h2>1. Your phone number</h2>
        <p className="muted">
          Your phone number is your payment identity on AORA. It is not used to sign in, and it is
          not verified at this step.
        </p>
        <form action={savePhone} className="stack">
          <label>
            Phone number, international format
            <input name="phone" placeholder="+254712345678" required inputMode="tel" />
          </label>
          <button type="submit">Save phone number</button>
        </form>
      </div>

      <div className="card">
        <h2>2. Your business</h2>
        <form action={apply} className="stack">
          <input type="hidden" name="idempotency_key" value={randomUUID()} />
          <label>
            Business name
            <input name="name" required maxLength={120} />
          </label>
          <label>
            Is the business registered?
            <select name="kind" defaultValue="unregistered">
              <option value="unregistered">No, it is not registered</option>
              <option value="registered">Yes, it has a registration number</option>
            </select>
          </label>
          <label>
            Registration number (registered businesses; sandbox identifier only)
            <input name="registration" maxLength={60} />
          </label>
          <p className="muted">For an unregistered business, where is it?</p>
          <label>
            County
            <input name="area" maxLength={80} />
          </label>
          <label>
            Town
            <input name="locality" maxLength={80} />
          </label>
          <label>
            Market, street or stall
            <input name="place" maxLength={120} />
          </label>
          <button type="submit">Register business</button>
        </form>
      </div>

      {applications.data.length > 0 && (
        <div className="card">
          <h2>Your applications</h2>
          <table>
            <thead>
              <tr>
                <th>Business</th>
                <th>Status</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {applications.data.map((application) => (
                <tr key={application.id}>
                  <td>{application.name}</td>
                  <td>
                    <span className="pill">{application.status.replace('_', ' ')}</span>
                  </td>
                  <td className="muted">
                    {application.status === 'needs_review'
                      ? 'This looks similar to a business we already have. Our team will check it.'
                      : application.decision_reason
                        ? (REASONS[application.decision_reason] ?? application.decision_reason)
                        : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
