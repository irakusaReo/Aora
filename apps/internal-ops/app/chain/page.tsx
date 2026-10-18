import { redirect } from 'next/navigation';
import { api, field, messageOf } from '../../lib/api';

interface OpsTransfer {
  id: string;
  tx_hash: string;
  token_address: string;
  from_address: string;
  amount: string;
  asset_code: string | null;
  status: string;
  workspace_id: string | null;
  observed_at: string;
}

async function attribute(form: FormData): Promise<void> {
  'use server';
  let target = '/chain?ok=1';
  try {
    const workspace = field(form, 'workspace_id');
    await (
      await api()
    ).post(`/v1/ops/chain/transfers/${field(form, 'id')}/attribution`, {
      reason: field(form, 'reason'),
      ...(workspace ? { workspace_id: workspace } : {}),
    });
  } catch (error) {
    target = `/chain?error=${encodeURIComponent(messageOf(error))}`;
  }
  redirect(target);
}

/** Base Sepolia transfers that need an operator (phase 5C). SANDBOX: testnet only. */
export default async function Chain({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}): Promise<React.JSX.Element> {
  const query = await searchParams;
  const { data } = await (await api()).get<{ data: OpsTransfer[] }>('/v1/ops/chain/transfers');
  return (
    <>
      <h1>Base Sepolia transfers to review</h1>
      <p className="muted">
        SANDBOX — testnet only. Unattributed USDC came from an address no workspace had registered;
        attribute it to a workspace, or to AORA&apos;s own sandbox funding (faucet USDC). Other
        tokens are never credited. Every attribution is audited with its reason.
      </p>
      {query['error'] && <p className="error">{query['error']}</p>}
      {query['ok'] && <p className="ok">Done.</p>}
      {data.length === 0 ? (
        <p className="muted">Nothing to review.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Observed</th>
              <th>From</th>
              <th>Amount (base units)</th>
              <th>Status</th>
              <th>Transaction</th>
              <th>Attribute</th>
            </tr>
          </thead>
          <tbody>
            {data.map((row) => (
              <tr key={row.id}>
                <td>{new Date(row.observed_at).toLocaleString()}</td>
                <td>
                  <code>{row.from_address}</code>
                </td>
                <td>
                  {row.amount} {row.asset_code ?? `(token ${row.token_address})`}
                </td>
                <td>{row.status}</td>
                <td>
                  <a
                    href={`https://sepolia.basescan.org/tx/${row.tx_hash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {row.tx_hash.slice(0, 12)}…
                  </a>
                </td>
                <td>
                  {row.status === 'unattributed' && (
                    <form action={attribute} className="stack">
                      <input type="hidden" name="id" value={row.id} />
                      <input name="workspace_id" placeholder="Workspace id (empty: AORA funding)" />
                      <input name="reason" required minLength={3} placeholder="Reason" />
                      <button type="submit">Attribute</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
