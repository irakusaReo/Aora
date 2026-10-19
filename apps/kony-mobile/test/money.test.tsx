import { AoraApiError, AoraNetworkError } from '@aora/api-client';
import { fakeApi, renderWith, services } from '@aora/mobile/testing';
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MoneyScreen } from '../src/screens/money';
import { PayoutsScreen } from '../src/screens/payouts';
import { TreasuryScreen } from '../src/screens/treasury';
import { routes, WS } from './fixtures';

const balances = {
  data: [
    { account_type: 'merchant_collections_pending', currency: 'KES', balance_minor: '50000' },
    { account_type: 'merchant_available', currency: 'KES', balance_minor: '120000' },
    { account_type: 'merchant_payouts_in_flight', currency: 'KES', balance_minor: '0' },
  ],
};

describe('balances and settlements', () => {
  it('shows each balance on its own and never a total (CLAUDE.md rule 5)', async () => {
    const api = fakeApi(
      routes('finance', ({ path }) => (path === '/v1/ledger/balances' ? balances : { data: [] })),
    );
    renderWith(services(api), <MoneyScreen workspaceId={WS} />);
    expect(await screen.findByText('Collected, not yet settled')).toBeTruthy();
    expect(screen.getByText('KES 500.00')).toBeTruthy();
    expect(screen.getByText('KES 1,200.00')).toBeTruthy();
    expect(screen.queryByText('KES 1,700.00')).toBeNull();
    expect(screen.getByText(/never added together/)).toBeTruthy();
  });

  it('says it cannot reach AORA and offers a retry when the first read fails', async () => {
    let fail = true;
    const api = fakeApi(
      routes('finance', ({ path }) => {
        if (fail) throw new AoraNetworkError('network');
        return path === '/v1/ledger/balances' ? balances : { data: [] };
      }),
    );
    renderWith(services(api), <MoneyScreen workspaceId={WS} />);
    const retries = await screen.findAllByText('Try again');
    fail = false;
    for (const button of retries) fireEvent.click(button);
    expect(await screen.findByText('KES 500.00')).toBeTruthy();
  });
});

const recipient = {
  id: 'rc_1',
  label: 'Shop float',
  rail: 'mpesa',
  status: 'confirmed',
  phone_hint: '•••149',
  confirmed_at: '2026-10-18T00:00:00Z',
};
const payoutQuote = {
  amount_minor: '100000',
  fee_minor: '2300',
  total_minor: '102300',
  tariff_version_id: 'tv_9',
  tariff_version: 2,
};

describe('payouts (J6)', () => {
  it('previews the fee, then sends what was shown with an idempotency key', async () => {
    const api = fakeApi(
      routes('finance', ({ method, path }) => {
        if (path === '/v1/payout-recipients') return { data: [recipient] };
        if (path === '/v1/payouts' && method === 'GET') return { data: [] };
        if (path === '/v1/payouts/preview') return payoutQuote;
        if (path === '/v1/payouts' && method === 'POST') return { id: 'po_1', status: 'requested' };
        throw new Error(`unexpected ${path}`);
      }),
    );
    renderWith(services(api), <PayoutsScreen workspaceId={WS} />);
    fireEvent.change(await screen.findByLabelText(/Amount \(KES/), { target: { value: '1000' } });
    fireEvent.click(screen.getByText('See fee'));
    expect(await screen.findByText('KES 23.00')).toBeTruthy();
    expect(screen.getByText('KES 1,023.00')).toBeTruthy();
    fireEvent.click(screen.getByText('Send payout of KES 1,000.00'));
    expect(await screen.findByText(/Payout started/)).toBeTruthy();
    const post = api.calls.find((call) => call.method === 'POST' && call.path === '/v1/payouts');
    expect(post?.idempotencyKey).toBeTruthy();
    expect(post?.body).toMatchObject({
      recipient_id: 'rc_1',
      amount_minor: '100000',
      expected_fee_minor: '2300',
      tariff_version_id: 'tv_9',
    });
  });

  it('shows the API’s refusal when the fee changed', async () => {
    const api = fakeApi(
      routes('finance', ({ method, path }) => {
        if (path === '/v1/payout-recipients') return { data: [recipient] };
        if (path === '/v1/payouts' && method === 'GET') return { data: [] };
        if (path === '/v1/payouts/preview') return payoutQuote;
        throw new AoraApiError(409, 'fee_changed', 'The fee changed. Review it again.', null);
      }),
    );
    renderWith(services(api), <PayoutsScreen workspaceId={WS} />);
    fireEvent.change(await screen.findByLabelText(/Amount \(KES/), { target: { value: '1000' } });
    fireEvent.click(screen.getByText('See fee'));
    fireEvent.click(await screen.findByText('Send payout of KES 1,000.00'));
    expect(await screen.findByText('The fee changed. Review it again.')).toBeTruthy();
  });

  it('points to the web app when no recipient is confirmed', async () => {
    const api = fakeApi(routes('finance', () => ({ data: [] })));
    renderWith(services(api), <PayoutsScreen workspaceId={WS} />);
    expect(await screen.findByText(/on the web app first/)).toBeTruthy();
  });
});

describe('treasury (J9)', () => {
  const treasury = {
    network: { name: 'base-sepolia', label: 'Base Sepolia', chain_id: 84532 },
    deposit_address: '0xabc',
    wallet_label: 'AORA sandbox wallet',
    asset: { code: 'USDC', decimals: 6, contract: '0x036c' },
    balances: { available_minor: '2500000', withdrawals_in_flight_minor: '0' },
    explorer_url: 'https://sepolia.basescan.org',
    note: '',
  };

  it('shows USDC with the token’s own decimals and approves a withdrawal', async () => {
    let approved = false;
    const api = fakeApi(
      routes('admin', ({ method, path }) => {
        if (path === '/v1/treasury') return treasury;
        if (path === '/v1/treasury/withdrawals' && method === 'GET')
          return {
            data: [
              {
                id: 'wd_1',
                amount_minor: '1000000',
                currency: 'USDC',
                destination: '0xdef',
                status: approved ? 'submitted' : 'requested',
                created_by: 'acc_2',
                decided_by: null,
                tx_hash: null,
                created_at: '2026-10-19T09:00:00Z',
              },
            ],
          };
        if (path === '/v1/treasury/withdrawals/wd_1/approval') {
          approved = true;
          return {};
        }
        throw new Error(`unexpected ${path}`);
      }),
    );
    renderWith(services(api), <TreasuryScreen workspaceId={WS} />);
    expect(await screen.findByText('USDC 2.500000')).toBeTruthy();
    fireEvent.click(await screen.findByText('Approve and send'));
    expect(await screen.findByText(/Approved\. It completes/)).toBeTruthy();
  });

  it('shows the API’s words when the chain is switched off', async () => {
    const api = fakeApi(() => {
      throw new AoraApiError(503, 'chain_unavailable', 'The chain is not configured.', null);
    });
    renderWith(services(api), <TreasuryScreen workspaceId={WS} />);
    expect(await screen.findByText('The chain is not configured.')).toBeTruthy();
  });
});
