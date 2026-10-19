import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDemo } from '../src/demo-data.js';
import { type GateInput, gateChecks } from '../src/gate.js';
import { type Harness, startHarness } from './support/harness.js';

/**
 * The read-only gate check (phase-10 10B; mvp-scope G1). Written before the
 * code: it passes on a seeded, balanced database and names each failure.
 */

let h: Harness;

const DEPLOYED = {
  NamUsdcVault: { address: '0x1111111111111111111111111111111111111111' },
  AnchorRegistry: { address: '0x2222222222222222222222222222222222222222' },
};

function input(overrides: Partial<GateInput> = {}): GateInput {
  return {
    query: (sql) => h.owner(async (client) => (await client.query(sql)).rows),
    get: async (path) => {
      const response = await h.http().get(path);
      return { status: response.status, body: response.body as unknown };
    },
    deployment: { contracts: DEPLOYED },
    configured: {
      namUsdcVault: DEPLOYED.NamUsdcVault.address,
      anchorRegistry: DEPLOYED.AnchorRegistry.address,
    },
    ...overrides,
  };
}

const failing = (lines: Awaited<ReturnType<typeof gateChecks>>): string[] =>
  lines.filter((line) => !line.ok).map((line) => line.name);

beforeAll(async () => {
  h = await startHarness();
  await seedDemo((type) => h.app.get(type));
}, 180_000);

afterAll(async () => {
  await h.close();
}, 60_000);

describe('gate check', () => {
  it('passes on a seeded, balanced database with deployed contracts', async () => {
    const lines = await gateChecks(input());
    expect(failing(lines)).toEqual([]);
    expect(lines.map((line) => line.name)).toEqual([
      'api health',
      'trial balance is zero in every asset',
      'every running balance equals its postings',
      'no open reconciliation exception',
      'every category has a published listing',
      'contract addresses match contracts/deployments',
    ]);
  });

  it('fails when the contracts are not deployed, and says why', async () => {
    const lines = await gateChecks(
      input({ deployment: null, configured: { namUsdcVault: null, anchorRegistry: null } }),
    );
    const contract = lines.find((line) => line.name.startsWith('contract'));
    expect(contract?.ok).toBe(false);
    expect(contract?.detail).toMatch(/not deployed/);
  });

  it('fails when the configured addresses differ from the deployment record', async () => {
    const lines = await gateChecks(
      input({ configured: { namUsdcVault: DEPLOYED.NamUsdcVault.address, anchorRegistry: null } }),
    );
    expect(failing(lines)).toEqual(['contract addresses match contracts/deployments']);
  });

  it('fails on an open reconciliation exception', async () => {
    await h.owner((client) =>
      client.query(
        `insert into payments.reconciliation_exception (type, subject_type, subject_ref)
         values ('state_mismatch', 'gate_test', 'gate-check')`,
      ),
    );
    expect(failing(await gateChecks(input()))).toEqual(['no open reconciliation exception']);
    await h.owner((client) =>
      client.query(
        `update payments.reconciliation_exception
            set status = 'resolved', resolved_at = now(), resolution = 'false_positive',
                resolution_reason = 'gate check test',
                resolved_by = (select id from identity.user_account limit 1)
          where subject_type = 'gate_test'`,
      ),
    );
  });

  it('fails when a category has no published listing', async () => {
    const lines = await gateChecks(
      input({
        query: async (sql) => {
          const rows = await h.owner(async (client) => (await client.query(sql)).rows);
          return sql.includes('kelo.category')
            ? [...rows, { slug: 'empty-category', published: '0' }]
            : rows;
        },
      }),
    );
    const line = lines.find((entry) => entry.name === 'every category has a published listing');
    expect(line?.ok).toBe(false);
    expect(line?.detail).toContain('empty-category');
  });

  it('reports the API unreachable as a failure, not an exception', async () => {
    const lines = await gateChecks(input({ get: () => Promise.reject(new Error('offline')) }));
    expect(lines.find((line) => line.name === 'api health')?.ok).toBe(false);
  });
});
