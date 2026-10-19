import { fakeApi, renderWith, services } from '@aora/mobile/testing';
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DecisionScreen } from '../src/screens/decision';
import { creditPlan, routes } from './fixtures';

function decision(outcome: 'approved' | 'declined'): unknown {
  return {
    id: 'de_1',
    outcome,
    reason_codes: outcome === 'declined' ? ['affordability'] : [],
    reasons:
      outcome === 'declined'
        ? ['The largest payment is more than a fair share of your income.']
        : [],
    listing_id: 'li_1',
    variant_id: 'va_1',
    session_id: null,
    plan: creditPlan,
    limit: { limit_minor: '5000000', limit_used_minor: '0', currency: 'KES' },
    lender_of_record: 'KELO simulated book (not licensed)',
    expires_at: '2026-10-19T12:00:00Z',
    created_at: '2026-10-19T09:00:00Z',
  };
}

describe('credit decision (K2, K6)', () => {
  it('explains a decline in plain words and charges nothing', async () => {
    const client = fakeApi(routes(() => decision('declined')));
    renderWith(services(client), <DecisionScreen decisionId="de_1" go={vi.fn()} />);
    expect(await screen.findByText(/more than a fair share/)).toBeTruthy();
    expect(screen.getByText(/Nothing was charged/)).toBeTruthy();
    expect(screen.queryByText(/Agree and pay/)).toBeNull();
    expect(client.calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('agrees in one tap, sending back the total payable and document versions shown', async () => {
    const go = vi.fn();
    const client = fakeApi(
      routes(({ method, path }) => {
        if (method === 'GET') return decision('approved');
        if (path === '/v1/kelo/purchases') return { id: 'pu_1' };
        if (path === '/v1/kelo/me/purchases/pu_1/credit/instalments/0/pay') return {};
        throw new Error(path);
      }),
    );
    renderWith(services(client), <DecisionScreen decisionId="de_1" go={go} />);
    // A limit is never a balance (kelo-experience.md §2).
    expect(
      await screen.findByText('You can spread up to KES 50,000.00 across your KELO plans.'),
    ).toBeTruthy();
    expect(screen.queryByText(/balance|available|funds/i)).toBeNull();
    fireEvent.click(screen.getByText(/AORA simulator/));
    fireEvent.click(screen.getByText('Agree and pay KES 2,400.00 now'));
    await vi.waitFor(() => {
      expect(go).toHaveBeenCalledWith('/purchases');
    });
    const purchase = client.calls.find((call) => call.path === '/v1/kelo/purchases');
    expect(purchase?.body).toEqual({
      decision_id: 'de_1',
      expected_total_payable_minor: '2475600',
      agreement_version: '1',
      kid_version: '1',
    });
  });
});
