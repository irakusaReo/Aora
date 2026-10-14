import type { Branch, Invitation, List, Member } from '@aora/api-client';
import { redirect } from 'next/navigation';
import { api, field, messageOf } from '../../../../lib/api';

async function invite(form: FormData): Promise<void> {
  'use server';
  const workspaceId = field(form, 'workspace_id');
  const branch = field(form, 'branch_id');
  let target = `/w/${workspaceId}/team?ok=1`;
  try {
    await (
      await api(workspaceId)
    ).post('/v1/workspace/invitations', {
      email: field(form, 'email'),
      role: field(form, 'role'),
      ...(branch ? { branch_id: branch } : {}),
    });
  } catch (error) {
    target = `/w/${workspaceId}/team?error=${encodeURIComponent(messageOf(error))}`;
  }
  redirect(target);
}

async function revoke(form: FormData): Promise<void> {
  'use server';
  const workspaceId = field(form, 'workspace_id');
  let target = `/w/${workspaceId}/team`;
  try {
    await (await api(workspaceId)).delete(`/v1/workspace/invitations/${field(form, 'id')}`);
  } catch (error) {
    target = `/w/${workspaceId}/team?error=${encodeURIComponent(messageOf(error))}`;
  }
  redirect(target);
}

export default async function Team({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}): Promise<React.JSX.Element> {
  const { workspaceId } = await params;
  const query = await searchParams;
  const client = await api(workspaceId);
  const [members, invitations, branches] = await Promise.all([
    client.get<List<Member>>('/v1/workspace/members'),
    client.get<List<Invitation>>('/v1/workspace/invitations'),
    client.get<List<Branch>>('/v1/workspace/branches'),
  ]);
  const branchName = new Map(branches.data.map((branch) => [branch.id, branch.name]));
  return (
    <>
      <h1>Team</h1>
      {query['error'] && <p className="error">{query['error']}</p>}
      {query['ok'] && <p className="ok">Invitation sent.</p>}
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Phone</th>
              <th>Role</th>
              <th>Branch</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {members.data.map((member) => (
              <tr key={member.id}>
                <td>{member.display_name ?? ''}</td>
                <td>{member.email_masked}</td>
                <td>{member.phone_hint}</td>
                <td>{member.role}</td>
                <td>{member.branch_id ? (branchName.get(member.branch_id) ?? '') : ''}</td>
                <td>{member.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2>Invite someone</h2>
      <div className="card">
        <p className="muted">
          They sign in with this email address and accept. Inviting needs a recent PIN confirmation
          (Security page). Being an admin does not by itself allow payouts or other money movements.
        </p>
        <form action={invite} className="stack">
          <input type="hidden" name="workspace_id" value={workspaceId} />
          <label>
            Email address
            <input name="email" type="email" required maxLength={254} />
          </label>
          <label>
            Role
            <select name="role" defaultValue="cashier">
              <option value="cashier">Cashier: collects payments only</option>
              <option value="finance">Finance</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <label>
            Branch (cashiers)
            <select name="branch_id" defaultValue="">
              <option value="">No branch</option>
              {branches.data
                .filter((branch) => branch.status === 'active')
                .map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
            </select>
          </label>
          <button type="submit">Send invitation</button>
        </form>
      </div>
      <h2>Invitations</h2>
      <div className="card">
        <table>
          <tbody>
            {invitations.data.map((invitation) => (
              <tr key={invitation.id}>
                <td>{invitation.email}</td>
                <td>{invitation.role}</td>
                <td>
                  <span className="pill">{invitation.status}</span>
                </td>
                <td>
                  {invitation.status === 'pending' && (
                    <form action={revoke}>
                      <input type="hidden" name="workspace_id" value={workspaceId} />
                      <input type="hidden" name="id" value={invitation.id} />
                      <button type="submit" className="secondary">
                        Revoke
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
