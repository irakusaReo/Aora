'use server';

import { toMinorUnits } from '@aora/api-client';
import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { api, field, messageOf } from '../../../../lib/api';

const USDC_DECIMALS = 6;

const back = (workspaceId: string, query: Record<string, string>): string =>
  `/w/${workspaceId}/treasury?${new URLSearchParams(query).toString()}`;

/** Step one of registering a deposit address: get a one-time message to sign. */
export async function startRegistration(form: FormData): Promise<void> {
  const workspaceId = field(form, 'workspace_id');
  let target: string;
  try {
    const challenge = await (
      await api(workspaceId)
    ).post<{ id: string; message: string }>('/v1/treasury/address-challenges', {});
    target = back(workspaceId, { challenge_id: challenge.id, challenge: challenge.message });
  } catch (error) {
    target = back(workspaceId, { error: messageOf(error) });
  }
  redirect(target);
}

/** Step two: the address owner's signature of that message, made in their own wallet. */
export async function registerAddress(form: FormData): Promise<void> {
  const workspaceId = field(form, 'workspace_id');
  let target = back(workspaceId, { ok: 'address_registered' });
  try {
    await (
      await api(workspaceId)
    ).post('/v1/treasury/addresses', {
      challenge_id: field(form, 'challenge_id'),
      address: field(form, 'address'),
      signature: field(form, 'signature'),
      ...(field(form, 'label') ? { label: field(form, 'label') } : {}),
    });
  } catch (error) {
    target = back(workspaceId, { error: messageOf(error) });
  }
  redirect(target);
}

export async function revokeAddress(form: FormData): Promise<void> {
  const workspaceId = field(form, 'workspace_id');
  let target = back(workspaceId, { ok: 'address_revoked' });
  try {
    await (
      await api(workspaceId)
    ).post(`/v1/treasury/addresses/${field(form, 'id')}/revocation`, {});
  } catch (error) {
    target = back(workspaceId, { error: messageOf(error) });
  }
  redirect(target);
}

export async function requestWithdrawal(form: FormData): Promise<void> {
  const workspaceId = field(form, 'workspace_id');
  const minor = toMinorUnits(field(form, 'amount'), USDC_DECIMALS);
  if (!minor) redirect(back(workspaceId, { error: 'Enter an amount such as 25 or 25.50.' }));
  let target = back(workspaceId, { ok: 'withdrawal_requested' });
  try {
    await (
      await api(workspaceId)
    ).post(
      '/v1/treasury/withdrawals',
      { amount_minor: minor, destination: field(form, 'destination') },
      field(form, 'idempotency_key') || randomUUID(),
    );
  } catch (error) {
    target = back(workspaceId, { error: messageOf(error) });
  }
  redirect(target);
}

export async function decideWithdrawal(form: FormData): Promise<void> {
  const workspaceId = field(form, 'workspace_id');
  const decision = field(form, 'decision');
  let target = back(workspaceId, {
    ok: decision === 'approve' ? 'withdrawal_sent' : 'withdrawal_rejected',
  });
  try {
    const client = await api(workspaceId);
    if (decision === 'approve') {
      await client.post(`/v1/treasury/withdrawals/${field(form, 'id')}/approval`, {});
    } else {
      await client.post(`/v1/treasury/withdrawals/${field(form, 'id')}/rejection`, {
        reason: field(form, 'reason') || 'Rejected by an admin.',
      });
    }
  } catch (error) {
    target = back(workspaceId, { error: messageOf(error) });
  }
  redirect(target);
}
