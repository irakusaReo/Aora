import { AoraApiError } from '@aora/api-client';
import { fakeApi, renderWith, services } from '@aora/mobile/testing';
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PurchasesScreen } from '../src/screens/purchases';
import { routes } from './fixtures';

function purchase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'pu_1',
    status: 'payment_ready',
    plan_status: 'active',
    plan_type: 'layaway',
    listing_id: 'li_1',
    listing_title: 'Holiday in Diani',
    total_minor: '2400000',
    paid_minor: '800000',
    currency: 'KES',
    receive_after_last_payment: true,
    instalments: [
      { seq: 1, due_on: '2026-10-19', amount_minor: '800000', status: 'paid' },
      { seq: 2, due_on: '2026-11-19', amount_minor: '800000', status: 'due' },
    ],
    refund: null,
    credit: null,
    claim: null,
    created_at: '2026-10-19T09:00:00Z',
    ...overrides,
  };
}

const flagOff = (): never => {
  throw new AoraApiError(404, 'not_found', 'Not found.', null);
};

describe('purchases hub', () => {
  it('shows a layaway plan as paid of total and pays the next instalment with a key', async () => {
    const client = fakeApi(
      routes(({ method, path }) => {
        if (path === '/v1/kelo/credit/limit') return flagOff();
        if (path === '/v1/kelo/me/purchases' && method === 'GET') return { data: [purchase()] };
        if (path === '/v1/kelo/me/purchases/pu_1/instalments/2/pay') return {};
        throw new Error(path);
      }),
    );
    renderWith(services(client), <PurchasesScreen go={vi.fn()} />);
    expect(await screen.findByText('KES 8,000.00 paid of KES 24,000.00')).toBeTruthy();
    // With credit off there is no limit card and no credit wording.
    expect(screen.queryByText(/spread/)).toBeNull();
    fireEvent.click(screen.getByText(/AORA simulator/));
    fireEvent.click(screen.getByText('Pay KES 8,000.00 now'));
    await vi.waitFor(() => {
      expect(client.calls.some((call) => call.path.endsWith('/instalments/2/pay'))).toBe(true);
    });
    const pay = client.calls.find((call) => call.path.endsWith('/instalments/2/pay'));
    expect(pay?.idempotencyKey).toBeTruthy();
    expect(pay?.body).toEqual({ sandbox_scenario: 'success' });
  });

  it('pauses a plan while a return is open: no payment offered (K5)', async () => {
    const client = fakeApi(
      routes(({ path }) => {
        if (path === '/v1/kelo/credit/limit') return flagOff();
        return {
          data: [
            purchase({
              claim: {
                id: 'cl_1',
                purchase_id: 'pu_1',
                kind: 'dispute',
                reason_code: 'faulty',
                details: null,
                status: 'open',
                decided_as: null,
                decision_reason: null,
                created_at: '2026-10-19T09:00:00Z',
                decided_at: null,
              },
            }),
          ],
        };
      }),
    );
    renderWith(services(client), <PurchasesScreen go={vi.fn()} />);
    expect(await screen.findByText(/Your plan is paused/)).toBeTruthy();
    expect(screen.queryByText(/Pay KES/)).toBeNull();
    expect(screen.getByText('Withdraw this request')).toBeTruthy();
  });

  it('opens a dispute with the chosen reason and a key', async () => {
    const client = fakeApi(
      routes(({ method, path }) => {
        if (path === '/v1/kelo/credit/limit') return flagOff();
        if (method === 'GET') return { data: [purchase()] };
        if (path === '/v1/kelo/me/purchases/pu_1/claims') return {};
        throw new Error(path);
      }),
    );
    renderWith(services(client), <PurchasesScreen go={vi.fn()} />);
    fireEvent.click(await screen.findByText('It is faulty'));
    fireEvent.click(screen.getByText('Report a problem with this purchase'));
    await vi.waitFor(() => {
      expect(client.calls.some((call) => call.path.endsWith('/claims'))).toBe(true);
    });
    const claim = client.calls.find((call) => call.path.endsWith('/claims'));
    expect(claim?.body).toEqual({ kind: 'dispute', reason_code: 'faulty' });
    expect(claim?.idempotencyKey).toBeTruthy();
  });

  it('pays off a credit plan early at the API’s quoted amount, with no penalty', async () => {
    const credit = {
      agreement_id: 'ag_1',
      status: 'active',
      plan_type: 'monthly_financing',
      lender_of_record: 'KELO simulated book (not licensed)',
      price_minor: '2400000',
      deposit_minor: '240000',
      principal_minor: '2160000',
      interest_total_minor: '75600',
      total_payable_minor: '2475600',
      daily_rate_text: '0.0667%',
      apr_text: '24.35%',
      checkout_seq: 0,
      late_charges: { fee_minor: '50000', total_cap_minor: '200000', grace_days: 3 },
      instalments: [
        {
          seq: 0,
          due_on: '2026-10-19',
          principal_minor: '240000',
          interest_minor: '0',
          amount_minor: '240000',
          late_charges_minor: '0',
          interest_waived_minor: '0',
          paid_minor: '240000',
          status: 'paid',
        },
        {
          seq: 1,
          due_on: '2026-11-19',
          principal_minor: '360000',
          interest_minor: '21600',
          amount_minor: '381600',
          late_charges_minor: '0',
          interest_waived_minor: '0',
          paid_minor: '0',
          status: 'due',
        },
      ],
      documents: { agreement: { key: 'a', version: '1' }, kid: { key: 'k', version: '1' } },
      created_at: '2026-10-19T09:00:00Z',
    };
    const client = fakeApi(
      routes(({ method, path, body }) => {
        if (path === '/v1/kelo/credit/limit')
          return {
            limit_minor: '5000000',
            limit_used_minor: '2160000',
            limit_unused_minor: '2840000',
            currency: 'KES',
            policy_version: 1,
          };
        if (path === '/v1/kelo/me/purchases' && method === 'GET')
          return { data: [purchase({ plan_type: 'monthly_financing', credit })] };
        if (path === '/v1/kelo/me/purchases/pu_1/credit/quote')
          return {
            as_of: '2026-10-25',
            currency: 'KES',
            next: null,
            payoff: {
              amount_minor: '2163000',
              principal_minor: '2160000',
              charges_minor: '0',
              interest_minor: '3000',
              waived_minor: '72600',
              no_penalty: true,
              lines: [],
            },
          };
        if (path === '/v1/kelo/me/purchases/pu_1/credit/repay') {
          expect(body).toEqual({
            kind: 'payoff',
            expected_amount_minor: '2163000',
            sandbox_scenario: 'success',
          });
          return {};
        }
        throw new Error(path);
      }),
    );
    renderWith(services(client), <PurchasesScreen go={vi.fn()} />);
    expect(
      await screen.findByText('You can spread up to KES 50,000.00 across your KELO plans.'),
    ).toBeTruthy();
    expect(screen.queryByText(/available|balance|funds/i)).toBeNull();
    const payOff = await screen.findByText('Pay everything now: KES 21,630.00');
    expect(
      screen.getByText(/You save KES 726.00 in interest, and there is no penalty/),
    ).toBeTruthy();
    const radios = screen.getAllByText(/AORA simulator/);
    fireEvent.click(radios[radios.length - 1] as HTMLElement);
    fireEvent.click(payOff);
    await vi.waitFor(() => {
      expect(client.calls.some((call) => call.path.endsWith('/credit/repay'))).toBe(true);
    });
  });
});
