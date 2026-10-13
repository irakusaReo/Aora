import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SimulatorProvider } from '../src/modules/payments/simulator.js';
import { SEED_PHONES } from '../src/seed-data.js';
import { type Harness, startHarness } from './support/harness.js';
import { createIntent } from './support/payments.js';

let h: Harness;
let operator: string;
let admin: string;

beforeAll(async () => {
  h = await startHarness();
  operator = await h.signIn('operator');
  admin = await h.signIn('adminA');
});
afterAll(() => h.close());

const ops = (token: string, method: 'get' | 'post', path: string): import('supertest').Test =>
  h.http()[method](path).set('Authorization', `Bearer ${token}`);

const auditCount = async (action: string): Promise<number> =>
  h.owner(async (client) =>
    Number(
      (
        await client.query(`select count(*) as n from audit.audit_event where action = $1`, [
          action,
        ])
      ).rows[0].n,
    ),
  );

describe('working a reconciliation exception (journey J5)', () => {
  const opened: Record<string, string> = {};

  it('lists and shows each kind of exception the simulator can cause', async () => {
    const caller = { token: admin, workspace: h.seed.tenantA };
    const simulator = h.app.get(SimulatorProvider);
    await createIntent(h, caller, {
      amount_minor: '3000',
      currency: 'KES',
      sandbox_scenario: 'amount_mismatch',
    });
    await createIntent(h, caller, {
      amount_minor: '3100',
      currency: 'KES',
      sandbox_scenario: 'missing_settlement_line',
    });
    await createIntent(h, caller, {
      amount_minor: '3200',
      currency: 'KES',
      sandbox_scenario: 'late_webhook',
    });
    const paid = await createIntent(h, caller, { amount_minor: '3300', currency: 'KES' });
    await h.settle();
    await simulator.injectOrphanTransaction(999n);
    await simulator.duplicateSettlementLine(paid.body.id as string);
    await ops(operator, 'post', '/v1/ops/reconciliation-runs');

    const list = await ops(operator, 'get', '/v1/ops/reconciliation-exceptions');
    expect(list.status).toBe(200);
    for (const row of list.body.data as { id: string; type: string; status: string }[]) {
      expect(row.status).toBe('open');
      opened[row.type] = row.id;
    }
    expect(Object.keys(opened).sort()).toEqual(
      [
        'amount_mismatch',
        'duplicate_reference',
        'missing_at_provider',
        'missing_internal',
        'provider_result_conflict',
        'state_mismatch',
      ].sort(),
    );
    for (const id of Object.values(opened)) {
      const one = await ops(operator, 'get', `/v1/ops/reconciliation-exceptions/${id}`);
      expect(one.body).toMatchObject({ id, status: 'open', resolution: null });
    }
  });

  it('resolves each with an audited reason, exactly once, and changes no money', async () => {
    const ledgerBefore = await h.owner((client) =>
      client.query(`select count(*)::int as n from ledger.posting`),
    );
    const resolve = (id: string, body: object): Promise<Response> =>
      ops(operator, 'post', `/v1/ops/reconciliation-exceptions/${id}/resolution`).send(body);

    const first = Object.values(opened)[0] ?? '';
    expect((await resolve(first, { resolution: 'accepted' })).status).toBe(400);
    expect((await resolve(first, { resolution: 'accepted', reason: 'short' })).status).toBe(400);
    expect(
      (await resolve(first, { resolution: 'made_up', reason: 'A long enough reason.' })).status,
    ).toBe(400);

    for (const id of Object.values(opened)) {
      const done = await resolve(id, {
        resolution: 'accepted',
        reason: 'Checked against the provider statement; sandbox test case.',
      });
      expect(done.status).toBe(200);
      expect(done.body).toMatchObject({ id, status: 'resolved', resolution: 'accepted' });
      expect(done.body.resolved_at).toEqual(expect.any(String));
      const again = await resolve(id, {
        resolution: 'corrected',
        reason: 'Trying to resolve it twice.',
      });
      expect(again.status).toBe(409);
    }
    expect(await auditCount('payments.reconciliation.exception_resolved')).toBe(
      Object.keys(opened).length,
    );
    const ledgerAfter = await h.owner((client) =>
      client.query(`select count(*)::int as n from ledger.posting`),
    );
    expect(ledgerAfter.rows[0].n).toBe(ledgerBefore.rows[0].n);
  });

  it('opens the same exception again if the difference is still there on the next run', async () => {
    await ops(operator, 'post', '/v1/ops/reconciliation-runs');
    const list = await ops(operator, 'get', '/v1/ops/reconciliation-exceptions').query({
      status: 'open',
    });
    expect((list.body.data as { type: string }[]).map((row) => row.type)).toContain(
      'missing_internal',
    );
  });

  it('cannot be un-resolved or edited in the database', async () => {
    await expect(
      h.owner((client) =>
        client.query(
          `update payments.reconciliation_exception set resolution_reason = 'rewritten' where status = 'resolved'`,
        ),
      ),
    ).rejects.toThrow(/resolved exception/);
  });
});

describe('operator lookups', () => {
  it('requires the operator flag on every operator route', async () => {
    for (const path of [
      '/v1/ops/accounts?email=adminA@sandbox.aora.test',
      '/v1/ops/workspaces?name=sandbox',
      '/v1/ops/audit-events',
      '/v1/ops/reconciliation-exceptions',
    ]) {
      expect((await ops(admin, 'get', path)).status, path).toBe(403);
    }
  });

  it('finds a user by email or phone, shows contact details masked, and audits the lookup', async () => {
    const byEmail = await ops(operator, 'get', '/v1/ops/accounts').query({
      email: 'ADMINA@sandbox.aora.test',
    });
    expect(byEmail.status).toBe(200);
    expect(byEmail.body.data).toHaveLength(1);
    expect(byEmail.body.data[0]).toMatchObject({
      id: h.seed.accounts.adminA,
      status: 'active',
      memberships: [{ workspace_id: h.seed.tenantA, role: 'admin', status: 'active' }],
    });
    const text = JSON.stringify(byEmail.body);
    expect(text).not.toContain(SEED_PHONES.adminA);
    expect(text).not.toContain('adminA@sandbox.aora.test');

    const byPhone = await ops(operator, 'get', '/v1/ops/accounts').query({
      phone: SEED_PHONES.adminB,
    });
    expect(byPhone.body.data[0].id).toBe(h.seed.accounts.adminB);
    expect((await ops(operator, 'get', '/v1/ops/accounts')).status).toBe(400);
    expect(await auditCount('ops.account.lookup')).toBe(2);
  });

  it('finds a merchant by name, with its tier and member count', async () => {
    const found = await ops(operator, 'get', '/v1/ops/workspaces').query({ name: 'hardware' });
    expect(found.body.data).toEqual([
      expect.objectContaining({
        id: h.seed.tenantA,
        business_name: 'Sandbox Hardware Ltd',
        kind: 'registered',
        tier: 'tier_0',
        active_members: 3,
      }),
    ]);
  });

  it('reads the audit trail, filtered by workspace, newest first', async () => {
    const trail = await ops(operator, 'get', '/v1/ops/audit-events').query({
      workspace_id: h.seed.tenantA,
      limit: 5,
    });
    expect(trail.status).toBe(200);
    const rows = trail.body.data as { workspace_id: string; occurred_at: string; action: string }[];
    expect(rows.length).toBe(5);
    expect(rows.every((row) => row.workspace_id === h.seed.tenantA)).toBe(true);
    expect([...rows].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))).toEqual(rows);
  });
});
