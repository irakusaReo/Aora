import {
  formatMinor,
  type List,
  type Treasury,
  type TreasuryAddress,
  type TreasuryTransfer,
  type Withdrawal,
} from '@aora/api-client';
import { randomUUID } from 'node:crypto';
import { api, messageOf } from '../../../../lib/api';
import {
  decideWithdrawal,
  registerAddress,
  requestWithdrawal,
  revokeAddress,
  startRegistration,
} from './actions';

const OK: Record<string, string> = {
  address_registered: 'Address registered. Deposits from it count from now on.',
  address_revoked: 'Address revoked. New deposits from it will not be credited.',
  withdrawal_requested: 'Withdrawal requested. A different admin must approve it.',
  withdrawal_sent: 'Withdrawal approved and sent. It completes after confirmation on Base Sepolia.',
  withdrawal_rejected: 'Withdrawal rejected; the amount is available again.',
};

const short = (value: string): string => `${value.slice(0, 8)}…${value.slice(-6)}`;

export default async function TreasuryPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}): Promise<React.JSX.Element> {
  const { workspaceId } = await params;
  const query = await searchParams;
  const client = await api(workspaceId);

  let treasury: Treasury;
  try {
    treasury = await client.get<Treasury>('/v1/treasury');
  } catch (error) {
    return (
      <>
        <h1>USDC treasury</h1>
        <p className="error">{messageOf(error)}</p>
      </>
    );
  }
  const [addresses, transfers, withdrawals] = await Promise.all([
    client.get<List<TreasuryAddress>>('/v1/treasury/addresses'),
    client.get<List<TreasuryTransfer>>('/v1/treasury/transfers'),
    client.get<List<Withdrawal>>('/v1/treasury/withdrawals'),
  ]);
  const usdc = (minor: string): string =>
    `${formatMinor(minor, treasury.asset.decimals)} ${treasury.asset.code}`;
  const txLink = (hash: string | null): React.JSX.Element | string =>
    hash ? (
      <a href={`${treasury.explorer_url}/tx/${hash}`} target="_blank" rel="noreferrer">
        {short(hash)}
      </a>
    ) : (
      '—'
    );

  return (
    <>
      <h1>USDC treasury</h1>
      <p className="muted">
        SANDBOX — testnet USDC on {treasury.network.label}. Nothing here is real money. Funds sit in
        the {treasury.wallet_label}; your workspace holds a claim on them in AORA&apos;s ledger.
      </p>
      {query['error'] && <p className="error">{query['error']}</p>}
      {query['ok'] && OK[query['ok']] && <p className="ok">{OK[query['ok']]}</p>}

      <section>
        <h2>Balances</h2>
        <dl>
          <dt>Available to withdraw</dt>
          <dd>{usdc(treasury.balances.available_minor)}</dd>
          <dt>Withdrawals in progress</dt>
          <dd>{usdc(treasury.balances.withdrawals_in_flight_minor)}</dd>
        </dl>
        <p className="muted">
          These are USDC balances only. They are separate from your KES collections and payouts.
        </p>
      </section>

      <section>
        <h2>Deposit testnet USDC</h2>
        <p>
          Send native USDC on {treasury.network.label} (chain {treasury.network.chain_id}) to{' '}
          <code>{treasury.deposit_address}</code>, from an address you have registered below.
        </p>
        <p className="muted">
          Token contract <code>{treasury.asset.contract}</code>. Any other token, and deposits from
          an address that is not registered, are never credited. A deposit counts after it is
          confirmed on chain, which takes a few minutes.
        </p>
      </section>

      <section>
        <h2>Registered deposit addresses</h2>
        {addresses.data.length === 0 ? (
          <p className="muted">No address registered yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Address</th>
                <th>Label</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {addresses.data.map((row) => (
                <tr key={row.id}>
                  <td>
                    <code>{row.address}</code>
                  </td>
                  <td>{row.label ?? '—'}</td>
                  <td>{row.status}</td>
                  <td>
                    {row.status === 'active' && (
                      <form action={revokeAddress}>
                        <input type="hidden" name="workspace_id" value={workspaceId} />
                        <input type="hidden" name="id" value={row.id} />
                        <button type="submit">Revoke</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {query['challenge_id'] && query['challenge'] ? (
          <form action={registerAddress} className="stack">
            <input type="hidden" name="workspace_id" value={workspaceId} />
            <input type="hidden" name="challenge_id" value={query['challenge_id']} />
            <p>
              Sign this exact message with the address you want to register (a personal-message
              signature in your wallet). Signing moves no funds.
            </p>
            <pre>{query['challenge']}</pre>
            <label>
              Address
              <input name="address" required pattern="^0x[0-9a-fA-F]{40}$" />
            </label>
            <label>
              Signature
              <input name="signature" required pattern="^0x[0-9a-fA-F]+$" />
            </label>
            <label>
              Label (optional)
              <input name="label" maxLength={60} />
            </label>
            <button type="submit">Register address</button>
          </form>
        ) : (
          <form action={startRegistration}>
            <input type="hidden" name="workspace_id" value={workspaceId} />
            <button type="submit">Register a deposit address</button>
          </form>
        )}
      </section>

      <section>
        <h2>Withdraw</h2>
        <form action={requestWithdrawal} className="stack">
          <input type="hidden" name="workspace_id" value={workspaceId} />
          <input type="hidden" name="idempotency_key" value={randomUUID()} />
          <label>
            Amount ({treasury.asset.code})
            <input name="amount" required inputMode="decimal" />
          </label>
          <label>
            Destination address
            <input name="destination" required pattern="^0x[0-9a-fA-F]{40}$" />
          </label>
          <button type="submit">Request withdrawal</button>
          <p className="muted">
            A different admin must approve it. Contract addresses are refused.
          </p>
        </form>
        {withdrawals.data.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Requested</th>
                <th>Amount</th>
                <th>To</th>
                <th>Status</th>
                <th>Transaction</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {withdrawals.data.map((row) => (
                <tr key={row.id}>
                  <td>{new Date(row.created_at).toLocaleString()}</td>
                  <td>{usdc(row.amount_minor)}</td>
                  <td>
                    <code>{short(row.destination)}</code>
                  </td>
                  <td>{row.status}</td>
                  <td>{txLink(row.tx_hash)}</td>
                  <td>
                    {row.status === 'requested' && (
                      <form action={decideWithdrawal}>
                        <input type="hidden" name="workspace_id" value={workspaceId} />
                        <input type="hidden" name="id" value={row.id} />
                        <button type="submit" name="decision" value="approve">
                          Approve
                        </button>{' '}
                        <button type="submit" name="decision" value="reject">
                          Reject
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>Transfers</h2>
        {transfers.data.length === 0 ? (
          <p className="muted">No transfers yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Direction</th>
                <th>Amount</th>
                <th>Counterparty</th>
                <th>Status</th>
                <th>Transaction</th>
              </tr>
            </thead>
            <tbody>
              {transfers.data.map((row, i) => (
                <tr key={`${row.tx_hash ?? 'pending'}-${String(i)}`}>
                  <td>{new Date(row.at).toLocaleString()}</td>
                  <td>{row.direction === 'in' ? 'Deposit' : 'Withdrawal'}</td>
                  <td>{usdc(row.amount_minor)}</td>
                  <td>
                    <code>{short(row.counterparty)}</code>
                  </td>
                  <td>{row.status}</td>
                  <td>{txLink(row.tx_hash)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
