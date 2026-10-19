import { AoraNetworkError } from '@aora/api-client';
import { fakeApi, memoryStore, renderWith, services } from '@aora/mobile/testing';
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ListingScreen } from '../src/screens/listing';
import { creditPlan, layaway, listing, routes } from './fixtures';

function api(
  plans: unknown[],
  onPost: (path: string, key: string | undefined) => unknown = () => ({ id: 'pu_1' }),
) {
  return fakeApi(
    routes(({ method, path, idempotencyKey }) => {
      if (path === '/v1/kelo/marketplace/listings/li_1') return listing;
      if (path === '/v1/kelo/marketplace/listings/li_1/plans') return { data: plans };
      if (method === 'POST') return onPost(path, idempotencyKey);
      throw new Error(path);
    }),
  );
}

describe('listing and plans (K8)', () => {
  it('shows the plan card in order, with the total and every instalment from the API', async () => {
    renderWith(services(api([layaway])), <ListingScreen listingId="li_1" go={vi.fn()} />);
    expect(await screen.findByText('Total you will pay: KES 24,000.00')).toBeTruthy();
    expect(screen.getByText('Payment 3 on 2026-12-19: KES 8,000.00')).toBeTruthy();
    expect(screen.getByText(/You receive it after the last payment/)).toBeTruthy();
  });

  it('shows no credit plan and no credit words when the flag is off', async () => {
    renderWith(services(api([layaway])), <ListingScreen listingId="li_1" go={vi.fn()} />);
    await screen.findByText('Layaway in 3');
    expect(screen.queryByText(/credit|interest|APR|spread/i)).toBeNull();
  });

  it('requires a chosen way to pay, then buys and pays with keys that survive a restart', async () => {
    const store = memoryStore();
    const failing = api([layaway], (path) => {
      if (path === '/v1/kelo/purchases') return { id: 'pu_1' };
      throw new AoraNetworkError('timeout');
    });
    const first = renderWith(
      services(failing, store),
      <ListingScreen listingId="li_1" go={vi.fn()} />,
    );
    const agree = await screen.findByText('Agree and pay KES 8,000.00 now');
    fireEvent.click(agree);
    expect(failing.calls.some((call) => call.method === 'POST')).toBe(false);
    fireEvent.click(screen.getByText(/AORA simulator/));
    fireEvent.click(agree);
    await screen.findByText(/We are checking/);
    first.unmount();

    const go = vi.fn();
    const working = api([layaway]);
    renderWith(services(working, store), <ListingScreen listingId="li_1" go={go} />);
    fireEvent.click(await screen.findByText(/AORA simulator/));
    fireEvent.click(screen.getByText('Agree and pay KES 8,000.00 now'));
    await vi.waitFor(() => {
      expect(go).toHaveBeenCalledWith('/purchases');
    });
    const keys = (calls: typeof working.calls) =>
      calls.filter((call) => call.method === 'POST').map((call) => call.idempotencyKey);
    expect(keys(working.calls)).toEqual(keys(failing.calls));
    const purchase = working.calls.find((call) => call.path === '/v1/kelo/purchases');
    expect(purchase?.body).toMatchObject({
      variant_id: 'va_1',
      expected_total_minor: '2400000',
      terms_version: '3',
    });
  });

  it('asks for a credit decision with the declared income in exact minor units and an unticked bureau check', async () => {
    const go = vi.fn();
    const client = api([creditPlan], (path) =>
      path === '/v1/kelo/credit/decisions' ? { id: 'de_1' } : undefined,
    );
    renderWith(services(client), <ListingScreen listingId="li_1" go={go} />);
    expect(await screen.findByText('Total you will pay: KES 24,756.00')).toBeTruthy();
    expect(screen.getByRole('radio', { name: /credit bureau/ }).getAttribute('aria-checked')).toBe(
      'false',
    );
    fireEvent.change(screen.getByLabelText('Your monthly income, in KES'), {
      target: { value: '45000' },
    });
    fireEvent.click(screen.getByText('Check this plan'));
    await vi.waitFor(() => {
      expect(go).toHaveBeenCalledWith('/decision/de_1');
    });
    const post = client.calls.find((call) => call.path === '/v1/kelo/credit/decisions');
    expect(post?.body).toEqual({
      listing_id: 'li_1',
      variant_id: 'va_1',
      template_key: 'sandbox_monthly_6',
      declared_monthly_income_minor: '4500000',
    });
  });
});
