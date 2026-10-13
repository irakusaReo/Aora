import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LedgerService } from '../src/modules/ledger/ledger.service.js';
import { SimulatorProvider } from '../src/modules/payments/simulator.js';
import { type Harness, startHarness } from './support/harness.js';
import {
  type Caller,
  createIntent,
  exceptionTypes,
  ledgerFor,
  statusOf,
  transitionsOf,
} from './support/payments.js';

let h: Harness;
let admin: Caller;
let simulator: SimulatorProvider;

beforeAll(async () => {
  h = await startHarness({
    config: (config) => ({
      ...config,
      outbox: { maxAttempts: 5, retryDelaySeconds: 0 },
      payments: { ...config.payments, maxStatusInquiries: 2 },
    }),
  });
  admin = { token: await h.signIn('adminA'), workspace: h.seed.tenantA };
  simulator = h.app.get(SimulatorProvider);
});
afterAll(() => h.close());

async function start(scenario: string, amount = '15000'): Promise<string> {
  const response = await createIntent(h, admin, {
    amount_minor: amount,
    currency: 'KES',
    sandbox_scenario: scenario,
  });
  expect(response.status).toBe(201);
  return response.body.id as string;
}

const merchantBalance = (): Promise<string> =>
  h.owner(async (client) => {
    const result = await client.query<{ balance: string }>(
      `select coalesce(sum(b.balance), 0) as balance from ledger.account_balance b
       join ledger.account a on a.id = b.account_id
       where a.tenant_id = $1 and a.type = 'merchant_collections_pending'`,
      [h.seed.tenantA],
    );
    return result.rows[0]?.balance ?? '';
  });

describe('end to end: sign in, intent, webhook, ledger, reconciliation', () => {
  it('collects a payment and posts one balanced entry to the merchant', async () => {
    const before = BigInt(await merchantBalance());
    const id = await start('success');
    expect(await statusOf(h, admin, id)).toBe('created');
    expect(await ledgerFor(h, id)).toEqual({ entries: 0, credited: '0' });

    await h.settle();

    expect(await statusOf(h, admin, id)).toBe('succeeded');
    expect(await transitionsOf(h, id)).toEqual([
      'created',
      'submitting',
      'pending_provider',
      'succeeded',
    ]);
    expect(await ledgerFor(h, id)).toEqual({ entries: 1, credited: '15000' });
    expect(BigInt(await merchantBalance()) - before).toBe(15000n);

    const postings = await h.owner((client) =>
      client.query(
        `select a.type, a.tenant_id, p.direction, p.amount, p.mode
         from ledger.posting p join ledger.account a on a.id = p.account_id
         join ledger.journal_entry e on e.id = p.entry_id
         where e.operation_id = $1 order by p.direction desc`,
        [id],
      ),
    );
    expect(postings.rows).toEqual([
      {
        type: 'provider_clearing',
        tenant_id: null,
        direction: 'debit',
        amount: '15000',
        mode: 'sandbox',
      },
      {
        type: 'merchant_collections_pending',
        tenant_id: h.seed.tenantA,
        direction: 'credit',
        amount: '15000',
        mode: 'sandbox',
      },
    ]);
    expect(await exceptionTypes(h, id)).toEqual([]);
  });
});

describe('provider outcomes', () => {
  it('fails on a decline and posts nothing', async () => {
    const id = await start('decline');
    await h.settle();
    expect(await statusOf(h, admin, id)).toBe('failed');
    expect(await ledgerFor(h, id)).toEqual({ entries: 0, credited: '0' });
  });

  it('has one effect when the provider sends the same webhook twice', async () => {
    const id = await start('duplicate_webhook', '2000');
    await h.settle();
    expect(await statusOf(h, admin, id)).toBe('succeeded');
    expect(await ledgerFor(h, id)).toEqual({ entries: 1, credited: '2000' });
    const stored = await h.owner((client) =>
      client.query(
        `select count(*) as n from payments.webhook_event where payload_raw::jsonb->>'operation_ref' = $1`,
        [id],
      ),
    );
    expect(stored.rows[0]?.n).toBe('1');
  });

  it('sends a late success after a recorded failure to reconciliation, without overwriting or posting', async () => {
    const id = await start('late_webhook');
    await h.settle();
    expect(await statusOf(h, admin, id)).toBe('reconciliation_required');
    expect(await transitionsOf(h, id)).toEqual([
      'created',
      'submitting',
      'pending_provider',
      'failed',
      'reconciliation_required',
    ]);
    expect(await ledgerFor(h, id)).toEqual({ entries: 0, credited: '0' });
    expect(await exceptionTypes(h, id)).toEqual(['provider_result_conflict']);
  });

  it('refuses to post when the provider reports a different amount', async () => {
    const id = await start('amount_mismatch', '5000');
    await h.settle();
    expect(await statusOf(h, admin, id)).toBe('reconciliation_required');
    expect(await ledgerFor(h, id)).toEqual({ entries: 0, credited: '0' });
    expect(await exceptionTypes(h, id)).toEqual(['amount_mismatch']);
  });
});

describe('unknown state', () => {
  it('on a timeout: marks status_unknown, posts nothing, never calls the provider again, then resolves once', async () => {
    const collect = vi.spyOn(simulator, 'collect');
    const id = await start('timeout_then_success', '7000');
    await h.settle();

    expect(await statusOf(h, admin, id)).toBe('status_unknown');
    expect(await ledgerFor(h, id)).toEqual({ entries: 0, credited: '0' });
    expect(collect).toHaveBeenCalledTimes(1);

    // The inquiry is scheduled for later; nothing more happens until it is due.
    await h.settle();
    expect(await statusOf(h, admin, id)).toBe('status_unknown');

    await h.makeDelayedEventsDue();
    await h.settle();
    expect(await statusOf(h, admin, id)).toBe('succeeded');
    expect(await ledgerFor(h, id)).toEqual({ entries: 1, credited: '7000' });

    await h.makeDelayedEventsDue();
    await h.settle();
    expect(await ledgerFor(h, id)).toEqual({ entries: 1, credited: '7000' });
    expect(collect).toHaveBeenCalledTimes(1);
    expect(await transitionsOf(h, id)).toEqual([
      'created',
      'submitting',
      'status_unknown',
      'succeeded',
    ]);
    collect.mockRestore();
  });

  it('resolves to failed when the inquiry says the provider refused', async () => {
    const id = await start('timeout_then_failure');
    await h.settle();
    expect(await statusOf(h, admin, id)).toBe('status_unknown');
    await h.makeDelayedEventsDue();
    await h.settle();
    expect(await statusOf(h, admin, id)).toBe('failed');
    expect(await ledgerFor(h, id)).toEqual({ entries: 0, credited: '0' });
  });

  it('after an interrupted submission: does not call the provider again, and escalates when inquiries run out', async () => {
    const id = await start('success', '900');
    // Simulate a worker that committed `submitting` and died before recording the provider's answer.
    await h.owner((client) =>
      client.query(`update payments.payment_intent set status = 'submitting' where id = $1`, [id]),
    );
    const collect = vi.spyOn(simulator, 'collect');
    await h.settle();
    expect(collect).not.toHaveBeenCalled();
    expect(await statusOf(h, admin, id)).toBe('status_unknown');

    // The provider has no record of it, so each inquiry is inconclusive.
    for (let i = 0; i < 2; i += 1) {
      await h.makeDelayedEventsDue();
      await h.settle();
    }
    expect(await statusOf(h, admin, id)).toBe('reconciliation_required');
    expect(await exceptionTypes(h, id)).toEqual(['stuck_status_unknown']);
    expect(await ledgerFor(h, id)).toEqual({ entries: 0, credited: '0' });
    expect(collect).not.toHaveBeenCalled();
    collect.mockRestore();
  });
});

describe('atomicity', () => {
  it('leaves neither the status change nor the entry if posting fails, then completes once on retry', async () => {
    const ledger = h.app.get(LedgerService);
    const post = vi.spyOn(ledger, 'post').mockRejectedValueOnce(new Error('crash while posting'));
    const id = await start('success', '3300');

    await h.settle();

    expect(post).toHaveBeenCalledTimes(2);
    expect(await statusOf(h, admin, id)).toBe('succeeded');
    expect(await ledgerFor(h, id)).toEqual({ entries: 1, credited: '3300' });
    // The failed attempt left no trace: exactly one `succeeded` transition exists.
    expect((await transitionsOf(h, id)).filter((status) => status === 'succeeded')).toHaveLength(1);
    post.mockRestore();
  });

  it('never shows succeeded without its journal entry, or an entry without succeeded', async () => {
    const result = await h.owner((client) =>
      client.query<{ succeeded_without_entry: string; entry_without_succeeded: string }>(`
        select
          (select count(*) from payments.payment_intent i
            where i.status = 'succeeded' and not exists (
              select from ledger.journal_entry e
              where e.operation_type = 'payment_intent' and e.operation_id = i.id::text)) as succeeded_without_entry,
          (select count(*) from ledger.journal_entry e
            join payments.payment_intent i on i.id::text = e.operation_id
            where e.operation_type = 'payment_intent' and i.status <> 'succeeded') as entry_without_succeeded`),
    );
    expect(result.rows[0]).toEqual({ succeeded_without_entry: '0', entry_without_succeeded: '0' });
  });

  it('keeps the whole ledger balanced after every scenario above', async () => {
    const result = await h.owner((client) =>
      client.query<{ trial_balance: string }>(
        `select coalesce(sum(case when direction = 'debit' then amount else -amount end), 0) as trial_balance
         from ledger.posting`,
      ),
    );
    expect(result.rows[0]?.trial_balance).toBe('0');
  });
});
