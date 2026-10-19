import { AoraApiError } from '@aora/api-client';
import { fakeApi, renderWith, services } from '@aora/mobile/testing';
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { KeloScreen } from '../src/screens/kelo';
import { routes, WS } from './fixtures';

const dashboard = {
  currency: 'KES',
  orders_needing_action: { confirm: 1, fulfil: 0, respond_to_return: 1, total: 2 },
  bnpl_sales: { count: 3, gross_minor: '7200000' },
  settlements: {
    due: { count: 1, net_minor: '2328000' },
    paid: {
      count: 1,
      gross_minor: '2400000',
      fees_minor: '72000',
      clawback_netted_minor: '0',
      to_available_minor: '2328000',
    },
  },
  returns: { open: 1, accepted: 0, clawed_back_minor: '0', clawback_outstanding_minor: '0' },
  fees: { charged_minor: '216000', refunded_minor: '0', net_minor: '216000' },
};

function order(nextAction: string, claim: unknown = null): unknown {
  return {
    id: `pu_${nextAction}`,
    status: 'payment_ready',
    plan_status: 'active',
    plan_type: 'pay_in_n',
    listing_title: `Phone (${nextAction})`,
    total_minor: '2400000',
    paid_minor: '600000',
    merchant_fee_minor: '72000',
    net_minor: '2328000',
    currency: 'KES',
    next_action: nextAction,
    claim,
    created_at: '2026-10-19T09:00:00Z',
  };
}

const claim = {
  id: 'cl_1',
  purchase_id: 'pu_respond_to_return',
  kind: 'return',
  reason_code: 'faulty',
  details: 'Screen flickers',
  status: 'open',
  decided_as: null,
  decision_reason: null,
  created_at: '2026-10-19T09:00:00Z',
  decided_at: null,
};

describe('KELO in KONY mobile (K7, 9C)', () => {
  it('shows the dashboard figures from the API and no buyer credit data', async () => {
    const api = fakeApi(
      routes('admin', ({ path }) => {
        if (path === '/v1/workspace/kelo/dashboard') return dashboard;
        if (path === '/v1/workspace/kelo/purchases') return { data: [order('confirm')] };
        throw new Error(path);
      }),
    );
    renderWith(services(api), <KeloScreen workspaceId={WS} />);
    expect(await screen.findByText('Orders needing action: 2')).toBeTruthy();
    expect(screen.getByText('BNPL sales: 3, KES 72,000.00 gross')).toBeTruthy();
    expect(
      await screen.findByText('Sale KES 24,000.00 · fee KES 720.00 · net KES 23,280.00'),
    ).toBeTruthy();
    expect(screen.queryByText(/income|spread up to|reason_codes|bureau/i)).toBeNull();
  });

  it('confirms an order in the workspace', async () => {
    const api = fakeApi(
      routes('admin', ({ method, path }) => {
        if (path === '/v1/workspace/kelo/dashboard') return dashboard;
        if (path === '/v1/workspace/kelo/purchases' && method === 'GET')
          return { data: [order('confirm')] };
        if (path === '/v1/workspace/kelo/purchases/pu_confirm/confirm') return {};
        throw new Error(path);
      }),
    );
    renderWith(services(api), <KeloScreen workspaceId={WS} />);
    fireEvent.click(await screen.findByText('Confirm'));
    expect(await screen.findByText('Done.')).toBeTruthy();
  });

  it('accepts a return only after the PIN step-up', async () => {
    let stepped = false;
    let accepted = false;
    const api = fakeApi(
      routes('admin', ({ method, path }) => {
        if (path === '/v1/workspace/kelo/dashboard') return dashboard;
        if (path === '/v1/workspace/kelo/purchases' && method === 'GET')
          return { data: [order('respond_to_return', claim)] };
        if (path === '/v1/auth/step-up') {
          stepped = true;
          return {};
        }
        if (path === '/v1/workspace/kelo/claims/cl_1/accept') {
          if (!stepped) throw new AoraApiError(403, 'step_up_required', 'PIN', null);
          accepted = true;
          return {};
        }
        throw new Error(path);
      }),
    );
    renderWith(services(api), <KeloScreen workspaceId={WS} />);
    expect(await screen.findByText('Buyer’s words: Screen flickers')).toBeTruthy();
    fireEvent.click(screen.getByText('Accept the return (KES 23,280.00 clawed back)'));
    fireEvent.change(await screen.findByLabelText('Transaction PIN'), {
      target: { value: '482916' },
    });
    fireEvent.click(screen.getByText('Confirm with PIN'));
    await vi.waitFor(() => {
      expect(accepted).toBe(true);
    });
  });
});
