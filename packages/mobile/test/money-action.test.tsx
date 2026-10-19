import { AoraApiError, AoraNetworkError } from '@aora/api-client';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { Text } from 'react-native';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup } from '@testing-library/react';
import { Button } from '../src/components';
import { MoneyActionView, useMoneyAction } from '../src/money-action';
import { fakeApi, memoryStore, renderWith, services } from '../src/testing';

// The hook every money action on a device goes through (phase-9 P9-7, P9-8).
// Written first: idempotency, unknown outcomes and step-up.

afterEach(cleanup);

function PayoutButton({ onDone }: { onDone?: (id: string) => void }): React.JSX.Element {
  const action = useMoneyAction<{ id: string }>({
    slot: 'kony.payout:r1:5000',
    run: (api, key) => api.post('/v1/payouts', { recipient_id: 'r1' }, key),
    onDone: (result) => onDone?.(result.id),
  });
  return (
    <>
      <Button label="Send payout" onPress={action.start} />
      <MoneyActionView action={action} />
      {action.state === 'done' && <Text>Sent</Text>}
    </>
  );
}

describe('money action', () => {
  it('sends a key, and the same key when the person checks again after a timeout', async () => {
    let attempts = 0;
    const api = fakeApi(({ path }) => {
      if (path !== '/v1/payouts') throw new Error('unexpected');
      attempts += 1;
      if (attempts === 1) throw new AoraNetworkError('timeout');
      return { id: 'po_1' };
    });
    renderWith(services(api), <PayoutButton />);
    fireEvent.click(screen.getByText('Send payout'));
    await screen.findByText(/We are checking/);
    expect(screen.queryByText(/failed/i)).toBeNull();
    fireEvent.click(screen.getByText('Check again'));
    await screen.findByText('Sent');
    const keys = api.calls.map((call) => call.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });

  it('reuses the saved key after the app restarts while the outcome was unknown', async () => {
    const store = memoryStore();
    const failing = fakeApi(() => {
      throw new AoraNetworkError('network');
    });
    const first = renderWith(services(failing, store), <PayoutButton />);
    fireEvent.click(screen.getByText('Send payout'));
    await screen.findByText(/We are checking/);
    first.unmount();

    // A new process: a new services object over the same secure storage.
    const working = fakeApi(() => ({ id: 'po_1' }));
    renderWith(services(working, store), <PayoutButton />);
    fireEvent.click(screen.getByText('Send payout'));
    await screen.findByText('Sent');
    expect(working.calls[0]?.idempotencyKey).toBe(failing.calls[0]?.idempotencyKey);
  });

  it('releases the key once the API has answered, so the next payout is a new one', async () => {
    const store = memoryStore();
    const api = fakeApi(() => ({ id: 'po_1' }));
    renderWith(services(api, store), <PayoutButton />);
    fireEvent.click(screen.getByText('Send payout'));
    await screen.findByText('Sent');
    expect(store.entries.size).toBe(0);
  });

  it('shows a refusal in the API’s words and releases the key', async () => {
    const store = memoryStore();
    const api = fakeApi(() => {
      throw new AoraApiError(409, 'fee_changed', 'The fee changed. Review it again.', null);
    });
    renderWith(services(api, store), <PayoutButton />);
    fireEvent.click(screen.getByText('Send payout'));
    await screen.findByText('The fee changed. Review it again.');
    expect(store.entries.size).toBe(0);
  });

  it('asks for the PIN on a step-up, then repeats the same request with the same key', async () => {
    let stepped = false;
    const api = fakeApi(({ path, body }) => {
      if (path === '/v1/auth/step-up') {
        expect(body).toEqual({ pin: '482916' });
        stepped = true;
        return { step_up_until: '2026-10-19T12:00:00Z', mode: 'sandbox' };
      }
      if (!stepped) throw new AoraApiError(403, 'step_up_required', 'PIN needed', null);
      return { id: 'po_1' };
    });
    renderWith(services(api), <PayoutButton />);
    fireEvent.click(screen.getByText('Send payout'));
    const pin = await screen.findByLabelText('Transaction PIN');
    fireEvent.change(pin, { target: { value: '482916' } });
    await act(async () => {
      fireEvent.click(screen.getByText('Confirm with PIN'));
      await Promise.resolve();
    });
    await screen.findByText('Sent');
    const payoutKeys = api.calls
      .filter((call) => call.path === '/v1/payouts')
      .map((call) => call.idempotencyKey);
    expect(payoutKeys).toHaveLength(2);
    expect(payoutKeys[1]).toBe(payoutKeys[0]);
  });

  it('does not start a second request while one is in flight', async () => {
    let release: (value: { id: string }) => void = () => undefined;
    const api = fakeApi(() => new Promise<{ id: string }>((resolve) => (release = resolve)));
    renderWith(services(api), <PayoutButton />);
    fireEvent.click(screen.getByText('Send payout'));
    fireEvent.click(screen.getByText('Send payout'));
    await waitFor(() => {
      expect(api.calls).toHaveLength(1);
    });
    release({ id: 'po_1' });
    await screen.findByText('Sent');
  });
});
