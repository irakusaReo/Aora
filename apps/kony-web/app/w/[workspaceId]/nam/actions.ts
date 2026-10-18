'use server';

import { toMinorUnits } from '@aora/api-client';
import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { api, field, messageOf } from '../../../../lib/api';

const USDC_DECIMALS = 6;

const back = (workspaceId: string, query: Record<string, string>): string =>
  `/w/${workspaceId}/nam?${new URLSearchParams(query).toString()}`;

export async function placeOrder(form: FormData): Promise<void> {
  const workspaceId = field(form, 'workspace_id');
  if (form.get('accept') !== 'yes') {
    redirect(back(workspaceId, { error: 'Read and confirm the disclosure first.' }));
  }
  const minor = toMinorUnits(field(form, 'amount'), USDC_DECIMALS);
  if (!minor) redirect(back(workspaceId, { error: 'Enter an amount such as 25 or 25.50.' }));
  let target = back(workspaceId, { ok: 'order' });
  try {
    await (
      await api(workspaceId)
    ).post(
      '/v1/nam/orders',
      { amount_minor: minor, disclosure_version: field(form, 'disclosure_version') },
      field(form, 'idempotency_key') || randomUUID(),
    );
  } catch (error) {
    target = back(workspaceId, { error: messageOf(error) });
  }
  redirect(target);
}

export async function redeem(form: FormData): Promise<void> {
  const workspaceId = field(form, 'workspace_id');
  const shares = field(form, 'shares');
  let target = back(workspaceId, { ok: 'redemption' });
  try {
    await (
      await api(workspaceId)
    ).post(
      '/v1/nam/redemptions',
      shares ? { shares } : { all: true },
      field(form, 'idempotency_key') || randomUUID(),
    );
  } catch (error) {
    target = back(workspaceId, { error: messageOf(error) });
  }
  redirect(target);
}
