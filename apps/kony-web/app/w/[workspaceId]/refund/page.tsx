import { formatMinor, type List, type PaymentIntent, toMinorUnits } from '@aora/api-client';
import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { api, exponentOf, field, messageOf } from '../../../../lib/api';

async function refund(form: FormData): Promise<void> {
  'use server';
  const workspaceId = field(form, 'workspace_id');
  const intentId = field(form, 'intent_id');
  const minor = toMinorUnits(field(form, 'amount'), Number.parseInt(field(form, 'exponent'), 10));
  let target = `/w/${workspaceId}?ok=refund`;
  try {
    if (!minor) throw new Error('amount');
    await (
      await api(workspaceId)
    ).post(
      `/v1/payment-intents/${intentId}/refunds`,
      { amount_minor: minor, sandbox_scenario: 'success' },
      field(form, 'idempotency_key'),
    );
  } catch (error) {
    target = `/w/${workspaceId}/refund?intent=${intentId}&error=${encodeURIComponent(messageOf(error))}`;
  }
  redirect(target);
}

export default async function Refund({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}): Promise<React.JSX.Element> {
  const { workspaceId } = await params;
  const query = await searchParams;
  const client = await api(workspaceId);
  const [assets, intent] = await Promise.all([
    client.get<List<{ code: string; exponent: number }>>('/v1/assets'),
    client.get<PaymentIntent>(`/v1/payment-intents/${query['intent'] ?? ''}`),
  ]);
  const exponent = exponentOf(assets.data, intent.currency);
  return (
    <>
      <h1>Refund a collection</h1>
      {query['error'] && <p className="error">{query['error']}</p>}
      <div className="card">
        <p>
          Collected {intent.currency} {formatMinor(intent.amount_minor, exponent)} (fee{' '}
          {formatMinor(intent.fee_minor, exponent)}, kept). Refunds can never add up to more than
          the collection. Needs a recent PIN confirmation.
        </p>
        <form action={refund} className="stack">
          <input type="hidden" name="workspace_id" value={workspaceId} />
          <input type="hidden" name="intent_id" value={intent.id} />
          <input type="hidden" name="exponent" value={exponent} />
          <input type="hidden" name="idempotency_key" value={randomUUID()} />
          <label>
            Amount to refund ({intent.currency})
            <input name="amount" inputMode="decimal" required />
          </label>
          <button type="submit">Refund</button>
        </form>
      </div>
    </>
  );
}
