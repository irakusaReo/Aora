import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './support/harness.js';
import { type Caller, createIntent, ledgerFor, statusOf } from './support/payments.js';
import { poolerAvailable } from './support/pg.js';

// Neon's runtime connection is PgBouncer in transaction mode (ADR 0013). These
// tests run the application through a local PgBouncer configured the same way,
// with ONE server connection per role, so consecutive transactions from
// different tenants always share a backend. Any session state the application
// left behind would leak here.

const available = await poolerAvailable();

describe.skipIf(!available)('through a transaction-mode pooler', () => {
  let h: Harness;
  let admin: Caller;

  beforeAll(async () => {
    h = await startHarness({ pooled: true });
    admin = { token: await h.signIn('adminA'), workspace: h.seed.tenantA };
  });
  afterAll(() => h.close());

  it('really shares one backend between consecutive transactions', async () => {
    const pids = new Set<number>();
    for (let i = 0; i < 10; i += 1) {
      const rows = await h.db.withTenant(
        i % 2 ? h.seed.tenantA : h.seed.tenantB,
        (tx) => tx.$queryRaw<{ pid: number }[]>`select pg_backend_pid() as pid`,
      );
      pids.add(rows[0]?.pid ?? -1);
    }
    expect(pids.size).toBe(1);
  });

  it('never carries one tenant into the next transaction on the shared backend', async () => {
    for (let i = 0; i < 25; i += 1) {
      const a = await h.db.withTenant(h.seed.tenantA, (tx) => tx.membership.findMany());
      expect(a.every((row) => row.tenant_id === h.seed.tenantA)).toBe(true);
      const none = await h.db.withoutTenantForTest((tx) => tx.membership.findMany());
      expect(none).toEqual([]);
      const b = await h.db.withTenant(h.seed.tenantB, (tx) => tx.membership.findMany());
      expect(b.every((row) => row.tenant_id === h.seed.tenantB)).toBe(true);
    }
  });

  it('keeps tenants apart under interleaved concurrent requests', async () => {
    const seen = await Promise.all(
      Array.from({ length: 40 }, (_, i) => {
        const tenant = i % 2 ? h.seed.tenantA : h.seed.tenantB;
        return h.db
          .withTenant(tenant, (tx) => tx.workspace.findMany())
          .then((rows) => ({ tenant, ids: rows.map((row) => row.id) }));
      }),
    );
    for (const result of seen) expect(result.ids).toEqual([result.tenant]);
  });

  it('leaves no session-level setting behind', async () => {
    await h.db.withTenant(h.seed.tenantA, (tx) => tx.workspace.findMany());
    const rows = await h.db.withoutTenantForTest(
      (tx) =>
        tx.$queryRaw<{ tenant: string | null }[]>`
        select nullif(current_setting('app.tenant_id', true), '') as tenant`,
    );
    expect(rows[0]?.tenant).toBeNull();
  });

  it('stores timestamps on the database clock without any session time zone setting', async () => {
    await h.http().post('/v1/auth/challenges').send({ phone: '+99900000001' });
    const row = await h.owner((client) =>
      client.query<{ skew_ms: string }>(
        `select extract(epoch from (expires_at - now())) * 1000 as skew_ms
         from identity.auth_challenge order by created_at desc limit 1`,
      ),
    );
    const ttl = h.config.auth.challengeTtlSeconds * 1000;
    expect(Math.abs(Number(row.rows[0]?.skew_ms) - ttl)).toBeLessThan(10_000);
  });

  it('takes a payment from intent to a balanced ledger entry', async () => {
    const created = await createIntent(h, admin, { amount_minor: '4200', currency: 'KES' });
    expect(created.status).toBe(201);
    await h.settle();
    expect(await statusOf(h, admin, created.body.id)).toBe('succeeded');
    expect(await ledgerFor(h, created.body.id)).toEqual({ entries: 1, credited: '4200' });
  });

  it('still refuses cross-tenant reads through the API', async () => {
    const created = await createIntent(h, admin, { amount_minor: '100', currency: 'KES' });
    const other = { token: await h.signIn('adminB'), workspace: h.seed.tenantB };
    const response = await h
      .http()
      .get(`/v1/payment-intents/${created.body.id}`)
      .set('Authorization', `Bearer ${other.token}`)
      .set('Aora-Workspace-Id', other.workspace);
    expect(response.status).toBe(404);
  });
});

describe('database roles', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(() => h.close());

  it('gives no AORA role superuser rights or the right to bypass row-level security', async () => {
    const roles = await h.owner((client) =>
      client.query(
        `select rolname, rolsuper, rolbypassrls from pg_roles
         where rolname in ('aora_owner', 'aora_app', 'aora_platform') order by rolname`,
      ),
    );
    expect(roles.rows).toEqual([
      { rolname: 'aora_app', rolsuper: false, rolbypassrls: false },
      { rolname: 'aora_owner', rolsuper: false, rolbypassrls: false },
      { rolname: 'aora_platform', rolsuper: false, rolbypassrls: false },
    ]);
  });
});
