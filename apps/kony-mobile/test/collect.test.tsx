import { AoraNetworkError } from '@aora/api-client';
import { fakeApi, renderWith, services } from '@aora/mobile/testing';
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CollectScreen, DARAJA_TEST_NUMBER } from '../src/screens/collect';
import { routes, WS } from './fixtures';

const quote = {
  amount_minor: '15050',
  fee_minor: '150',
  net_minor: '14900',
  tariff_version_id: 'tv_1',
  tariff_version: 3,
};

function collectApi(onCollect: () => unknown = () => ({ id: 'pi_1', status: 'submitting' })) {
  return fakeApi(
    routes('cashier', (call) => {
      if (call.path === '/v1/tariffs/quote') return quote;
      if (call.method === 'POST' && call.path === '/v1/payment-intents') return onCollect();
      throw new Error(`unexpected ${call.path}`);
    }),
  );
}

async function review(amount: string): Promise<void> {
  fireEvent.change(await screen.findByLabelText('Amount (KES)'), { target: { value: amount } });
  fireEvent.click(screen.getByText('See fee'));
}

describe('collect (J4)', () => {
  it('converts the typed amount exactly and shows gross, fee and net before collecting', async () => {
    const api = collectApi();
    renderWith(services(api), <CollectScreen workspaceId={WS} go={vi.fn()} />);
    await review('150.50');
    expect(await screen.findByText('KES 150.50')).toBeTruthy();
    expect(screen.getByText('KES 1.50')).toBeTruthy();
    expect(screen.getByText('KES 149.00')).toBeTruthy();
    const quoteCall = api.calls.find((call) => call.path === '/v1/tariffs/quote');
    expect(quoteCall?.query?.['amount_minor']).toBe('15050');
  });

  it('refuses an amount more precise than the currency instead of rounding it', async () => {
    const api = collectApi();
    renderWith(services(api), <CollectScreen workspaceId={WS} go={vi.fn()} />);
    await review('150.505');
    expect(await screen.findByText(/Enter an amount such as 150/)).toBeTruthy();
    expect(api.calls.some((call) => call.path === '/v1/tariffs/quote')).toBe(false);
  });

  it('collects by STK push to the Daraja test number with an idempotency key, then opens it', async () => {
    const go = vi.fn();
    const api = collectApi();
    renderWith(services(api), <CollectScreen workspaceId={WS} go={go} />);
    await review('150.50');
    fireEvent.click(await screen.findByText('Collect KES 150.50'));
    await vi.waitFor(() => {
      expect(go).toHaveBeenCalledWith(`/w/${WS}/collection/pi_1`);
    });
    const post = api.calls.find((call) => call.method === 'POST');
    expect(post?.idempotencyKey).toBeTruthy();
    expect(post?.body).toMatchObject({
      amount_minor: '15050',
      currency: 'KES',
      rail: 'mpesa',
      payer_phone: DARAJA_TEST_NUMBER,
    });
  });

  it('sends a simulator scenario and no phone number when one is chosen', async () => {
    const api = collectApi();
    renderWith(services(api), <CollectScreen workspaceId={WS} go={vi.fn()} />);
    fireEvent.click(await screen.findByText('AORA simulator: decline'));
    await review('10');
    fireEvent.click(await screen.findByText('Collect KES 150.50'));
    await vi.waitFor(() => {
      expect(api.calls.some((call) => call.method === 'POST')).toBe(true);
    });
    const post = api.calls.find((call) => call.method === 'POST');
    expect(post?.body).toMatchObject({ sandbox_scenario: 'decline' });
    expect(post?.body).not.toHaveProperty('payer_phone');
  });

  it('says "we are checking" after a timeout, and checks again with the same key', async () => {
    let attempts = 0;
    const go = vi.fn();
    const api = collectApi(() => {
      attempts += 1;
      if (attempts === 1) throw new AoraNetworkError('timeout');
      return { id: 'pi_1', status: 'pending_provider' };
    });
    renderWith(services(api), <CollectScreen workspaceId={WS} go={go} />);
    await review('150.50');
    fireEvent.click(await screen.findByText('Collect KES 150.50'));
    await screen.findByText(/We are checking/);
    expect(go).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Check again'));
    await vi.waitFor(() => {
      expect(go).toHaveBeenCalled();
    });
    const keys = api.calls
      .filter((call) => call.method === 'POST')
      .map((call) => call.idempotencyKey);
    expect(keys[1]).toBe(keys[0]);
  });
});
