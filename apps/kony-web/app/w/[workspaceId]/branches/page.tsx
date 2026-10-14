import type { Branch, List, Me } from '@aora/api-client';
import { redirect } from 'next/navigation';
import { api, field, messageOf } from '../../../../lib/api';

async function addBranch(form: FormData): Promise<void> {
  'use server';
  const workspaceId = field(form, 'workspace_id');
  let target = `/w/${workspaceId}/branches?ok=1`;
  try {
    await (await api(workspaceId)).post('/v1/workspace/branches', { name: field(form, 'name') });
  } catch (error) {
    target = `/w/${workspaceId}/branches?error=${encodeURIComponent(messageOf(error))}`;
  }
  redirect(target);
}

async function setStatus(form: FormData): Promise<void> {
  'use server';
  const workspaceId = field(form, 'workspace_id');
  let target = `/w/${workspaceId}/branches`;
  try {
    await (
      await api(workspaceId)
    ).patch(`/v1/workspace/branches/${field(form, 'id')}`, {
      status: field(form, 'status'),
    });
  } catch (error) {
    target = `/w/${workspaceId}/branches?error=${encodeURIComponent(messageOf(error))}`;
  }
  redirect(target);
}

export default async function Branches({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}): Promise<React.JSX.Element> {
  const { workspaceId } = await params;
  const query = await searchParams;
  const client = await api(workspaceId);
  const [me, branches] = await Promise.all([
    client.get<Me>('/v1/me'),
    client.get<List<Branch>>('/v1/workspace/branches'),
  ]);
  const isAdmin =
    me.memberships.find((entry) => entry.workspace_id === workspaceId)?.role === 'admin';
  return (
    <>
      <h1>Branches</h1>
      {query['error'] && <p className="error">{query['error']}</p>}
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              {isAdmin && <th />}
            </tr>
          </thead>
          <tbody>
            {branches.data.map((branch) => (
              <tr key={branch.id}>
                <td>{branch.name}</td>
                <td>
                  <span className="pill">{branch.status}</span>
                </td>
                {isAdmin && (
                  <td>
                    <form action={setStatus}>
                      <input type="hidden" name="workspace_id" value={workspaceId} />
                      <input type="hidden" name="id" value={branch.id} />
                      <input
                        type="hidden"
                        name="status"
                        value={branch.status === 'active' ? 'closed' : 'active'}
                      />
                      <button type="submit" className="secondary">
                        {branch.status === 'active' ? 'Close' : 'Reopen'}
                      </button>
                    </form>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {isAdmin && (
        <div className="card">
          <form action={addBranch} className="stack">
            <input type="hidden" name="workspace_id" value={workspaceId} />
            <label>
              New branch name
              <input name="name" required maxLength={80} />
            </label>
            <button type="submit">Add branch</button>
          </form>
        </div>
      )}
    </>
  );
}
