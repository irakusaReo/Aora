import { AoraApiError } from '@aora/api-client';
import { fakeApi, renderWith, services } from '@aora/mobile/testing';
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CollectionScreen } from '../src/screens/collection';
import { CollectionsScreen } from '../src/screens/collections';
import { routes, WS } from './fixtures';

function intent(status: string, provider = 'sandbox_sim'): unknown {
  return {
    id: 'pi_1',
    status,
    amount_minor: '100000',
    fee_minor: '1000',
    net_minor: '99000',
    tariff_version_id: 'tv_1',
    currency: 'KES',
    rail: 'mpesa',
    branch_id: null,
    reference: 'Table 4',
    provider,
    failure_code: null,
    created_at: '2026-10-19T09:00:00Z',
    updated_at: '2026-10-19T09:00:00Z',
  };
}

describe('collections', () => {
  it('lists collections with amount and plain-language state', async () => {
    const api = fakeApi(
      routes('cashier', ({ path }) =>
        path === '/v1/payment-intents' ? { data: [intent('status_unknown')] } : undefined,
      ),
    );
    renderWith(services(api), <CollectionsScreen workspaceId={WS} go={vi.fn()} />);
    expect(await screen.findByText('KES 1,000.00 · Being checked with the provider')).toBeTruthy();
  });

  it('shows an empty state', async () => {
    const api = fakeApi(routes('cashier', () => ({ data: [] })));
    renderWith(services(api), <CollectionsScreen workspaceId={WS} go={vi.fn()} />);
    expect(await screen.findByText('No collections yet.')).toBeTruthy();
  });
});

describe('one collection', () => {
  it('explains an unknown state honestly, with gross, fee and net', async () => {
    const api = fakeApi(routes('cashier', () => intent('status_unknown', 'daraja')));
    renderWith(services(api), <CollectionScreen workspaceId={WS} intentId="pi_1" />);
    expect(await screen.findByText(/nothing will be sent twice/)).toBeTruthy();
    expect(screen.getByText('KES 1,000.00')).toBeTruthy();
    expect(screen.getByText('KES 10.00')).toBeTruthy();
    expect(screen.getByText('KES 990.00')).toBeTruthy();
  });

  it('offers no refund to a cashier', async () => {
    const api = fakeApi(routes('cashier', () => intent('succeeded')));
    renderWith(services(api), <CollectionScreen workspaceId={WS} intentId="pi_1" />);
    await screen.findByText('Succeeded');
    expect(screen.queryByText(/Amount to refund/)).toBeNull();
  });

  it('refunds after a PIN step-up, repeating the same request with the same key (J6)', async () => {
    let stepped = false;
    const api = fakeApi(
      routes('finance', ({ method, path, body }) => {
        if (method === 'GET') return intent('succeeded');
        if (path === '/v1/auth/step-up') {
          stepped = true;
          return { step_up_until: '2026-10-19T10:00:00Z', mode: 'sandbox' };
        }
        if (path === '/v1/payment-intents/pi_1/refunds') {
          expect(body).toEqual({ amount_minor: '25000', sandbox_scenario: 'success' });
          if (!stepped) throw new AoraApiError(403, 'step_up_required', 'PIN needed', null);
          return { id: 'rf_1', status: 'requested' };
        }
        throw new Error(`unexpected ${path}`);
      }),
    );
    renderWith(services(api), <CollectionScreen workspaceId={WS} intentId="pi_1" />);
    fireEvent.change(await screen.findByLabelText('Amount to refund (KES)'), {
      target: { value: '250' },
    });
    fireEvent.click(screen.getByText('Refund KES 250.00'));
    fireEvent.change(await screen.findByLabelText('Transaction PIN'), {
      target: { value: '482916' },
    });
    fireEvent.click(screen.getByText('Confirm with PIN'));
    expect(await screen.findByText(/Refund started/)).toBeTruthy();
    const keys = api.calls
      .filter((call) => call.path.endsWith('/refunds'))
      .map((call) => call.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });
});
