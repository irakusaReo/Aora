import {
  type Balance,
  formatMinor,
  type List,
  type Payout,
  type PayoutQuote,
  type PayoutRecipient,
  type Settlement,
} from '@aora/api-client';
import { randomUUID } from 'node:crypto';
import { api, exponentOf, messageOf } from '../../../../lib/api';
import { addRecipient, confirmRecipient, previewPayout, sendPayout } from './actions';

const CURRENCY = 'KES';
// Safaricom's published sandbox test number: the only payout recipient Daraja's sandbox allows.
const DARAJA_TEST_NUMBER = '+254708374149';
const BALANCE_NAMES: Record<string, string> = {
  merchant_collections_pending: 'Collected, not yet settled',
  merchant_available: 'Available to pay out',
  merchant_payouts_in_flight: 'Payouts and refunds in progress',
};

export default async function Money({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}): Promise<React.JSX.Element> {
  const { workspaceId } = await params;
  const query = await searchParams;
  const client = await api(workspaceId);
  const [assets, balances, settlements, recipients, payouts] = await Promise.all([
    client.get<List<{ code: string; exponent: number }>>('/v1/assets'),
    client.get<List<Balance>>('/v1/ledger/balances'),
    client.get<List<Settlement>>('/v1/settlements'),
    client.get<List<PayoutRecipient>>('/v1/payout-recipients'),
    client.get<List<Payout>>('/v1/payouts'),
  ]);
  const exponent = exponentOf(assets.data, CURRENCY);
  const money = (minor: string): string => `${CURRENCY} ${formatMinor(minor, exponent)}`;
  const recipientName = new Map(recipients.data.map((r) => [r.id, `${r.label} (${r.phone_hint})`]));

  let quote: PayoutQuote | null = null;
  let quoteError: string | null = null;
  if (query['recipient_id'] && query['amount_minor']) {
    try {
      quote = await client.post<PayoutQuote>('/v1/payouts/preview', {
        recipient_id: query['recipient_id'],
        amount_minor: query['amount_minor'],
        currency: CURRENCY,
      });
    } catch (error) {
      quoteError = messageOf(error);
    }
  }

  return (
    <>
      <h1>Money</h1>
      {query['error'] && <p className="error">{query['error']}</p>}
      {quoteError && <p className="error">{quoteError}</p>}
      {query['ok'] === 'payout_sent' && (
        <p className="ok">Payout started. Its status updates below.</p>
      )}
      {query['ok'] === 'recipient_confirmed' && (
        <p className="ok">
          Recipient confirmed. This records your intent to pay this number; it does not prove who
          owns it. The first payout can be sent after a short waiting period and is capped.
        </p>
      )}

      <div className="card">
        <h2>Balances</h2>
        <table>
          <tbody>
            {balances.data
              .filter((row) => BALANCE_NAMES[row.account_type])
              .map((row) => (
                <tr key={row.account_type}>
                  <td>{BALANCE_NAMES[row.account_type]}</td>
                  <td className="num">{money(row.balance_minor)}</td>
                </tr>
              ))}
          </tbody>
        </table>
        <p className="muted">
          Each balance is separate and never added together. Sandbox: money sits in an
          AORA-controlled collection account (a labelled sandbox assumption).
        </p>
      </div>

      <div className="card">
        <h2>Pay out</h2>
        {quote ? (
          <form action={sendPayout} className="stack">
            <input type="hidden" name="workspace_id" value={workspaceId} />
            <input type="hidden" name="currency" value={CURRENCY} />
            <input type="hidden" name="recipient_id" value={query['recipient_id']} />
            <input type="hidden" name="amount_minor" value={quote.amount_minor} />
            <input type="hidden" name="expected_fee_minor" value={quote.fee_minor} />
            <input type="hidden" name="tariff_version_id" value={quote.tariff_version_id} />
            <input type="hidden" name="idempotency_key" value={randomUUID()} />
            <table>
              <tbody>
                <tr>
                  <td>To</td>
                  <td>{recipientName.get(query['recipient_id'] ?? '')}</td>
                </tr>
                <tr>
                  <td>Amount</td>
                  <td className="num">{money(quote.amount_minor)}</td>
                </tr>
                <tr>
                  <td>Fee (tariff version {quote.tariff_version})</td>
                  <td className="num">{money(quote.fee_minor)}</td>
                </tr>
                <tr>
                  <td>
                    <strong>Taken from your balance</strong>
                  </td>
                  <td className="num">
                    <strong>{money(quote.total_minor)}</strong>
                  </td>
                </tr>
              </tbody>
            </table>
            <p className="muted">Needs a recent PIN confirmation (Security page).</p>
            <button type="submit">Send payout</button>
          </form>
        ) : recipients.data.some((r) => r.status === 'confirmed') ? (
          <form action={previewPayout} className="stack">
            <input type="hidden" name="workspace_id" value={workspaceId} />
            <input type="hidden" name="exponent" value={exponent} />
            <label>
              Recipient
              <select name="recipient_id">
                {recipients.data
                  .filter((r) => r.status === 'confirmed')
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label} ({r.phone_hint})
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Amount ({CURRENCY}, whole shillings for M-Pesa)
              <input name="amount" inputMode="decimal" required />
            </label>
            <button type="submit">See fee</button>
          </form>
        ) : (
          <p className="muted">Add and confirm a recipient first.</p>
        )}
      </div>

      <div className="card">
        <h2>Recipients</h2>
        <table>
          <tbody>
            {recipients.data.map((recipient) => (
              <tr key={recipient.id}>
                <td>{recipient.label}</td>
                <td>{recipient.phone_hint}</td>
                <td>
                  <span className="pill">{recipient.status}</span>
                </td>
                <td>
                  {recipient.status === 'unconfirmed' && (
                    <form action={confirmRecipient}>
                      <input type="hidden" name="workspace_id" value={workspaceId} />
                      <input type="hidden" name="id" value={recipient.id} />
                      <input
                        name="phone"
                        placeholder="Type the number again"
                        required
                        inputMode="tel"
                      />{' '}
                      <button type="submit">Confirm</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <form action={addRecipient} className="stack">
          <input type="hidden" name="workspace_id" value={workspaceId} />
          <label>
            Name for this recipient
            <input name="label" required maxLength={60} />
          </label>
          <label>
            M-Pesa number (the Daraja sandbox only accepts its test number)
            <input name="phone" defaultValue={DARAJA_TEST_NUMBER} required inputMode="tel" />
          </label>
          <button type="submit" className="secondary">
            Add recipient
          </button>
        </form>
        <p className="muted">
          Confirming means typing the number a second time, with a recent PIN confirmation.
        </p>
      </div>

      <div className="card">
        <h2>Payouts</h2>
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>To</th>
              <th>Status</th>
              <th className="num">Amount</th>
              <th className="num">Fee</th>
            </tr>
          </thead>
          <tbody>
            {payouts.data.map((payout) => (
              <tr key={payout.id}>
                <td>{new Date(payout.created_at).toLocaleString('en-KE')}</td>
                <td>{recipientName.get(payout.recipient_id) ?? ''}</td>
                <td>
                  <span className="pill">{payout.status.replaceAll('_', ' ')}</span>
                </td>
                <td className="num">{money(payout.amount_minor)}</td>
                <td className="num">{money(payout.fee_minor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Settlements</h2>
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th className="num">Collections</th>
              <th className="num">Gross</th>
              <th className="num">Fee</th>
              <th className="num">Net to available</th>
            </tr>
          </thead>
          <tbody>
            {settlements.data.map((batch) => (
              <tr key={batch.id}>
                <td>{new Date(batch.created_at).toLocaleString('en-KE')}</td>
                <td className="num">{batch.collections}</td>
                <td className="num">{money(batch.gross_minor)}</td>
                <td className="num">{money(batch.fee_minor)}</td>
                <td className="num">{money(batch.net_minor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
