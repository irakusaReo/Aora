import { formatMinor, type KeloMerchantPurchase, type List } from '@aora/api-client';
import { redirect } from 'next/navigation';
import { api, exponentOf, field, messageOf } from '../../../../../lib/api';

const NEXT: Record<KeloMerchantPurchase['next_action'], string> = {
  wait_for_payments: 'Waiting for the buyer’s payments',
  confirm: 'Confirm you can fulfil it',
  fulfil: 'Deliver it, then record delivery',
  wait_for_buyer: 'Waiting for the buyer to confirm delivery',
  respond_to_return: 'The buyer asked to return it: accept or reject',
  wait_for_decision: 'A dispute is open: KELO will decide',
  none: 'Nothing to do',
};
const STATUS: Record<KeloMerchantPurchase['status'], string> = {
  placed: 'Placed',
  payment_ready: 'Payments under way',
  merchant_confirmed: 'Confirmed',
  fulfilled: 'Delivered',
  completed: 'Complete, you have been paid',
  cancelled: 'Cancelled',
  return_requested: 'Return requested',
  returned: 'Returned',
  disputed: 'Disputed',
};
const PLAN: Record<KeloMerchantPurchase['plan_type'], string> = {
  layaway: 'Layaway',
  pay_in_n: 'Pay in 4 (KELO pays you on delivery)',
  monthly_financing: 'Monthly financing (KELO pays you on delivery)',
};
const CLAIM_REASON: Record<string, string> = {
  not_delivered: 'Not delivered',
  not_as_described: 'Not as described',
  faulty: 'Faulty',
  changed_mind: 'Changed their mind',
  other: 'Other',
};

/**
 * Accepting a return refunds the buyer and claws back what you were paid from
 * your next KELO settlement; it needs your PIN (a step-up) and refund rights.
 */
async function respond(form: FormData): Promise<void> {
  'use server';
  const workspaceId = field(form, 'workspace_id');
  const claimId = field(form, 'claim_id');
  let target = `/w/${workspaceId}/kelo/purchases`;
  try {
    const client = await api(workspaceId);
    if (field(form, 'decision') === 'accept') {
      await client.post('/v1/auth/step-up', { pin: field(form, 'pin') });
      await client.post(`/v1/workspace/kelo/claims/${claimId}/accept`);
    } else {
      await client.post(`/v1/workspace/kelo/claims/${claimId}/reject`, {
        reason: field(form, 'reason'),
      });
    }
  } catch (error) {
    target = `${target}?error=${encodeURIComponent(messageOf(error))}`;
  }
  redirect(target);
}

async function act(form: FormData): Promise<void> {
  'use server';
  const workspaceId = field(form, 'workspace_id');
  let target = `/w/${workspaceId}/kelo/purchases`;
  try {
    const path = `/v1/workspace/kelo/purchases/${field(form, 'purchase_id')}/${field(form, 'action')}`;
    const proof = field(form, 'proof_reference');
    await (await api(workspaceId)).post(path, proof ? { proof_reference: proof } : {});
  } catch (error) {
    target = `${target}?error=${encodeURIComponent(messageOf(error))}`;
  }
  redirect(target);
}

export default async function KeloPurchases({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}): Promise<React.JSX.Element> {
  const { workspaceId } = await params;
  const query = await searchParams;
  const client = await api(workspaceId);
  const [purchases, assets] = await Promise.all([
    client.get<List<KeloMerchantPurchase>>('/v1/workspace/kelo/purchases'),
    client.get<List<{ code: string; exponent: number }>>('/v1/assets'),
  ]);
  return (
    <>
      <h1>KELO orders</h1>
      <p className="muted">
        Layaway: buyers pay KELO in instalments and the money is held for them until delivery. Pay
        in 4 and monthly financing: KELO pays you on delivery, less its fee, and the buyer repays
        KELO. You never see who the buyer is, or anything about their credit.
      </p>
      {query['error'] && <p className="error">{query['error']}</p>}
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Status</th>
              <th>Sale</th>
              <th>KELO fee</th>
              <th>You receive</th>
              <th>Next</th>
            </tr>
          </thead>
          <tbody>
            {purchases.data.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No orders yet.
                </td>
              </tr>
            )}
            {purchases.data.map((purchase) => {
              const money = (minor: string): string =>
                `${purchase.currency} ${formatMinor(minor, exponentOf(assets.data, purchase.currency))}`;
              return (
                <tr key={purchase.id}>
                  <td>{purchase.listing_title}</td>
                  <td>
                    <span className="pill">{STATUS[purchase.status]}</span>
                    <div className="muted">{PLAN[purchase.plan_type]}</div>
                    {purchase.plan_type === 'layaway' && (
                      <div className="muted">
                        {money(purchase.paid_minor)} of {money(purchase.total_minor)} paid
                      </div>
                    )}
                    {purchase.claim && (
                      <div className="muted">
                        {purchase.claim.kind === 'return' ? 'Return' : 'Dispute'}:{' '}
                        {CLAIM_REASON[purchase.claim.reason_code]}
                        {purchase.claim.details ? ` (“${purchase.claim.details}”)` : ''} ·{' '}
                        {purchase.claim.status}
                      </div>
                    )}
                  </td>
                  <td>{money(purchase.total_minor)}</td>
                  <td>{money(purchase.merchant_fee_minor)}</td>
                  <td>{money(purchase.net_minor)}</td>
                  <td>
                    {NEXT[purchase.next_action]}
                    {(purchase.next_action === 'confirm' || purchase.next_action === 'fulfil') && (
                      <form action={act} className="stack">
                        <input type="hidden" name="workspace_id" value={workspaceId} />
                        <input type="hidden" name="purchase_id" value={purchase.id} />
                        <input
                          type="hidden"
                          name="action"
                          value={purchase.next_action === 'confirm' ? 'confirm' : 'fulfil'}
                        />
                        {purchase.next_action === 'fulfil' && (
                          <input
                            name="proof_reference"
                            placeholder="Delivery note number (if required)"
                            maxLength={80}
                          />
                        )}
                        <button type="submit" className="secondary">
                          {purchase.next_action === 'confirm' ? 'Confirm' : 'Record delivery'}
                        </button>
                      </form>
                    )}
                    {purchase.next_action === 'respond_to_return' && purchase.claim && (
                      <>
                        <form action={respond} className="stack">
                          <input type="hidden" name="workspace_id" value={workspaceId} />
                          <input type="hidden" name="claim_id" value={purchase.claim.id} />
                          <input type="hidden" name="decision" value="accept" />
                          <input
                            name="pin"
                            type="password"
                            inputMode="numeric"
                            autoComplete="off"
                            required
                            pattern="[0-9]{6}"
                            placeholder="Your PIN"
                          />
                          <button type="submit" className="secondary">
                            Accept the return ({money(purchase.net_minor)} clawed back)
                          </button>
                        </form>
                        <form action={respond} className="stack">
                          <input type="hidden" name="workspace_id" value={workspaceId} />
                          <input type="hidden" name="claim_id" value={purchase.claim.id} />
                          <input type="hidden" name="decision" value="reject" />
                          <input
                            name="reason"
                            required
                            minLength={3}
                            maxLength={300}
                            placeholder="Why"
                          />
                          <button type="submit" className="secondary">
                            Reject the return
                          </button>
                        </form>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
