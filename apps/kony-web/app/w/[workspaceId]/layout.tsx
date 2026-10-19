import type { Me, Workspace } from '@aora/api-client';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { api } from '../../../lib/api';

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string }>;
}): Promise<React.JSX.Element> {
  const { workspaceId } = await params;
  const me = await (await api()).get<Me>('/v1/me');
  const membership = me.memberships.find((entry) => entry.workspace_id === workspaceId);
  if (!membership) notFound();
  const workspace = await (await api(workspaceId)).get<Workspace>('/v1/workspace');
  const base = `/w/${workspaceId}`;
  return (
    <>
      {!me.phone_set && (
        <div className="card">
          <strong>Add your phone number.</strong> It is your payment identity on AORA.{' '}
          <Link href="/onboarding">Add it now</Link>
        </div>
      )}
      <div className="card">
        <strong>{workspace.name}</strong> <span className="pill">{workspace.kind}</span>{' '}
        <span className="pill">{workspace.tier}</span>{' '}
        <span className="pill">you: {membership.role}</span>
        {workspace.restrictions.map((restriction) => (
          <span key={restriction} className="pill">
            {restriction === 'payouts_suspended' ? 'payouts suspended' : 'listing suspended'}
          </span>
        ))}
        <nav style={{ display: 'flex', gap: 16, marginTop: 8 }}>
          <Link href={base}>Collections</Link>
          <Link href={`${base}/branches`}>Branches</Link>
          <Link href={`${base}/pay-codes`}>Pay codes</Link>
          <Link href={`${base}/kelo`}>KELO</Link>
          {membership.role !== 'cashier' && <Link href={`${base}/money`}>Money</Link>}
          {membership.role !== 'cashier' && <Link href={`${base}/treasury`}>USDC treasury</Link>}
          {membership.role !== 'cashier' && <Link href={`${base}/nam`}>NAM Vault</Link>}
          {membership.role !== 'cashier' && <Link href={`${base}/team`}>Team</Link>}
          {membership.role === 'admin' && <Link href={`${base}/developers`}>Developers</Link>}
        </nav>
      </div>
      {children}
    </>
  );
}
