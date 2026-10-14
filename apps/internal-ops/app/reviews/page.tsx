import type { List, ReviewItem } from '@aora/api-client';
import { redirect } from 'next/navigation';
import { api, field, messageOf } from '../../lib/api';

async function decide(form: FormData): Promise<void> {
  'use server';
  let target = '/reviews?ok=1';
  try {
    await (
      await api()
    ).post(`/v1/ops/onboarding-reviews/${field(form, 'id')}/decision`, {
      outcome: field(form, 'outcome'),
      reason: field(form, 'reason'),
    });
  } catch (error) {
    target = `/reviews?error=${encodeURIComponent(messageOf(error))}`;
  }
  redirect(target);
}

export default async function Reviews({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}): Promise<React.JSX.Element> {
  const query = await searchParams;
  const queue = await (await api()).get<List<ReviewItem>>('/v1/ops/onboarding-reviews');
  return (
    <>
      <h1>Possible duplicate businesses</h1>
      {query['error'] && <p className="error">{query['error']}</p>}
      {query['ok'] && <p className="ok">Decision recorded.</p>}
      {queue.data.length === 0 && <p className="muted">The queue is empty.</p>}
      {queue.data.map((item) => (
        <div className="card" key={item.id}>
          <p>
            <strong>{item.name}</strong> <span className="pill">{item.kind}</span>{' '}
            <span className="pill">rule: {item.rule}</span>
          </p>
          <p className="muted">
            Applicant {item.applicant_account_id} · similar to business{' '}
            {item.matched_business_id ?? '(none)'}
          </p>
          <form action={decide} className="stack">
            <input type="hidden" name="id" value={item.id} />
            <label>
              Decision
              <select name="outcome" defaultValue="distinct">
                <option value="distinct">Distinct business: onboard it</option>
                <option value="same">Same business: reject the application</option>
              </select>
            </label>
            <label>
              Reason (recorded in the audit trail)
              <textarea name="reason" required minLength={10} maxLength={500} />
            </label>
            <button type="submit">Decide</button>
          </form>
        </div>
      ))}
    </>
  );
}
