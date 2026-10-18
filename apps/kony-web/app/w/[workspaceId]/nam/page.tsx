import {
  formatMinor,
  type List,
  type NamOrder,
  type NamOverview,
  type NamRedemption,
} from '@aora/api-client';
import { randomUUID } from 'node:crypto';
import { api, messageOf } from '../../../../lib/api';
import { placeOrder, redeem } from './actions';

const OK: Record<string, string> = {
  order:
    'Order placed. The amount is set aside now; your holding appears once the vault deposit is confirmed on chain.',
  redemption:
    'Redemption requested. The USDC returns to your treasury once it is confirmed on chain.',
};

export default async function NamPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}): Promise<React.JSX.Element> {
  const { workspaceId } = await params;
  const query = await searchParams;
  const client = await api(workspaceId);
  let nam: NamOverview;
  try {
    nam = await client.get<NamOverview>('/v1/nam');
  } catch (error) {
    return (
      <>
        <h1>NAM Vault</h1>
        <p className="error">{messageOf(error)}</p>
      </>
    );
  }
  const [orders, redemptions] = await Promise.all([
    client.get<List<NamOrder>>('/v1/nam/orders'),
    client.get<List<NamRedemption>>('/v1/nam/redemptions'),
  ]);
  const usdc = (minor: string): string => `${formatMinor(minor, 6)} USDC`;

  return (
    <>
      <h1>{nam.product.name}</h1>
      <p className="muted">{nam.note}</p>
      {query['error'] && <p className="error">{query['error']}</p>}
      {query['ok'] && OK[query['ok']] && <p className="ok">{OK[query['ok']]}</p>}

      <section>
        <h2>Your position</h2>
        <p className="muted">
          Three separate things: money set aside, orders on chain, and what you hold.
        </p>
        <dl>
          <dt>Funding set aside (not yet in the vault)</dt>
          <dd>{usdc(nam.funding_pending_minor)}</dd>
          <dt>Vault shares held for your workspace</dt>
          <dd>{nam.holding.shares}</dd>
          <dt>What the vault would return for them now</dt>
          <dd>{usdc(nam.holding.current_value_minor)}</dd>
          <dt>Amount you put in, still held</dt>
          <dd>{usdc(nam.holding.cost_minor)}</dd>
        </dl>
      </section>

      <section>
        <h2>About this product</h2>
        <dl>
          <dt>Who controls the assets</dt>
          <dd>{nam.product.asset_control}</dd>
          <dt>What your workspace owns</dt>
          <dd>{nam.product.customer_owns}</dd>
          <dt>Fees</dt>
          <dd>
            {nam.product.fee_bps === 0 ? 'None' : `${String(nam.product.fee_bps)} basis points`}
          </dd>
          <dt>Withdrawals</dt>
          <dd>{nam.product.withdrawal_terms}</dd>
          <dt>Vault contract</dt>
          <dd>
            <code>{nam.product.vault_address}</code> on {nam.product.network}
          </dd>
        </dl>
      </section>

      <section>
        <h2>Add USDC from your treasury</h2>
        <h3>{nam.disclosure.title}</h3>
        <pre style={{ whiteSpace: 'pre-wrap' }}>{nam.disclosure.body}</pre>
        <form action={placeOrder} className="stack">
          <input type="hidden" name="workspace_id" value={workspaceId} />
          <input type="hidden" name="idempotency_key" value={randomUUID()} />
          <input type="hidden" name="disclosure_version" value={nam.disclosure.version} />
          <label>
            Amount (USDC)
            <input name="amount" required inputMode="decimal" />
          </label>
          <label>
            <input type="checkbox" name="accept" value="yes" required /> I have read this disclosure
            (version {nam.disclosure.version}) on behalf of the business.
          </label>
          <button type="submit">Place order</button>
        </form>
      </section>

      <section>
        <h2>Redeem to your treasury</h2>
        <form action={redeem} className="stack">
          <input type="hidden" name="workspace_id" value={workspaceId} />
          <input type="hidden" name="idempotency_key" value={randomUUID()} />
          <label>
            Shares to redeem (leave empty for all)
            <input name="shares" pattern="^[1-9][0-9]*$" />
          </label>
          <button type="submit">Redeem</button>
        </form>
      </section>

      <section>
        <h2>Orders</h2>
        {orders.data.length === 0 ? (
          <p className="muted">No orders yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Placed</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Shares</th>
              </tr>
            </thead>
            <tbody>
              {orders.data.map((row) => (
                <tr key={row.id}>
                  <td>{new Date(row.created_at).toLocaleString()}</td>
                  <td>{usdc(row.amount_minor)}</td>
                  <td>{row.status}</td>
                  <td>{row.shares ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <h2>Redemptions</h2>
        {redemptions.data.length === 0 ? (
          <p className="muted">No redemptions yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Requested</th>
                <th>Shares</th>
                <th>Status</th>
                <th>USDC returned</th>
              </tr>
            </thead>
            <tbody>
              {redemptions.data.map((row) => (
                <tr key={row.id}>
                  <td>{new Date(row.created_at).toLocaleString()}</td>
                  <td>{row.shares}</td>
                  <td>{row.status}</td>
                  <td>{row.assets_minor === null ? '—' : usdc(row.assets_minor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
