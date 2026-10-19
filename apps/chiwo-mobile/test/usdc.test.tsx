import { AoraApiError } from '@aora/api-client';
import { fakeApi, renderWith, services } from '@aora/mobile/testing';
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { NamScreen } from '../src/screens/nam';
import { RequestsScreen } from '../src/screens/requests';
import { SendScreen } from '../src/screens/send';
import { UsdcScreen } from '../src/screens/usdc';
import { routes } from './fixtures';

describe('USDC', () => {
  it('shows the balance with the token’s decimals, and says when the chain is off', async () => {
    renderWith(services(fakeApi(routes(() => undefined))), <UsdcScreen />);
    expect(await screen.findByText('USDC 12.500000')).toBeTruthy();
    expect(screen.getByText(/switched off here for now/)).toBeTruthy();
  });
});

describe('send to a person', () => {
  it('confirms a person with the PIN step-up before they can be paid', async () => {
    let stepped = false;
    let confirmed = false;
    const api = fakeApi(
      routes(({ method, path }) => {
        if (path === '/v1/chiwo/recipients' && method === 'GET')
          return {
            data: confirmed ? [{ id: 'rp_1', display_name: 'Wanjiru K.', confirmed: true }] : [],
          };
        if (path === '/v1/chiwo/recipients' && method === 'POST')
          return { id: 'rp_1', display_name: 'Wanjiru K.', confirmed: false };
        if (path === '/v1/auth/step-up') {
          stepped = true;
          return {};
        }
        if (path === '/v1/chiwo/recipients/rp_1/confirm') {
          if (!stepped) throw new AoraApiError(403, 'step_up_required', 'PIN', null);
          confirmed = true;
          return {};
        }
        throw new Error(path);
      }),
    );
    renderWith(services(api), <SendScreen />);
    fireEvent.change(await screen.findByLabelText('Their phone number'), {
      target: { value: '+254700000002' },
    });
    fireEvent.click(screen.getByText('Find'));
    fireEvent.click(await screen.findByText('Yes, confirm with my PIN'));
    fireEvent.change(await screen.findByLabelText('Transaction PIN'), {
      target: { value: '482916' },
    });
    fireEvent.click(screen.getByText('Confirm with PIN'));
    expect(await screen.findByRole('radio', { name: 'Wanjiru K.' })).toBeTruthy();
  });

  it('sends exact token units with an idempotency key', async () => {
    const api = fakeApi(
      routes(({ method, path }) => {
        if (path === '/v1/chiwo/recipients' && method === 'GET')
          return { data: [{ id: 'rp_1', display_name: 'Wanjiru K.', confirmed: true }] };
        if (path === '/v1/chiwo/transfers') return { id: 'tr_1' };
        throw new Error(path);
      }),
    );
    renderWith(services(api), <SendScreen />);
    fireEvent.click(await screen.findByText('Wanjiru K.'));
    fireEvent.change(screen.getByLabelText('Amount in USDC'), { target: { value: '2.5' } });
    fireEvent.click(screen.getByText('Send USDC 2.500000'));
    expect(await screen.findByText('Sent.')).toBeTruthy();
    const post = api.calls.find((call) => call.path === '/v1/chiwo/transfers');
    expect(post?.body).toEqual({ recipient_id: 'rp_1', amount_minor: '2500000' });
    expect(post?.idempotencyKey).toBeTruthy();
  });
});

describe('payment requests', () => {
  const request = (role: 'requester' | 'payer', status = 'open'): unknown => ({
    id: `rq_${role}`,
    role,
    status,
    amount_minor: '1000000',
    currency: 'USDC',
    note: 'Lunch',
    requester: { display_name: role === 'payer' ? 'Otieno' : 'You' },
    payer: role === 'payer' ? { display_name: 'You' } : null,
    expires_at: '2026-10-26T09:00:00Z',
    paid_transfer_id: null,
    created_at: '2026-10-19T09:00:00Z',
  });

  it('pays a request once, with a key, and offers no pay button to the requester', async () => {
    const api = fakeApi(
      routes(({ method, path }) => {
        if (path === '/v1/chiwo/requests' && method === 'GET')
          return { data: [request('payer'), request('requester')] };
        if (path === '/v1/chiwo/requests/rq_payer/pay') return {};
        throw new Error(path);
      }),
    );
    renderWith(services(api), <RequestsScreen />);
    const payButtons = await screen.findAllByText('Pay USDC 1.000000');
    expect(payButtons).toHaveLength(1);
    expect(screen.getByText('Cancel request')).toBeTruthy();
    fireEvent.click(payButtons[0] as HTMLElement);
    expect(await screen.findByText('Paid.')).toBeTruthy();
    const pay = api.calls.find((call) => call.path.endsWith('/pay'));
    expect(pay?.idempotencyKey).toBeTruthy();
  });

  it('shows the API’s refusal when the request was already paid', async () => {
    const api = fakeApi(
      routes(({ method, path }) => {
        if (path === '/v1/chiwo/requests' && method === 'GET') return { data: [request('payer')] };
        throw new AoraApiError(
          409,
          'invalid_state_transition',
          'This request is already paid.',
          null,
        );
      }),
    );
    renderWith(services(api), <RequestsScreen />);
    fireEvent.click(await screen.findByText('Pay USDC 1.000000'));
    expect(await screen.findByText('This request is already paid.')).toBeTruthy();
  });
});

describe('NAM', () => {
  it('shows funding, shares and holding separately and no yield', async () => {
    const api = fakeApi(
      routes(() => ({
        product: {
          name: 'NAM USDC Vault (sandbox)',
          kind: 'vault',
          asset: 'USDC',
          fee_bps: 0,
          returns_claimed: false,
          asset_control: 'A smart contract on Base Sepolia',
          customer_owns: 'A claim on vault shares',
          withdrawal_terms: 'Any time, after confirmation on chain',
          vault_address: '0x0',
          network: 'Base Sepolia',
        },
        disclosure: { key: 'nam', version: '1', title: 'NAM', body: '' },
        holding: { shares: '1000000', current_value_minor: '1000000', cost_minor: '1000000' },
        funding_pending_minor: '500000',
        note: '',
      })),
    );
    renderWith(services(api), <NamScreen />);
    expect(await screen.findByText('USDC 0.500000')).toBeTruthy();
    expect(screen.getByText('Vault shares held for you')).toBeTruthy();
    expect(screen.queryByText(/yield|APY|interest/i)).toBeNull();
  });
});
