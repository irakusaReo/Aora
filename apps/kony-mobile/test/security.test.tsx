import { AoraApiError } from '@aora/api-client';
import { fakeApi, renderWith, services } from '@aora/mobile/testing';
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SecurityScreen } from '../src/screens/security';
import { me } from './fixtures';

describe('PIN and phone', () => {
  it('sets the PIN and clears the field', async () => {
    const api = fakeApi(({ path }) => {
      if (path === '/v1/me') return me('admin');
      if (path === '/v1/auth/pin') return { pin_set: true, mode: 'sandbox' };
      throw new Error(path);
    });
    renderWith(services(api), <SecurityScreen />);
    const field = await screen.findByLabelText<HTMLInputElement>('New PIN');
    fireEvent.change(field, { target: { value: '48a2916' } });
    expect(field.value).toBe('482916');
    fireEvent.click(screen.getByText('Set PIN'));
    expect(await screen.findByText('PIN set.')).toBeTruthy();
    expect(field.value).toBe('');
  });

  it('passes on the API’s request to confirm sign-in again', async () => {
    const api = fakeApi(({ path }) => {
      if (path === '/v1/me') return me('admin');
      throw new AoraApiError(403, 'reverification_required', 'Sign in again first.', null);
    });
    renderWith(services(api), <SecurityScreen />);
    fireEvent.change(await screen.findByLabelText('New PIN'), { target: { value: '482916' } });
    fireEvent.click(screen.getByText('Set PIN'));
    expect(await screen.findByText('Sign in again first.')).toBeTruthy();
  });

  it('saves a missing phone number', async () => {
    const api = fakeApi(({ path, body }) => {
      if (path === '/v1/me') return me('admin', false);
      if (path === '/v1/me/phone') {
        expect(body).toEqual({ phone: '+254700000001' });
        return { phone_hint: '•••001', phone_verified: false, mode: 'sandbox' };
      }
      throw new Error(path);
    });
    renderWith(services(api), <SecurityScreen />);
    fireEvent.change(await screen.findByLabelText(/Phone number in international/), {
      target: { value: '+254 700 000 001' },
    });
    fireEvent.click(screen.getByText('Save phone number'));
    expect(await screen.findByText('Phone number saved.')).toBeTruthy();
  });
});
