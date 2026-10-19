import { AoraApiError, AoraNetworkError } from '@aora/api-client';
import { fakeApi, memoryStore, renderWith, services } from '@aora/mobile/testing';
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PaymentScreen } from '../src/screens/payment';
import { PayScreen } from '../src/screens/pay';
import { routes } from './fixtures';

const quote = {
  pay_code: 'AB12CD34',
  amount_minor: '15000',
  fee_minor: '0',
  total_minor: '15000',
  currency: 'KES',
  rail: 'mpesa',
  provider: 'simulator',
  payer_number: 'sandbox_test_number',
  timing: 'Instant',
  merchant: { code: 'AB12CD34', trading_name: 'Duka la Mama' },
};

async function review(): Promise<void> {
  fireEvent.change(await screen.findByLabelText(/Shop pay code/), {
    target: { value: 'ab12 cd34' },
  });
  fireEvent.change(screen.getByLabelText('Amount in KES'), { target: { value: '150' } });
  fireEvent.click(screen.getByText('Review payment'));
}

describe('pay a shop (J12)', () => {
  it('shows the shop, fee and total before paying, and sends back what was shown', async () => {
    const go = vi.fn();
    const api = fakeApi(
      routes(({ method, path }) => {
        if (path === '/v1/chiwo/payments/quote') return quote;
        if (method === 'POST' && path === '/v1/chiwo/payments') return { id: 'cp_1' };
        throw new Error(path);
      }),
    );
    renderWith(services(api), <PayScreen go={go} />);
    await review();
    expect(await screen.findByText('You are paying Duka la Mama')).toBeTruthy();
    expect(screen.getByText('None')).toBeTruthy();
    const pay = screen.getByText('Pay KES 150.00');
    fireEvent.click(pay);
    expect(api.calls.some((call) => call.path === '/v1/chiwo/payments')).toBe(false);
    fireEvent.click(screen.getByText(/AORA simulator/));
    fireEvent.click(pay);
    await vi.waitFor(() => {
      expect(go).toHaveBeenCalledWith('/payments/cp_1');
    });
    const quoteCall = api.calls.find((call) => call.path === '/v1/chiwo/payments/quote');
    expect(quoteCall?.body).toMatchObject({ pay_code: 'AB12CD34', amount_minor: '15000' });
    const post = api.calls.find((call) => call.path === '/v1/chiwo/payments');
    expect(post?.idempotencyKey).toBeTruthy();
    expect(post?.body).toMatchObject({
      expected_fee_minor: '0',
      expected_total_minor: '15000',
      sandbox_scenario: 'success',
    });
  });

  it('keeps the key through an unknown outcome and an app restart', async () => {
    const store = memoryStore();
    const failing = fakeApi(
      routes(({ path }) => {
        if (path === '/v1/chiwo/payments/quote') return quote;
        throw new AoraNetworkError('timeout');
      }),
    );
    const first = renderWith(services(failing, store), <PayScreen go={vi.fn()} />);
    await review();
    fireEvent.click(await screen.findByText(/M-Pesa sandbox/));
    fireEvent.click(screen.getByText('Pay KES 150.00'));
    await screen.findByText(/We are checking/);
    first.unmount();

    const go = vi.fn();
    const working = fakeApi(
      routes(({ path }) => (path === '/v1/chiwo/payments/quote' ? quote : { id: 'cp_1' })),
    );
    renderWith(services(working, store), <PayScreen go={go} />);
    await review();
    fireEvent.click(await screen.findByText(/M-Pesa sandbox/));
    fireEvent.click(screen.getByText('Pay KES 150.00'));
    await vi.waitFor(() => {
      expect(go).toHaveBeenCalled();
    });
    const before = failing.calls.find((call) => call.path === '/v1/chiwo/payments');
    const after = working.calls.find((call) => call.path === '/v1/chiwo/payments');
    expect(after?.idempotencyKey).toBe(before?.idempotencyKey);
  });

  it('shows an unknown shop code in the API’s words', async () => {
    const api = fakeApi(
      routes(() => {
        throw new AoraApiError(404, 'not_found', 'No shop has that pay code.', null);
      }),
    );
    renderWith(services(api), <PayScreen go={vi.fn()} />);
    await review();
    expect(await screen.findByText('No shop has that pay code.')).toBeTruthy();
  });
});

describe('payment status', () => {
  it('says the payment is being checked, never that it failed, while M-Pesa has not answered', async () => {
    const api = fakeApi(
      routes(() => ({
        id: 'cp_1',
        kind: 'merchant_payment',
        status: 'being_checked',
        amount_minor: '15000',
        fee_minor: '0',
        total_minor: '15000',
        currency: 'KES',
        rail: 'mpesa',
        merchant: { code: 'AB12CD34', trading_name: 'Duka la Mama' },
        reference: 'CHW-1',
        payer_number: 'sandbox_test_number',
        created_at: '2026-10-19T09:00:00Z',
        updated_at: '2026-10-19T09:00:00Z',
      })),
    );
    renderWith(services(api), <PaymentScreen paymentId="cp_1" />);
    expect(await screen.findByText('Being checked with M-Pesa')).toBeTruthy();
    expect(screen.getByText(/will not be sent twice/)).toBeTruthy();
    expect(screen.queryByText('Not paid')).toBeNull();
  });
});
