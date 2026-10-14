'use server';

import { toMinorUnits } from '@aora/api-client';
import { redirect } from 'next/navigation';
import { api, field, messageOf } from '../../../lib/api';

export async function collect(form: FormData): Promise<void> {
  const workspaceId = field(form, 'workspace_id');
  const base = `/w/${workspaceId}`;
  let target = `${base}?ok=collected`;
  try {
    const body: Record<string, string> = {
      // The amount was converted to minor units when the fee was previewed.
      amount_minor: field(form, 'amount_minor'),
      currency: field(form, 'currency'),
      rail: 'mpesa',
    };
    for (const key of ['branch_id', 'reference', 'sandbox_scenario']) {
      const value = field(form, key);
      if (value) body[key] = value;
    }
    // The payer's number goes only to Daraja; a simulator scenario needs none.
    if (!body['sandbox_scenario'] && field(form, 'payer_phone')) {
      body['payer_phone'] = field(form, 'payer_phone');
    }
    await (
      await api(workspaceId)
    ).post('/v1/payment-intents', body, field(form, 'idempotency_key'));
  } catch (error) {
    target = `${base}?error=${encodeURIComponent(messageOf(error))}`;
  }
  redirect(target);
}

/** Step one: read the typed amount exactly, then show gross, fee and net before collecting. */
// eslint-disable-next-line @typescript-eslint/require-await -- a server action must be async.
export async function preview(form: FormData): Promise<void> {
  const workspaceId = field(form, 'workspace_id');
  const exponent = Number.parseInt(field(form, 'exponent'), 10);
  const minor = toMinorUnits(field(form, 'amount'), exponent);
  const base = `/w/${workspaceId}`;
  if (!minor) {
    redirect(`${base}?error=${encodeURIComponent('Enter an amount such as 150 or 150.50.')}`);
  }
  const query = new URLSearchParams({ amount_minor: minor });
  // Never the payer's number: personal data stays out of URLs.
  for (const key of ['branch_id', 'reference', 'sandbox_scenario']) {
    const value = field(form, key);
    if (value) query.set(key, value);
  }
  redirect(`${base}?${query.toString()}`);
}
