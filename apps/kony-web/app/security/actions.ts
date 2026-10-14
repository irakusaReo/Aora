'use server';

import { redirect } from 'next/navigation';
import { api, field, messageOf } from '../../lib/api';

const pin = (form: FormData): string => field(form, 'pin');

export async function setPin(form: FormData): Promise<void> {
  let target = '/security?ok=pin';
  try {
    await (await api()).put('/v1/auth/pin', { pin: pin(form) });
  } catch (error) {
    target = `/security?error=${encodeURIComponent(messageOf(error))}`;
  }
  redirect(target);
}

export async function stepUp(form: FormData): Promise<void> {
  let target = '/security?ok=step_up';
  try {
    await (await api()).post('/v1/auth/step-up', { pin: pin(form) });
  } catch (error) {
    target = `/security?error=${encodeURIComponent(messageOf(error))}`;
  }
  redirect(target);
}
