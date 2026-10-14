import { api, messageOf } from '../../lib/api';

interface Account {
  id: string;
  status: string;
  display_name: string | null;
  email_masked: string;
  phone_hint: string;
  memberships: { workspace_id: string; role: string; status: string }[];
}
interface WorkspaceRow {
  id: string;
  business_name: string;
  kind: string;
  tier: string;
  active_members: number;
}

export default async function Lookup({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}): Promise<React.JSX.Element> {
  const query = await searchParams;
  const client = await api();
  let accounts: Account[] | null = null;
  let workspaces: WorkspaceRow[] | null = null;
  let error: string | null = null;
  try {
    const by = query['by'];
    const term = query['q']?.trim();
    if (term && (by === 'email' || by === 'phone' || by === 'id')) {
      accounts = (await client.get<{ data: Account[] }>('/v1/ops/accounts', { [by]: term })).data;
    } else if (term && by === 'workspace') {
      workspaces = (
        await client.get<{ data: WorkspaceRow[] }>('/v1/ops/workspaces', { name: term })
      ).data;
    }
  } catch (caught) {
    error = messageOf(caught);
  }
  return (
    <>
      <h1>Lookup</h1>
      <p className="muted">
        Looking up a person is recorded in the audit trail. Contact details are masked.
      </p>
      <form className="stack" method="get">
        <label>
          Search by
          <select name="by" defaultValue={query['by'] ?? 'email'}>
            <option value="email">User email</option>
            <option value="phone">User phone (+254…)</option>
            <option value="id">User id</option>
            <option value="workspace">Business name</option>
          </select>
        </label>
        <label>
          Search for
          <input name="q" defaultValue={query['q'] ?? ''} required />
        </label>
        <button type="submit">Search</button>
      </form>
      {error && <p className="error">{error}</p>}
      {accounts && (
        <div className="card">
          {accounts.length === 0 && <p className="muted">No account found.</p>}
          {accounts.map((account) => (
            <div key={account.id}>
              <p>
                <strong>{account.display_name ?? '(no name)'}</strong> <code>{account.id}</code>{' '}
                <span className="pill">{account.status}</span>
              </p>
              <p className="muted">
                {account.email_masked} · phone {account.phone_hint || '(none)'}
              </p>
              <ul>
                {account.memberships.map((membership) => (
                  <li key={membership.workspace_id}>
                    {membership.workspace_id}: {membership.role} ({membership.status})
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      {workspaces && (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Business</th>
                <th>Kind</th>
                <th>Tier</th>
                <th className="num">Active members</th>
                <th>Workspace id</th>
              </tr>
            </thead>
            <tbody>
              {workspaces.map((row) => (
                <tr key={row.id}>
                  <td>{row.business_name}</td>
                  <td>{row.kind}</td>
                  <td>{row.tier}</td>
                  <td className="num">{row.active_members}</td>
                  <td>
                    <code>{row.id}</code>
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
