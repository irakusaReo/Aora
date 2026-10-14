'use server';

import { toMinorUnits } from '@aora/api-client';
import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { api, field, messageOf } from '../../../../lib/api';

const back = (workspaceId: string, query: Record<string, string>): string =>
  `/w/${workspaceId}/money?${new URLSearchParams(query).toString()}`;

export async function addRecipient(form: FormData): Promise<void> {
  const workspaceId = field(form, 'workspace_id');
  let target = back(workspaceId, { ok: 'recipient_added' });
  try {
    await (
      await api(workspaceId)
    ).post('/v1/payout-recipients', {
      phone: field(form, 'phone'),
      label: field(form, 'label'),
    });
  } catch (error) {
    target = back(workspaceId, { error: messageOf(error) });
  }
  redirect(target);
}

export async function confirmRecipient(form: FormData): Promise<void> {
  const workspaceId = field(form, 'workspace_id');
  let target = back(workspaceId, { ok: 'recipient_confirmed' });
  try {
    await (
      await api(workspaceId)
    ).post(`/v1/payout-recipients/${field(form, 'id')}/confirmation`, {
      phone: field(form, 'phone'),
    });
  } catch (error) {
    target = back(workspaceId, { error: messageOf(error) });
  }
  redirect(target);
}

/** Step one: read the amount exactly and show the fee before anything moves. */
// eslint-disable-next-line @typescript-eslint/require-await -- a server action must be async.
export async function previewPayout(form: FormData): Promise<void> {
  const workspaceId = field(form, 'workspace_id');
  const minor = toMinorUnits(field(form, 'amount'), Number.parseInt(field(form, 'exponent'), 10));
  if (!minor) redirect(back(workspaceId, { error: 'Enter an amount such as 150 or 150.50.' }));
  redirect(back(workspaceId, { recipient_id: field(form, 'recipient_id'), amount_minor: minor }));
}

export async function sendPayout(form: FormData): Promise<void> {
  const workspaceId = field(form, 'workspace_id');
  let target = back(workspaceId, { ok: 'payout_sent' });
  try {
    await (
      await api(workspaceId)
    ).post(
      '/v1/payouts',
      {
        recipient_id: field(form, 'recipient_id'),
        amount_minor: field(form, 'amount_minor'),
        currency: field(form, 'currency'),
        expected_fee_minor: field(form, 'expected_fee_minor'),
        tariff_version_id: field(form, 'tariff_version_id'),
      },
      field(form, 'idempotency_key') || randomUUID(),
    );
  } catch (error) {
    target = back(workspaceId, { error: messageOf(error) });
  }
  redirect(target);
}
