import { auth } from '@clerk/nextjs/server';
import type { Me, MyInvitation, List } from '@aora/api-client';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { api } from '../lib/api';

export default async function Home(): Promise<React.JSX.Element> {
  const { userId } = await auth();
  if (!userId) {
    return (
      <div className="card">
        <h1>KONY merchant workspace</h1>
        <p>Collect payments, see gross, fee and net on every sale, and manage your team.</p>
        <p className="muted">This is a sandbox. Sign in with your email address to continue.</p>
      </div>
    );
  }
  const client = await api();
  const me = await client.get<Me>('/v1/me');
  const invitations = await client.get<List<MyInvitation>>('/v1/me/invitations');
  if (me.memberships.length === 1 && invitations.data.length === 0) {
    redirect(`/w/${me.memberships[0]?.workspace_id ?? ''}`);
  }
  return (
    <>
      <h1>Your workspaces</h1>
      {me.memberships.length === 0 ? (
        <div className="card">
          <p>You are not part of a workspace yet.</p>
          <p>
            <Link href="/onboarding">Register your business</Link>, or accept an invitation below.
          </p>
        </div>
      ) : (
        <div className="card">
          <ul>
            {me.memberships.map((membership) => (
              <li key={membership.workspace_id}>
                <Link href={`/w/${membership.workspace_id}`}>{membership.workspace_id}</Link>{' '}
                <span className="pill">{membership.role}</span>
              </li>
            ))}
          </ul>
          <p>
            <Link href="/onboarding">Register another business</Link>
          </p>
        </div>
      )}
      {invitations.data.length > 0 && (
        <>
          <h2>Invitations</h2>
          <div className="card">
            <ul>
              {invitations.data.map((invitation) => (
                <li key={invitation.id}>
                  {invitation.workspace_name} as {invitation.role}{' '}
                  <Link href={`/onboarding?invitation=${invitation.id}`}>Review</Link>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </>
  );
}
