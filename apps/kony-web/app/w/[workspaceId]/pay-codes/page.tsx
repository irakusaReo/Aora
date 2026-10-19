import type { Branch, List, Me, PayCode } from '@aora/api-client';
import { redirect } from 'next/navigation';
import { api, field, messageOf } from '../../../../lib/api';

async function create(form: FormData): Promise<void> {
  'use server';
  const workspaceId = field(form, 'workspace_id');
  const branchId = field(form, 'branch_id');
  let target = `/w/${workspaceId}/pay-codes`;
  try {
    await (await api(workspaceId)).post('/v1/pay-codes', branchId ? { branch_id: branchId } : {});
  } catch (error) {
    target = `/w/${workspaceId}/pay-codes?error=${encodeURIComponent(messageOf(error))}`;
  }
  redirect(target);
}

async function deactivate(form: FormData): Promise<void> {
  'use server';
  const workspaceId = field(form, 'workspace_id');
  let target = `/w/${workspaceId}/pay-codes`;
  try {
    await (await api(workspaceId)).post(`/v1/pay-codes/${field(form, 'code')}/deactivate`);
  } catch (error) {
    target = `/w/${workspaceId}/pay-codes?error=${encodeURIComponent(messageOf(error))}`;
  }
  redirect(target);
}

export default async function PayCodes({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}): Promise<React.JSX.Element> {
  const { workspaceId } = await params;
  const query = await searchParams;
  const client = await api(workspaceId);
  const [me, codes, branches] = await Promise.all([
    client.get<Me>('/v1/me'),
    client.get<List<PayCode>>('/v1/pay-codes'),
    client.get<List<Branch>>('/v1/workspace/branches'),
  ]);
  const isAdmin =
    me.memberships.find((entry) => entry.workspace_id === workspaceId)?.role === 'admin';
  const branchName = (id: string | null): string =>
    id
      ? (branches.data.find((branch) => branch.id === id)?.name ?? 'Unknown branch')
      : 'Whole business';
  return (
    <>
      <h1>Pay codes</h1>
      <p className="muted">
        A CHIWO customer types a pay code to pay you by M-Pesa. They see only your business name.
        Each payment appears under Collections with its fee and net. Sandbox: no real money moves.
      </p>
      {query['error'] && <p className="error">{query['error']}</p>}
      <div className="card">
        {codes.data.length === 0 ? (
          <p className="muted">No pay codes yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>For</th>
                <th>Status</th>
                {isAdmin && <th />}
              </tr>
            </thead>
            <tbody>
              {codes.data.map((code) => (
                <tr key={code.code}>
                  <td>
                    <code style={{ fontSize: '1.2em', letterSpacing: '0.1em' }}>{code.code}</code>
                  </td>
                  <td>{branchName(code.branch_id)}</td>
                  <td>
                    <span className="pill">{code.status}</span>
                  </td>
                  {isAdmin && (
                    <td>
                      {code.status === 'active' && (
                        <form action={deactivate}>
                          <input type="hidden" name="workspace_id" value={workspaceId} />
                          <input type="hidden" name="code" value={code.code} />
                          <button type="submit" className="secondary">
                            Stop using
                          </button>
                        </form>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {isAdmin && (
        <div className="card">
          <form action={create} className="stack">
            <input type="hidden" name="workspace_id" value={workspaceId} />
            <label>
              Collect into
              <select name="branch_id" defaultValue="">
                <option value="">Whole business</option>
                {branches.data
                  .filter((branch) => branch.status === 'active')
                  .map((branch) => (
                    <option key={branch.id} value={branch.id}>
                      {branch.name}
                    </option>
                  ))}
              </select>
            </label>
            <button type="submit">Create a pay code</button>
          </form>
        </div>
      )}
    </>
  );
}
