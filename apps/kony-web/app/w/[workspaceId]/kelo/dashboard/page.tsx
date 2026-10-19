import { formatMinor, type KeloDashboard, type List } from '@aora/api-client';
import Link from 'next/link';
import { api, exponentOf } from '../../../../../lib/api';

/**
 * The KELO dashboard (kelo-experience.md §3), scannable in this order: orders
 * needing action; BNPL sales; settlements due and paid; returns; fees. Every
 * money figure comes from the ledger, broken down; nothing about any buyer.
 */
export default async function KeloDashboardPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}): Promise<React.JSX.Element> {
  const { workspaceId } = await params;
  const client = await api(workspaceId);
  const [view, assets] = await Promise.all([
    client.get<KeloDashboard>('/v1/workspace/kelo/dashboard'),
    client.get<List<{ code: string; exponent: number }>>('/v1/assets'),
  ]);
  const money = (minor: string): string =>
    `${view.currency} ${formatMinor(minor, exponentOf(assets.data, view.currency))}`;
  const orders = `/w/${workspaceId}/kelo/purchases`;
  return (
    <>
      <h1>KELO dashboard</h1>
      <p className="muted">
        Sandbox figures, read from the ledger. You never see who a buyer is or anything about their
        credit.
      </p>
      <div className="card">
        <h2>
          <Link href={orders}>Orders needing action: {view.orders_needing_action.total}</Link>
        </h2>
        <ul>
          <li>To confirm: {view.orders_needing_action.confirm}</li>
          <li>To deliver: {view.orders_needing_action.fulfil}</li>
          <li>Returns to answer: {view.orders_needing_action.respond_to_return}</li>
        </ul>
      </div>
      <div className="card">
        <h2>BNPL sales</h2>
        <p>
          {view.bnpl_sales.count} delivered, {money(view.bnpl_sales.gross_minor)} in sales. KELO
          paid you on delivery; the buyers repay KELO.
        </p>
      </div>
      <div className="card">
        <h2>Settlements</h2>
        <p>
          Due on delivery: {view.settlements.due.count} orders,{' '}
          {money(view.settlements.due.net_minor)} after KELO&apos;s fee.
        </p>
        <table>
          <tbody>
            <tr>
              <td>Sales settled ({view.settlements.paid.count})</td>
              <td>{money(view.settlements.paid.gross_minor)}</td>
            </tr>
            <tr>
              <td>KELO fee</td>
              <td>−{money(view.settlements.paid.fees_minor)}</td>
            </tr>
            <tr>
              <td>Clawbacks netted</td>
              <td>−{money(view.settlements.paid.clawback_netted_minor)}</td>
            </tr>
            <tr>
              <td>
                <strong>Paid to your available balance</strong>
              </td>
              <td>
                <strong>{money(view.settlements.paid.to_available_minor)}</strong>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="card">
        <h2>Returns</h2>
        <ul>
          <li>Open: {view.returns.open}</li>
          <li>Accepted: {view.returns.accepted}</li>
          <li>Clawed back for accepted returns: {money(view.returns.clawed_back_minor)}</li>
          <li>
            Still owed to KELO, taken from your next KELO settlement:{' '}
            {money(view.returns.clawback_outstanding_minor)}
          </li>
        </ul>
      </div>
      <div className="card">
        <h2>Fees</h2>
        <ul>
          <li>Charged on settlements: {money(view.fees.charged_minor)}</li>
          <li>Given back on accepted returns: {money(view.fees.refunded_minor)}</li>
          <li>
            <strong>Net KELO fees: {money(view.fees.net_minor)}</strong>
          </li>
        </ul>
      </div>
    </>
  );
}
