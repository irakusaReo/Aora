import {
  type Branch,
  formatMinor,
  type List,
  type Me,
  type PaymentIntent,
  type Quote,
} from '@aora/api-client';
import { randomUUID } from 'node:crypto';
import { api, exponentOf, messageOf } from '../../../lib/api';
import { collect, preview } from './actions';

const CURRENCY = 'KES';
const SCENARIOS = [
  'success',
  'decline',
  'timeout_then_success',
  'timeout_then_failure',
  'late_webhook',
];

export default async function Collections({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}): Promise<React.JSX.Element> {
  const { workspaceId } = await params;
  const query = await searchParams;
  const client = await api(workspaceId);
  const [me, assets, intents, branches] = await Promise.all([
    client.get<Me>('/v1/me'),
    client.get<List<{ code: string; exponent: number }>>('/v1/assets'),
    client.get<List<PaymentIntent>>('/v1/payment-intents', { limit: 50, cursor: query['cursor'] }),
    client.get<List<Branch>>('/v1/workspace/branches'),
  ]);
  const exponent = exponentOf(assets.data, CURRENCY);
  const money = (minor: string): string => formatMinor(minor, exponent);
  const role = me.memberships.find((entry) => entry.workspace_id === workspaceId)?.role;
  const branchName = new Map(branches.data.map((branch) => [branch.id, branch.name]));

  let quote: Quote | null = null;
  let quoteError: string | null = null;
  if (query['amount_minor']) {
    try {
      quote = await client.get<Quote>('/v1/tariffs/quote', {
        operation: 'collection',
        rail: 'mpesa',
        currency: CURRENCY,
        amount_minor: query['amount_minor'],
      });
    } catch (error) {
      quoteError = messageOf(error);
    }
  }

  return (
    <>
      {query['error'] && <p className="error">{query['error']}</p>}
      {quoteError && <p className="error">{quoteError}</p>}
      {query['ok'] === 'collected' && (
        <p className="ok">Collection started. Its status updates below as the provider answers.</p>
      )}

      <div className="card">
        <h2>Collect a payment (M-Pesa, sandbox)</h2>
        {quote ? (
          <form action={collect} className="stack">
            <input type="hidden" name="workspace_id" value={workspaceId} />
            <input type="hidden" name="currency" value={CURRENCY} />
            <input type="hidden" name="amount_minor" value={quote.amount_minor} />
            {/* One key per confirmation screen: pressing twice cannot collect twice. */}
            <input type="hidden" name="idempotency_key" value={randomUUID()} />
            {['branch_id', 'reference', 'sandbox_scenario'].map((key) =>
              query[key] ? <input key={key} type="hidden" name={key} value={query[key]} /> : null,
            )}
            <table>
              <tbody>
                <tr>
                  <td>Customer pays</td>
                  <td className="num">
                    {CURRENCY} {money(quote.amount_minor)}
                  </td>
                </tr>
                <tr>
                  <td>AORA fee (tariff version {quote.tariff_version})</td>
                  <td className="num">
                    {CURRENCY} {money(quote.fee_minor)}
                  </td>
                </tr>
                <tr>
                  <td>
                    <strong>You receive</strong>
                  </td>
                  <td className="num">
                    <strong>
                      {CURRENCY} {money(quote.net_minor)}
                    </strong>
                  </td>
                </tr>
              </tbody>
            </table>
            <p className="muted">Sandbox fees are made-up values, not a real tariff.</p>
            <button type="submit">Collect</button>
          </form>
        ) : (
          <form action={preview} className="stack">
            <input type="hidden" name="workspace_id" value={workspaceId} />
            <input type="hidden" name="exponent" value={exponent} />
            <label>
              Amount ({CURRENCY})
              <input name="amount" inputMode="decimal" placeholder="150.00" required />
            </label>
            {role !== 'cashier' && branches.data.length > 0 && (
              <label>
                Branch
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
            )}
            <label>
              Your reference (optional: order, counter, vehicle)
              <input name="reference" maxLength={64} />
            </label>
            <label>
              Sandbox behaviour
              <select name="sandbox_scenario" defaultValue="success">
                {SCENARIOS.map((scenario) => (
                  <option key={scenario} value={scenario}>
                    {scenario.replaceAll('_', ' ')}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit">See fee</button>
          </form>
        )}
      </div>

      <h2>Collections</h2>
      <div className="card">
        {intents.data.length === 0 ? (
          <p className="muted">No collections yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Status</th>
                <th className="num">Gross</th>
                <th className="num">Fee</th>
                <th className="num">Net</th>
                <th>Branch</th>
                <th>Reference</th>
              </tr>
            </thead>
            <tbody>
              {intents.data.map((intent) => (
                <tr key={intent.id}>
                  <td>{new Date(intent.created_at).toLocaleString('en-KE')}</td>
                  <td>
                    <span className="pill">{intent.status.replaceAll('_', ' ')}</span>
                  </td>
                  <td className="num">{money(intent.amount_minor)}</td>
                  <td className="num">{money(intent.fee_minor)}</td>
                  <td className="num">{money(intent.net_minor)}</td>
                  <td>{intent.branch_id ? (branchName.get(intent.branch_id) ?? '') : ''}</td>
                  <td>{intent.reference ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {intents.next_cursor && (
          <p>
            <a href={`/w/${workspaceId}?cursor=${intents.next_cursor}`}>Older</a>
          </p>
        )}
        <p className="muted">
          Amounts in {CURRENCY}. Money collected here sits in an AORA-controlled sandbox collection
          account until settlement (a labelled sandbox assumption).
        </p>
      </div>
    </>
  );
}
