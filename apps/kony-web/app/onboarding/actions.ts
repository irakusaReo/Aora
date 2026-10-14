'use server';

import type { Application } from '@aora/api-client';
import { redirect } from 'next/navigation';
import { api, field, messageOf } from '../../lib/api';

export async function savePhone(form: FormData): Promise<void> {
  let target = '/onboarding?ok=phone';
  try {
    await (await api()).put('/v1/me/phone', { phone: field(form, 'phone') });
  } catch (error) {
    target = `/onboarding?error=${encodeURIComponent(messageOf(error))}`;
  }
  redirect(target);
}

export async function apply(form: FormData): Promise<void> {
  const kind = field(form, 'kind');
  const body =
    kind === 'registered'
      ? {
          kind,
          name: field(form, 'name'),
          country: 'KE',
          registration: { type: 'sandbox_registration_number', value: field(form, 'registration') },
        }
      : {
          kind: 'unregistered',
          name: field(form, 'name'),
          country: 'KE',
          location: {
            area: field(form, 'area'),
            locality: field(form, 'locality'),
            place: field(form, 'place'),
          },
        };
  let target: string;
  try {
    const result = await (
      await api()
    ).post<Application>('/v1/onboarding/applications', body, field(form, 'idempotency_key'));
    target =
      result.status === 'approved' && result.workspace_id
        ? `/w/${result.workspace_id}`
        : `/onboarding?application=${result.id}`;
  } catch (error) {
    target = `/onboarding?error=${encodeURIComponent(messageOf(error))}`;
  }
  redirect(target);
}

export async function acceptInvitation(form: FormData): Promise<void> {
  let target: string;
  try {
    const result = await (
      await api()
    ).post<{ workspace_id: string }>(`/v1/me/invitations/${field(form, 'id')}/accept`);
    target = `/w/${result.workspace_id}`;
  } catch (error) {
    target = `/onboarding?error=${encodeURIComponent(messageOf(error))}`;
  }
  redirect(target);
}
