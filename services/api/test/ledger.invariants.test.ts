import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerService } from '../src/modules/ledger/ledger.service.js';
import type { Tx } from '../src/platform/database.js';
import { formatMinorUnits, parseMinorUnits } from '../src/platform/money.js';
import { type Harness, startHarness } from './support/harness.js';

let h: Harness;
let ledger: LedgerService;
let clearing: string;
let pendingA: string;
let pendingB: string;

beforeAll(async () => {
  h = await startHarness();
  ledger = h.app.get(LedgerService);
  clearing = h.seed.providerClearingAccount;
  const pending = (tenantId: string): Promise<string> =>
    h.db.asPlatform((tx) =>
      ledger.findAccount(tx, { tenantId, type: 'merchant_collections_pending', assetCode: 'KES' }),
    );
  pendingA = await pending(h.seed.tenantA);
  pendingB = await pending(h.seed.tenantB);
});
afterAll(() => h.close());

type Raw = { account: string; direction: 'debit' | 'credit'; amount: bigint; asset?: string };

/** Writes an entry with plain SQL, bypassing LedgerService, to prove the database enforces the rules. */
async function rawEntry(tx: Tx, tenantId: string | null, postings: Raw[]): Promise<string> {
  const id = randomUUID();
  await tx.$executeRaw`
    insert into ledger.journal_entry (id, tenant_id, idempotency_key, entry_type, operation_type, operation_id)
    values (${id}::uuid, ${tenantId}::uuid, ${`raw:${id}`}, 'test', 'test', ${id})`;
  for (const posting of postings) {
    await tx.$executeRaw`
      insert into ledger.posting (entry_id, account_id, tenant_id, direction, amount, asset_code)
      values (${id}::uuid, ${posting.account}::uuid, ${tenantId}::uuid, ${posting.direction},
              ${posting.amount}, ${posting.asset ?? 'KES'})`;
  }
  return id;
}

const collect = (amount: bigint, account = pendingA): Raw[] => [
  { account: clearing, direction: 'debit', amount },
  { account, direction: 'credit', amount },
];

describe('journal balance (enforced by the database)', () => {
  it('accepts a balanced entry and updates both balances', async () => {
    const before = await h.db.asPlatform((tx) => ledger.balanceOf(tx, pendingA));
    await h.db.asPlatform((tx) => rawEntry(tx, h.seed.tenantA, collect(1500n)));
    const after = await h.db.asPlatform((tx) => ledger.balanceOf(tx, pendingA));
    expect(after - before).toBe(1500n);
  });

  it('rejects an entry whose debits and credits differ', async () => {
    await expect(
      h.db.asPlatform((tx) =>
        rawEntry(tx, h.seed.tenantA, [
          { account: clearing, direction: 'debit', amount: 1000n },
          { account: pendingA, direction: 'credit', amount: 999n },
        ]),
      ),
    ).rejects.toThrow(/does not balance/);
  });

  it('rejects an entry with one posting, and an entry with none', async () => {
    await expect(
      h.db.asPlatform((tx) =>
        rawEntry(tx, h.seed.tenantA, [{ account: clearing, direction: 'debit', amount: 5n }]),
      ),
    ).rejects.toThrow(/fewer than two postings/);
    await expect(h.db.asPlatform((tx) => rawEntry(tx, h.seed.tenantA, []))).rejects.toThrow(
      /fewer than two postings/,
    );
  });

  it('rejects zero and negative amounts', async () => {
    for (const amount of [0n, -5n]) {
      await expect(
        h.db.asPlatform((tx) => rawEntry(tx, h.seed.tenantA, collect(amount))),
      ).rejects.toThrow(/posting_amount_check/);
    }
  });

  it('leaves nothing behind when an entry is rejected', async () => {
    const count = (): Promise<string> =>
      h.owner(async (client) => {
        const result = await client.query<{ n: string }>(
          `select (select count(*) from ledger.journal_entry) + (select count(*) from ledger.posting) as n`,
        );
        return result.rows[0]?.n ?? '';
      });
    const before = await count();
    await expect(
      h.db.asPlatform((tx) =>
        rawEntry(tx, h.seed.tenantA, [
          { account: clearing, direction: 'debit', amount: 10n },
          { account: pendingA, direction: 'credit', amount: 7n },
        ]),
      ),
    ).rejects.toThrow();
    expect(await count()).toBe(before);
  });

  it('holds for arbitrary entries: accepted exactly when balanced with two or more postings', async () => {
    const posting = fc.record({
      account: fc.constantFrom('clearing', 'pending'),
      direction: fc.constantFrom('debit' as const, 'credit' as const),
      amount: fc.bigInt({ min: 1n, max: 10n ** 15n }),
    });
    await fc.assert(
      fc.asyncProperty(fc.array(posting, { minLength: 0, maxLength: 6 }), async (postings) => {
        const net = postings.reduce(
          (sum, p) => sum + (p.direction === 'debit' ? p.amount : -p.amount),
          0n,
        );
        const shouldBalance = postings.length >= 2 && net === 0n;
        let accepted = true;
        let message = '';
        try {
          await h.db.asPlatform((tx) =>
            rawEntry(
              tx,
              h.seed.tenantA,
              postings.map((p) => ({
                account: p.account === 'clearing' ? clearing : pendingA,
                direction: p.direction,
                amount: p.amount,
              })),
            ),
          );
        } catch (error) {
          accepted = false;
          message = String(error);
        }
        if (shouldBalance) {
          // A balanced entry may still be refused, but only for driving a balance negative.
          if (!accepted) expect(message).toMatch(/insufficient balance/);
        } else {
          expect(accepted).toBe(false);
        }
      }),
      { numRuns: 60 },
    );
  });

  it('keeps every running balance equal to the sum of its postings, and the books at zero', async () => {
    const result = await h.owner((client) =>
      client.query<{ mismatched: string; trial_balance: string }>(`
        select
          (select count(*) from ledger.account a
             left join ledger.account_balance b on b.account_id = a.id
             left join lateral (
               select coalesce(sum(case when p.direction = a.normal_side then p.amount else -p.amount end), 0) as total
               from ledger.posting p where p.account_id = a.id) s on true
           where coalesce(b.balance, 0) <> s.total) as mismatched,
          (select coalesce(sum(case when direction = 'debit' then amount else -amount end), 0)
           from ledger.posting) as trial_balance`),
    );
    expect(result.rows[0]).toEqual({ mismatched: '0', trial_balance: '0' });
  });
});

describe('immutability', () => {
  it('rejects update, delete and truncate on entries, postings and accounts, even for a superuser', async () => {
    await h.db.asPlatform((tx) => rawEntry(tx, h.seed.tenantA, collect(100n)));
    for (const sql of [
      `update ledger.posting set amount = amount + 1`,
      `delete from ledger.posting`,
      `truncate ledger.posting`,
      `update ledger.journal_entry set entry_type = 'changed'`,
      `delete from ledger.journal_entry`,
      `truncate ledger.journal_entry cascade`,
      `update ledger.account set allow_negative = true`,
      `delete from ledger.account_balance`,
    ]) {
      await expect(
        h.owner((client) => client.query(sql)),
        sql,
      ).rejects.toThrow(/immutable/);
    }
  });

  it('refuses a posting added to an entry from an earlier transaction', async () => {
    const entryId = await h.db.asPlatform((tx) => rawEntry(tx, h.seed.tenantA, collect(100n)));
    await expect(
      h.db.asPlatform(async (tx) => {
        for (const p of collect(50n)) {
          await tx.$executeRaw`
            insert into ledger.posting (entry_id, account_id, tenant_id, direction, amount, asset_code)
            values (${entryId}::uuid, ${p.account}::uuid, ${h.seed.tenantA}::uuid, ${p.direction}, ${p.amount}, 'KES')`;
        }
      }),
    ).rejects.toThrow(/cannot be added to an existing journal entry/);
  });

  it('gives application roles no way to change the ledger or write balances directly', async () => {
    const grants = await h.owner((client) =>
      client.query(
        `select grantee, table_name, privilege_type from information_schema.role_table_grants
         where table_schema = 'ledger' and grantee in ('aora_app', 'aora_platform')
           and (privilege_type in ('UPDATE', 'DELETE', 'TRUNCATE')
                or (table_name = 'account_balance' and privilege_type <> 'SELECT')
                or (grantee = 'aora_app' and privilege_type <> 'SELECT'))`,
      ),
    );
    expect(grants.rows).toEqual([]);
  });
});

describe('tenant and asset rules', () => {
  it("refuses a posting to another tenant's account", async () => {
    await expect(
      h.db.asPlatform((tx) => rawEntry(tx, h.seed.tenantA, collect(100n, pendingB))),
    ).rejects.toThrow(/account of another tenant/);
  });

  it('refuses a posting whose asset differs from its account', async () => {
    await h.owner((client) =>
      client.query(`insert into ledger.asset (code, kind, exponent) values ('TST', 'fiat', 0)`),
    );
    await expect(
      h.db.asPlatform((tx) =>
        rawEntry(tx, h.seed.tenantA, [
          { account: clearing, direction: 'debit', amount: 100n, asset: 'TST' },
          { account: pendingA, direction: 'credit', amount: 100n, asset: 'TST' },
        ]),
      ),
    ).rejects.toThrow(/does not match account asset/);
  });

  it('refuses to drive a balance negative where the account forbids it', async () => {
    const balance = await h.db.asPlatform((tx) => ledger.balanceOf(tx, pendingB));
    await expect(
      h.db.asPlatform((tx) =>
        rawEntry(tx, h.seed.tenantB, [
          { account: pendingB, direction: 'debit', amount: balance + 1n },
          { account: clearing, direction: 'credit', amount: balance + 1n },
        ]),
      ),
    ).rejects.toThrow(/insufficient balance/);
  });

  it("shows a tenant only its own entries, postings and balances, and hides the platform's", async () => {
    await h.db.asPlatform((tx) => rawEntry(tx, h.seed.tenantA, collect(300n, pendingA)));
    await h.db.asPlatform((tx) => rawEntry(tx, h.seed.tenantB, collect(700n, pendingB)));
    const seen = await h.db.withTenant(h.seed.tenantB, async (tx) => ({
      entries: await tx.journal_entry.findMany(),
      postings: await tx.posting.findMany(),
      balances: await tx.account_balance.findMany(),
      accounts: await tx.account.findMany(),
    }));
    expect(seen.entries.length).toBeGreaterThan(0);
    expect(seen.entries.every((row) => row.tenant_id === h.seed.tenantB)).toBe(true);
    expect(seen.postings.every((row) => row.tenant_id === h.seed.tenantB)).toBe(true);
    expect(seen.balances.map((row) => row.account_id)).toEqual([pendingB]);
    expect(seen.accounts.map((row) => row.id)).toEqual([pendingB]);
    const none = await h.db.withoutTenantForTest((tx) => tx.posting.findMany());
    expect(none).toEqual([]);
  });
});

describe('LedgerService', () => {
  const entry = (key: string, amount: bigint, operationId = key) => ({
    idempotencyKey: key,
    tenantId: h.seed.tenantA,
    entryType: 'collection',
    operationType: 'test_operation',
    operationId,
    postings: [
      { accountId: clearing, direction: 'debit' as const, amount },
      { accountId: pendingA, direction: 'credit' as const, amount },
    ],
  });

  it('posts once per idempotency key, however often it is called', async () => {
    const key = `idem:${randomUUID()}`;
    const before = await h.db.asPlatform((tx) => ledger.balanceOf(tx, pendingA));
    const first = await h.db.asPlatform((tx) => ledger.post(tx, entry(key, 250n)));
    const second = await h.db.asPlatform((tx) => ledger.post(tx, entry(key, 250n)));
    expect(first.created).toBe(true);
    expect(second).toEqual({ entryId: first.entryId, created: false });
    const after = await h.db.asPlatform((tx) => ledger.balanceOf(tx, pendingA));
    expect(after - before).toBe(250n);
  });

  it('posts once when the same key is posted concurrently', async () => {
    const key = `race:${randomUUID()}`;
    const before = await h.db.asPlatform((tx) => ledger.balanceOf(tx, pendingA));
    const results = await Promise.all(
      Array.from({ length: 8 }, () => h.db.asPlatform((tx) => ledger.post(tx, entry(key, 40n)))),
    );
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.entryId)).size).toBe(1);
    const after = await h.db.asPlatform((tx) => ledger.balanceOf(tx, pendingA));
    expect(after - before).toBe(40n);
  });

  it('refuses a key reused for a different operation', async () => {
    const key = `reuse:${randomUUID()}`;
    await h.db.asPlatform((tx) => ledger.post(tx, entry(key, 10n, 'operation-1')));
    await expect(
      h.db.asPlatform((tx) => ledger.post(tx, entry(key, 10n, 'operation-2'))),
    ).rejects.toThrow(/different entry/);
  });

  it('refuses a number where a bigint amount is required', async () => {
    const bad = { ...entry(`float:${randomUUID()}`, 1n) };
    const postings = bad.postings.map((p) => ({ ...p, amount: 10.5 as unknown as bigint }));
    await expect(h.db.asPlatform((tx) => ledger.post(tx, { ...bad, postings }))).rejects.toThrow(
      /bigint/,
    );
  });

  it('corrects by a linked compensating entry and leaves the original untouched', async () => {
    const key = `rev:${randomUUID()}`;
    const before = await h.db.asPlatform((tx) => ledger.balanceOf(tx, pendingA));
    const original = await h.db.asPlatform((tx) => ledger.post(tx, entry(key, 900n)));
    const snapshot = (): Promise<unknown> =>
      h.owner(async (client) => {
        const result = await client.query(
          `select e::text as entry, array_agg(p::text order by p.id) as postings
           from ledger.journal_entry e join ledger.posting p on p.entry_id = e.id
           where e.id = $1 group by e.*`,
          [original.entryId],
        );
        return result.rows[0];
      });
    const originalBefore = await snapshot();

    const reversal = await h.db.asPlatform((tx) =>
      ledger.reverse(tx, original.entryId, `${key}:reversal`),
    );
    expect(reversal.created).toBe(true);
    expect(await snapshot()).toEqual(originalBefore);
    expect(await h.db.asPlatform((tx) => ledger.balanceOf(tx, pendingA))).toBe(before);

    const link = await h.owner((client) =>
      client.query(`select reverses_entry_id from ledger.journal_entry where id = $1`, [
        reversal.entryId,
      ]),
    );
    expect(link.rows[0]?.reverses_entry_id).toBe(original.entryId);

    const again = await h.db.asPlatform((tx) =>
      ledger.reverse(tx, original.entryId, `${key}:reversal`),
    );
    expect(again).toEqual({ entryId: reversal.entryId, created: false });
    await expect(
      h.db.asPlatform((tx) => ledger.reverse(tx, original.entryId, `${key}:second-reversal`)),
    ).rejects.toThrow(/Unique constraint|unique/i);
    await expect(
      h.db.asPlatform((tx) => ledger.reverse(tx, reversal.entryId, `${key}:reverse-reversal`)),
    ).rejects.toThrow(/cannot itself be reversed/);
  });
});

describe('precision', () => {
  it('accepts only strings of digits in minor units', () => {
    expect(parseMinorUnits('15000')).toBe(15000n);
    expect(parseMinorUnits('9223372036854775807')).toBe(9223372036854775807n);
    for (const bad of [
      15000,
      150.5,
      '150.5',
      '1e3',
      '-1',
      '+1',
      ' 1',
      '1 ',
      '',
      '0',
      '007',
      '1,000',
      'abc',
      '9223372036854775808',
      '99999999999999999999',
      null,
      undefined,
      10n,
      {},
      [],
    ]) {
      expect(
        () => parseMinorUnits(bad),
        JSON.stringify(bad, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v)),
      ).toThrow();
    }
  });

  it('keeps large amounts exact through the database', async () => {
    const big = 9_007_199_254_740_993n; // 2^53 + 1: not representable as a double
    const tenant = h.seed.tenantB;
    const before = await h.db.asPlatform((tx) => ledger.balanceOf(tx, pendingB));
    await h.db.asPlatform((tx) => rawEntry(tx, tenant, collect(big, pendingB)));
    const after = await h.db.asPlatform((tx) => ledger.balanceOf(tx, pendingB));
    expect(after - before).toBe(big);
    expect(typeof after).toBe('bigint');
  });

  it('takes the number of minor-unit digits from asset data, not from an assumption', async () => {
    const assets = await h.db.asPlatform((tx) => tx.asset.findMany());
    const kes = assets.find((asset) => asset.code === 'KES');
    expect(kes?.exponent).toBe(2);
    expect(formatMinorUnits(15000n, kes?.exponent ?? -1)).toBe('150.00');
    expect(formatMinorUnits(15000n, 0)).toBe('15000');
    expect(formatMinorUnits(1n, 6)).toBe('0.000001');
  });
});
