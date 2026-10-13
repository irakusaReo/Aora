import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SimulatorProvider } from '../src/modules/payments/simulator.js';
import { type Harness, startHarness } from './support/harness.js';
import { type Caller, createIntent, exceptionTypes, statusOf } from './support/payments.js';

let h: Harness;
let admin: Caller;
let operator: string;
let simulator: SimulatorProvider;

beforeAll(async () => {
  h = await startHarness({
    config: (config) => ({
      ...config,
      payments: { ...config.payments, stuckUnknownAfterSeconds: 60 },
    }),
  });
  admin = { token: await h.signIn('adminA'), workspace: h.seed.tenantA };
  operator = await h.signIn('operator');
  simulator = h.app.get(SimulatorProvider);
});
afterAll(() => h.close());

async function pay(scenario: string, amount: string): Promise<string> {
  const response = await createIntent(h, admin, {
    amount_minor: amount,
    currency: 'KES',
    sandbox_scenario: scenario,
  });
  await h.settle();
  return response.body.id as string;
}

const run = () =>
  h.http().post('/v1/ops/reconciliation-runs').set('Authorization', `Bearer ${operator}`);

const fingerprint = (): Promise<unknown> =>
  h.owner(async (client) => {
    const result = await client.query(`
      select
        (select coalesce(string_agg(id::text || status, ',' order by id), '') from payments.payment_intent) as intents,
        (select count(*) from ledger.journal_entry) as entries,
        (select count(*) from ledger.posting) as postings,
        (select coalesce(string_agg(account_id::text || balance::text, ',' order by account_id), '')
           from ledger.account_balance) as balances`);
    return result.rows[0];
  });

describe('reconciliation', () => {
  it('reports nothing when the provider, the intents and the ledger agree', async () => {
    await pay('success', '1000');
    await pay('success', '2500');
    await pay('decline', '700');
    const response = await run();
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      lines_checked: 2,
      intents_checked: 2,
      exceptions_opened: 0,
      mode: 'sandbox',
    });
    expect(await exceptionTypes(h)).toEqual([]);
  });

  it('detects each kind of difference, exactly once, and corrects nothing', async () => {
    const missingLine = await pay('missing_settlement_line', '4000');
    const duplicated = await pay('success', '6000');
    await simulator.duplicateSettlementLine(duplicated);
    const orphanRef = await simulator.injectOrphanTransaction(9900n);
    const unknown = await pay('timeout_then_success', '1200');

    const before = await fingerprint();
    const response = await run();
    expect(response.status).toBe(201);

    expect(await exceptionTypes(h, missingLine)).toEqual(['missing_at_provider']);
    const duplicateRef = await h.owner(async (client) => {
      const result = await client.query<{ id: string }>(
        `select id from sim.sim_transaction where operation_ref = $1`,
        [duplicated],
      );
      return result.rows[0]?.id ?? '';
    });
    expect(await exceptionTypes(h, duplicateRef)).toEqual(['duplicate_reference']);
    const orphan = await h.owner(async (client) => {
      const result = await client.query<{ id: string }>(
        `select id from sim.sim_transaction where operation_ref = $1`,
        [orphanRef],
      );
      return result.rows[0]?.id ?? '';
    });
    expect(await exceptionTypes(h, orphan)).toEqual(['missing_internal']);
    // The provider settled it while AORA still does not know the outcome.
    expect(await exceptionTypes(h, unknown)).toContain('state_mismatch');

    expect(await fingerprint()).toEqual(before);
    expect(await statusOf(h, admin, unknown)).toBe('status_unknown');
  });

  it('flags an intent stuck in status_unknown past the threshold', async () => {
    const stuck = await pay('timeout_then_failure', '800');
    // updated_at is maintained by a trigger, so switch it off briefly to age the row.
    await h.owner((client) =>
      client.query(`alter table payments.payment_intent disable trigger payment_intent_protect`),
    );
    await h.owner((client) =>
      client.query(
        `update payments.payment_intent set updated_at = now() - interval '10 minutes' where id = $1`,
        [stuck],
      ),
    );
    await h.owner((client) =>
      client.query(`alter table payments.payment_intent enable trigger payment_intent_protect`),
    );
    await run();
    expect(await exceptionTypes(h, stuck)).toEqual(['stuck_status_unknown']);
  });

  it('detects a successful intent whose ledger entry is missing', async () => {
    const id = await pay('success', '1500');
    // Forge an inconsistent state that the application itself can never produce.
    await h.owner((client) =>
      client.query(
        `insert into payments.payment_intent
           (tenant_id, idempotency_key, request_hash, amount, asset_code, status, provider, created_by)
         select tenant_id, 'forged', 'x', amount, asset_code, 'succeeded', provider, created_by
         from payments.payment_intent where id = $1`,
        [id],
      ),
    );
    const forged = await h.owner(async (client) => {
      const result = await client.query<{ id: string }>(
        `select id from payments.payment_intent where idempotency_key = 'forged'`,
      );
      return result.rows[0]?.id ?? '';
    });
    await run();
    expect(await exceptionTypes(h, forged)).toEqual(['ledger_mismatch', 'missing_at_provider']);
  });

  it('does not open the same exception again when run repeatedly', async () => {
    const before = await exceptionTypes(h);
    const response = await run();
    expect(response.body.exceptions_opened).toBe(0);
    expect(await exceptionTypes(h)).toEqual(before);
  });

  it('lets an operator list and inspect exceptions, and nobody else', async () => {
    const list = await h
      .http()
      .get('/v1/ops/reconciliation-exceptions')
      .set('Authorization', `Bearer ${operator}`);
    expect(list.status).toBe(200);
    expect(list.body.mode).toBe('sandbox');
    expect(list.body.data.length).toBeGreaterThanOrEqual(5);
    const first = list.body.data[0];
    expect(first).toMatchObject({
      status: 'open',
      type: expect.any(String),
      id: expect.any(String),
    });

    const one = await h
      .http()
      .get(`/v1/ops/reconciliation-exceptions/${first.id}`)
      .set('Authorization', `Bearer ${operator}`);
    expect(one.status).toBe(200);
    expect(one.body.id).toBe(first.id);

    const asMerchant = await h
      .http()
      .get(`/v1/ops/reconciliation-exceptions/${first.id}`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(asMerchant.status).toBe(403);
    expect((await h.http().get('/v1/ops/reconciliation-exceptions')).status).toBe(401);

    await expect(
      h.db.withTenant(h.seed.tenantA, (tx) => tx.reconciliation_exception.findMany()),
    ).rejects.toThrow(/permission denied/);
  });

  it('audits each run', async () => {
    const audits = await h.owner((client) =>
      client.query(
        `select count(*) as n from audit.audit_event
         where action = 'payments.reconciliation.run' and actor_account_id = $1`,
        [h.seed.accounts.operator],
      ),
    );
    expect(Number(audits.rows[0]?.n)).toBeGreaterThanOrEqual(5);
  });
});
