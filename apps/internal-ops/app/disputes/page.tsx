import type { KeloClaim, List } from '@aora/api-client';
import { redirect } from 'next/navigation';
import { api, field, messageOf } from '../../lib/api';

const REASON: Record<KeloClaim['reason_code'], string> = {
  not_delivered: 'Not delivered',
  not_as_described: 'Not as described',
  faulty: 'Faulty',
  changed_mind: 'Changed their mind',
  other: 'Other',
};

/** Upholding refunds the buyer; after delivery it also claws back from the merchant. PIN and reason required. */
async function decide(form: FormData): Promise<void> {
  'use server';
  let target = '/disputes?ok=1';
  try {
    const client = await api();
    await client.post('/v1/auth/step-up', { pin: field(form, 'pin') });
    await client.post(`/v1/ops/kelo/claims/${field(form, 'id')}/decision`, {
      outcome: field(form, 'outcome'),
      reason: field(form, 'reason'),
    });
  } catch (error) {
    target = `/disputes?error=${encodeURIComponent(messageOf(error))}`;
  }
  redirect(target);
}

export default async function DisputesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}): Promise<React.JSX.Element> {
  const query = await searchParams;
  let disputes: KeloClaim[] = [];
  let off = false;
  try {
    disputes = (await (await api()).get<List<KeloClaim>>('/v1/ops/kelo/claims')).data;
  } catch {
    off = true;
  }
  return (
    <>
      <h1>KELO disputes</h1>
      <p className="muted">
        A dispute pauses the buyer&apos;s plan. Upholding it before delivery cancels the purchase
        and refunds the buyer; after delivery it is a return, and the merchant&apos;s net is clawed
        back from their next KELO settlement. Returns are decided by merchants, not here.
      </p>
      {query['ok'] && <p className="ok">Saved.</p>}
      {query['error'] && <p className="error">{query['error']}</p>}
      {off && <p className="muted">Disputes are unavailable.</p>}
      {!off && disputes.length === 0 && <p className="muted">No open disputes.</p>}
      {disputes.map((dispute) => (
        <div className="card" key={dispute.id}>
          <p>
            <strong>{REASON[dispute.reason_code]}</strong>{' '}
            <span className="pill">opened {new Date(dispute.created_at).toISOString()}</span>
          </p>
          <p className="muted">
            Purchase {dispute.purchase_id} · workspace {dispute.workspace_id ?? ''}
          </p>
          {dispute.details && <p>“{dispute.details}”</p>}
          <form action={decide} className="stack">
            <input type="hidden" name="id" value={dispute.id} />
            <label>
              Outcome
              <select name="outcome" required defaultValue="">
                <option value="" disabled />
                <option value="accepted">Uphold: refund the buyer</option>
                <option value="rejected">Reject: the plan resumes</option>
              </select>
            </label>
            <label>
              Reason
              <input name="reason" required minLength={3} maxLength={300} />
            </label>
            <label>
              Your PIN
              <input
                name="pin"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                required
                pattern="[0-9]{6}"
              />
            </label>
            <button type="submit">Decide</button>
          </form>
        </div>
      ))}
    </>
  );
}
