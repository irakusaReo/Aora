import { fakeApi, renderWith, services } from '@aora/mobile/testing';
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HomeScreen } from '../src/screens/home';
import { routes } from './fixtures';

const terms = { key: 'chiwo_terms', version: '2026-10-19' };

describe('sign-up (J12)', () => {
  it('asks for the phone number first', async () => {
    const api = fakeApi(
      routes(({ path }) =>
        path === '/v1/chiwo/me' ? { signed_up: false, phone_on_file: false, terms } : undefined,
      ),
    );
    renderWith(services(api), <HomeScreen go={vi.fn()} />);
    expect(await screen.findByText(/Your phone number is your payment identity/)).toBeTruthy();
  });

  it('opens the account only after the terms are read and accepted, recording their version', async () => {
    let opened = false;
    const api = fakeApi(
      routes(({ method, path, body }) => {
        if (path === '/v1/chiwo/me') return { signed_up: opened, phone_on_file: true, terms };
        if (path === '/v1/terms/chiwo_terms')
          return { key: 'chiwo_terms', version: terms.version, title: 'Terms', body: 'The words.' };
        if (method === 'POST' && path === '/v1/chiwo/sign-up') {
          expect(body).toEqual({ terms_version: '2026-10-19' });
          opened = true;
          return {};
        }
        if (path === '/v1/chiwo/activity') return { data: [] };
        throw new Error(`unexpected ${path}`);
      }),
    );
    renderWith(services(api), <HomeScreen go={vi.fn()} />);
    expect(await screen.findByText('The words.')).toBeTruthy();
    const agree = screen.getByText('Open my account');
    fireEvent.click(agree);
    expect(opened).toBe(false);
    fireEvent.click(screen.getByRole('radio'));
    fireEvent.click(agree);
    expect(await screen.findByText(/Nothing yet/)).toBeTruthy();
  });
});

describe('home', () => {
  it('lists activity with each amount in its own currency and opens a shop payment', async () => {
    const go = vi.fn();
    const api = fakeApi(
      routes(({ path }) => {
        if (path === '/v1/chiwo/me') return { signed_up: true, phone_on_file: true, terms };
        if (path === '/v1/chiwo/activity')
          return {
            data: [
              {
                kind: 'merchant_payment',
                id: 'cp_1',
                direction: 'out',
                status: 'succeeded',
                amount_minor: '15000',
                currency: 'KES',
                counterparty: 'Duka',
                created_at: '2026-10-19T09:00:00Z',
              },
              {
                kind: 'transfer',
                id: 'tr_1',
                direction: 'in',
                status: 'completed',
                amount_minor: '2500000',
                currency: 'USDC',
                counterparty: 'Wanjiru',
                created_at: '2026-10-19T09:00:00Z',
              },
            ],
          };
        throw new Error(path);
      }),
    );
    renderWith(services(api), <HomeScreen go={go} />);
    expect(await screen.findByText('−KES 150.00 · succeeded')).toBeTruthy();
    expect(screen.getByText('+USDC 2.500000 · completed')).toBeTruthy();
    fireEvent.click(screen.getByText('Shop payment · Duka'));
    expect(go).toHaveBeenCalledWith('/payments/cp_1');
  });
});
