import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './support/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h.close());

describe('tenant isolation at the database (row-level security)', () => {
  it('shows a tenant only its own workspace and memberships', async () => {
    const seenByA = await h.db.withTenant(h.seed.tenantA, async (tx) => ({
      workspaces: await tx.workspace.findMany(),
      memberships: await tx.membership.findMany(),
    }));
    expect(seenByA.workspaces.map((row) => row.id)).toEqual([h.seed.tenantA]);
    expect(seenByA.memberships).toHaveLength(3);
    expect(seenByA.memberships.every((row) => row.tenant_id === h.seed.tenantA)).toBe(true);

    const seenByB = await h.db.withTenant(h.seed.tenantB, (tx) => tx.membership.findMany());
    expect(seenByB).toHaveLength(1);
    expect(seenByB[0]?.tenant_id).toBe(h.seed.tenantB);
  });

  it('cannot reach another tenant even when asking for it by id', async () => {
    const rows = await h.db.withTenant(h.seed.tenantA, (tx) =>
      tx.membership.findMany({ where: { tenant_id: h.seed.tenantB } }),
    );
    expect(rows).toEqual([]);
  });

  it('shows nothing when no tenant is set', async () => {
    const rows = await h.db.withoutTenantForTest(async (tx) => ({
      workspaces: await tx.workspace.findMany(),
      memberships: await tx.membership.findMany(),
      audit: await tx.audit_event.findMany(),
    }));
    expect(rows).toEqual({ workspaces: [], memberships: [], audit: [] });
  });

  it('does not leak the tenant setting into the next transaction on the connection', async () => {
    for (let i = 0; i < 20; i += 1) {
      await h.db.withTenant(h.seed.tenantA, (tx) => tx.workspace.findMany());
      const rows = await h.db.withoutTenantForTest((tx) => tx.workspace.findMany());
      expect(rows).toEqual([]);
    }
  });

  it('refuses the tenant role any write to tenancy tables', async () => {
    await expect(
      h.db.withTenant(h.seed.tenantA, (tx) =>
        tx.membership.create({
          data: { tenant_id: h.seed.tenantA, account_id: h.seed.accounts.adminB, role: 'admin' },
        }),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('refuses the tenant role any access to identity and business tables', async () => {
    await expect(
      h.db.withTenant(h.seed.tenantA, (tx) => tx.user_account.findMany()),
    ).rejects.toThrow(/permission denied/);
    await expect(h.db.withTenant(h.seed.tenantA, (tx) => tx.business.findMany())).rejects.toThrow(
      /permission denied/,
    );
  });

  it('refuses an audit event written for another tenant', async () => {
    const write = (tenantId: string): Promise<unknown> =>
      h.db.withTenant(h.seed.tenantA, (tx) =>
        tx.audit_event.create({
          data: {
            tenant_id: tenantId,
            actor_kind: 'system',
            action: 'test.event',
            subject_type: 'test',
            subject_id: 'x',
            outcome: 'success',
          },
        }),
      );
    await expect(write(h.seed.tenantA)).resolves.toBeDefined();
    await expect(write(h.seed.tenantB)).rejects.toThrow(/row-level security/);
  });

  it('forces row-level security on every table that has a tenant_id column', async () => {
    const unprotected = await h.owner((client) =>
      client.query(`
        select n.nspname || '.' || c.relname as name
        from pg_attribute a
        join pg_class c on c.oid = a.attrelid and c.relkind = 'r'
        join pg_namespace n on n.oid = c.relnamespace
        where a.attname = 'tenant_id' and not a.attisdropped
          and n.nspname not in ('pg_catalog', 'information_schema')
          and not (c.relrowsecurity and c.relforcerowsecurity)`),
    );
    expect(unprotected.rows).toEqual([]);
  });
});

describe('sandbox labelling', () => {
  it('rejects any mode other than sandbox on every table that has a mode column', async () => {
    const tables = await h.owner((client) =>
      client.query<{ name: string; checked: boolean }>(`
        select n.nspname || '.' || c.relname as name,
               exists (
                 select from pg_constraint k
                 where k.conrelid = c.oid and k.contype = 'c'
                   and pg_get_constraintdef(k.oid) like '%mode = ''sandbox''%'
               ) as checked
        from pg_attribute a
        join pg_class c on c.oid = a.attrelid and c.relkind = 'r'
        join pg_namespace n on n.oid = c.relnamespace
        where a.attname = 'mode' and not a.attisdropped
          and n.nspname not in ('pg_catalog', 'information_schema')`),
    );
    expect(tables.rows.length).toBeGreaterThan(0);
    expect(tables.rows.filter((row) => !row.checked)).toEqual([]);
    await expect(
      h.owner((client) =>
        client.query(`update tenancy.workspace set mode = 'live' where id = $1`, [h.seed.tenantA]),
      ),
    ).rejects.toThrow(/check constraint/);
  });
});

describe('clock', () => {
  it('stores application timestamps on the same clock as the database', async () => {
    const before = Date.now();
    await h.stepUp(await h.signIn('adminB'));
    const row = await h.owner((client) =>
      client.query<{ skew_ms: string }>(
        `select extract(epoch from (until - now())) * 1000 as skew_ms
         from identity.step_up order by created_at desc limit 1`,
      ),
    );
    const ttl = h.config.auth.stepUpTtlSeconds * 1000;
    const elapsed = Date.now() - before;
    expect(Math.abs(Number(row.rows[0]?.skew_ms) - ttl)).toBeLessThan(elapsed + 2000);
  });
});
