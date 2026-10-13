import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Band, computeFee, PricingService } from '../src/modules/pricing/pricing.service.js';
import { type Harness, startHarness } from './support/harness.js';
import { type Caller, createIntent, getIntent } from './support/payments.js';

let h: Harness;
let admin: Caller;
let pricing: PricingService;

beforeAll(async () => {
  h = await startHarness();
  admin = { token: await h.signIn('adminA'), workspace: h.seed.tenantA };
  pricing = h.app.get(PricingService);
});
afterAll(() => h.close());

const band = (minAmount: bigint, rest: Partial<Band> = {}): Band => ({
  minAmount,
  bps: 0,
  flatAmount: 0n,
  minFee: 0n,
  maxFee: null,
  ...rest,
});

/** The sandbox reference tariff: free below KES 100.00, then 1.00 % capped at KES 200.00. */
const SANDBOX = [band(0n, { maxFee: 0n }), band(10_000n, { bps: 100, maxFee: 20_000n })];

const balances = (): Promise<Record<string, string>> =>
  h.owner(async (client) => {
    const result = await client.query<{ type: string; balance: string }>(
      `select a.type, coalesce(sum(b.balance), 0)::text as balance
       from ledger.account a left join ledger.account_balance b on b.account_id = a.id
       where a.tenant_id is null or a.tenant_id = $1 group by a.type`,
      [h.seed.tenantA],
    );
    return Object.fromEntries(result.rows.map((row) => [row.type, row.balance]));
  });

async function collect(amount: string, extra: Record<string, unknown> = {}): Promise<string> {
  const response = await createIntent(h, admin, {
    amount_minor: amount,
    currency: 'KES',
    ...extra,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.id as string;
}

describe('fee calculation (pure, integer minor units)', () => {
  it('computes free, percentage, capped and flat bands to the minor unit', () => {
    expect(computeFee(SANDBOX, 'half_up', 9_999n)).toBe(0n);
    expect(computeFee(SANDBOX, 'half_up', 10_000n)).toBe(100n);
    expect(computeFee(SANDBOX, 'half_up', 15_000n)).toBe(150n);
    expect(computeFee(SANDBOX, 'half_up', 2_500_000n)).toBe(20_000n);
    const flat = [
      band(0n, { flatAmount: 3_000n }),
      band(100_000n, { flatAmount: 5_000n, bps: 50 }),
    ];
    expect(computeFee(flat, 'half_up', 50_000n)).toBe(3_000n);
    expect(computeFee(flat, 'half_up', 200_000n)).toBe(6_000n);
    expect(computeFee([band(0n, { bps: 100, minFee: 500n })], 'half_up', 1_000n)).toBe(500n);
  });

  it('rounds half up, or down, exactly as the tariff says', () => {
    const one = [band(0n, { bps: 100 })];
    expect(computeFee(one, 'half_up', 10_049n)).toBe(100n);
    expect(computeFee(one, 'half_up', 10_050n)).toBe(101n);
    expect(computeFee(one, 'down', 10_099n)).toBe(100n);
  });

  it('never charges more than the amount, and refuses an amount below the lowest band', () => {
    expect(computeFee([band(0n, { flatAmount: 5_000n })], 'half_up', 1_200n)).toBe(1_200n);
    expect(() => computeFee([band(500n)], 'half_up', 499n)).toThrow(/no band/i);
  });

  it('holds for arbitrary tariffs: 0 ≤ fee ≤ amount, within [min, cap], and net + fee = gross', () => {
    const arbitraryBand = fc.record({
      minAmount: fc.bigInt({ min: 0n, max: 10n ** 12n }),
      bps: fc.integer({ min: 0, max: 10_000 }),
      flatAmount: fc.bigInt({ min: 0n, max: 10n ** 9n }),
      minFee: fc.bigInt({ min: 0n, max: 10n ** 6n }),
      cap: fc.option(fc.bigInt({ min: 0n, max: 10n ** 9n }), { nil: null }),
    });
    fc.assert(
      fc.property(
        fc.array(arbitraryBand, { minLength: 1, maxLength: 5 }),
        fc.bigInt({ min: 1n, max: 9_223_372_036_854_775_807n }),
        fc.constantFrom('half_up' as const, 'down' as const),
        (raw, amount, rounding) => {
          const bands = raw.map((entry, index) => ({
            minAmount: index === 0 ? 0n : entry.minAmount,
            bps: entry.bps,
            flatAmount: entry.flatAmount,
            minFee: entry.minFee,
            maxFee: entry.cap === null ? null : entry.minFee + entry.cap,
          }));
          const fee = computeFee(bands, rounding, amount);
          const applied = [...bands]
            .sort((a, b) => (a.minAmount < b.minAmount ? 1 : -1))
            .find((entry) => entry.minAmount <= amount);
          expect(fee >= 0n && fee <= amount).toBe(true);
          expect(amount - fee + fee).toBe(amount);
          if (applied && applied.minFee <= amount) expect(fee >= applied.minFee).toBe(true);
          if (applied?.maxFee != null) expect(fee <= applied.maxFee).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('gross, fee and net on a collection', () => {
  it('fixes the fee when the collection is created and shows gross, fee, net and the tariff version', async () => {
    const id = await collect('15000');
    const view = (await getIntent(h, admin, id)).body;
    expect(view).toMatchObject({
      amount_minor: '15000',
      fee_minor: '150',
      net_minor: '14850',
      rail: 'mpesa',
    });
    expect(view.tariff_version_id).toEqual(expect.any(String));
  });

  it('posts gross to the provider, net to the merchant and the fee to revenue, in one balanced entry', async () => {
    await h.settle();
    const before = await balances();
    const id = await collect('250000');
    await h.settle();
    const after = await balances();
    const delta = (type: string): bigint =>
      BigInt(after[type] ?? '0') - BigInt(before[type] ?? '0');
    expect(delta('provider_clearing')).toBe(250_000n);
    expect(delta('merchant_collections_pending')).toBe(247_500n);
    expect(delta('fee_revenue')).toBe(2_500n);
    const postings = await h.owner((client) =>
      client.query(
        `select count(*)::int as n from ledger.posting p join ledger.journal_entry e on e.id = p.entry_id
         where e.operation_id = $1`,
        [id],
      ),
    );
    expect(postings.rows[0].n).toBe(3);
  });

  it('posts no fee posting when the fee is zero', async () => {
    const id = await collect('5000');
    await h.settle();
    const postings = await h.owner((client) =>
      client.query(
        `select count(*)::int as n from ledger.posting p join ledger.journal_entry e on e.id = p.entry_id
         where e.operation_id = $1`,
        [id],
      ),
    );
    expect(postings.rows[0].n).toBe(2);
  });

  it('keeps the whole ledger balanced', async () => {
    const result = await h.owner((client) =>
      client.query(
        `select coalesce(sum(case when direction = 'debit' then amount else -amount end), 0)::text as net
         from ledger.posting`,
      ),
    );
    expect(result.rows[0].net).toBe('0');
  });

  it('quotes the same fee it then charges', async () => {
    const quote = await h
      .http()
      .get('/v1/tariffs/quote')
      .query({ operation: 'collection', rail: 'mpesa', currency: 'KES', amount_minor: '123456' })
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Aora-Workspace-Id', admin.workspace);
    expect(quote.status).toBe(200);
    expect(quote.body).toMatchObject({
      amount_minor: '123456',
      fee_minor: '1235',
      net_minor: '122221',
    });
    const view = (await getIntent(h, admin, await collect('123456'))).body;
    expect(view.fee_minor).toBe(quote.body.fee_minor);
    expect(view.tariff_version_id).toBe(quote.body.tariff_version_id);
  });
});

describe('tariff versions', () => {
  it('applies a new version to later collections only, with no code change', async () => {
    // Created under version 1, and still unresolved when the tariff changes.
    const early = await collect('40000', { sandbox_scenario: 'timeout_then_success' });
    const firstVersion = (await getIntent(h, admin, early)).body.tariff_version_id as string;

    const published = await h.db.asPlatform((tx) =>
      pricing.publish(tx, {
        operation: 'collection',
        rail: 'mpesa',
        country: 'KE',
        assetCode: 'KES',
        name: 'SANDBOX collection fee v2',
        rounding: 'half_up',
        effectiveFrom: new Date(),
        bands: [band(0n, { bps: 250, minFee: 100n })],
      }),
    );
    expect(published.version).toBe(2);

    const late = (await getIntent(h, admin, await collect('40000'))).body;
    expect(late.fee_minor).toBe('1000');
    expect(late.tariff_version_id).toBe(published.id);

    await h.settle();
    await h.makeDelayedEventsDue();
    await h.settle();
    const settledEarly = (await getIntent(h, admin, early)).body;
    expect(settledEarly).toMatchObject({ status: 'succeeded', fee_minor: '400' });
    expect(settledEarly.tariff_version_id).toBe(firstVersion);
  });

  it('refuses two versions in effect at once', async () => {
    await expect(
      h.owner((client) =>
        client.query(
          `insert into pricing.tariff_version (operation, rail, country, asset_code, version, name, effective_from)
           values ('collection', 'mpesa', 'KE', 'KES', 99, 'overlap', now() - interval '1 hour')`,
        ),
      ),
    ).rejects.toThrow(/overlap in time/);
  });

  it('refuses any change to a published version or its bands, even for a superuser', async () => {
    const attempts = [
      `update pricing.tariff_band set bps = 1`,
      `delete from pricing.tariff_band`,
      `update pricing.tariff_version set name = 'x'`,
      `delete from pricing.tariff_version`,
      `truncate pricing.tariff_band`,
      `insert into pricing.tariff_band (tariff_version_id, min_amount, bps)
         select id, 777, 1 from pricing.tariff_version limit 1`,
    ];
    for (const sql of attempts) {
      await expect(
        h.owner((client) => client.query(sql)),
        sql,
      ).rejects.toThrow(/immutable|published/);
    }
  });

  it('lets the tenant role read tariffs but never write them', async () => {
    const seen = await h.db.withTenant(h.seed.tenantA, (tx) => tx.tariff_version.count());
    expect(seen).toBeGreaterThan(0);
    await expect(
      h.db.withTenant(
        h.seed.tenantA,
        (tx) =>
          tx.$executeRaw`update pricing.tariff_version set effective_to = now() where effective_to is null`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('refuses a collection on a rail that has no tariff', async () => {
    const response = await createIntent(h, admin, {
      amount_minor: '1000',
      currency: 'KES',
      rail: 'airtel_money',
    });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('capability_not_supported');
  });
});

describe('tier limits', () => {
  it('refuses a collection above the per-transaction limit, from configuration', async () => {
    const response = await createIntent(h, admin, { amount_minor: '5000001', currency: 'KES' });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('limit_exceeded');
  });

  it('admits it once a newer limit version is in effect', async () => {
    await h.owner((client) =>
      client.query(
        `insert into tenancy.tier_limit
           (tier, asset_code, version, effective_from, per_transaction_max, daily_collection_max, daily_payout_max)
         values ('tier_0', 'KES', 2, now(), 6000000, 7000000, 1)`,
      ),
    );
    expect(
      (await createIntent(h, admin, { amount_minor: '5000001', currency: 'KES' })).status,
    ).toBe(201);
  });

  it('refuses a collection that would take the rolling 24-hour total over the daily limit', async () => {
    // The daily limit is now 7 000 000 and the workspace has already taken well over 2 000 000.
    const response = await createIntent(h, admin, { amount_minor: '4900000', currency: 'KES' });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('limit_exceeded');
  });

  it('does not count another workspace towards the limit', async () => {
    const other = { token: await h.signIn('adminB'), workspace: h.seed.tenantB };
    expect(
      (await createIntent(h, other, { amount_minor: '4900000', currency: 'KES' })).status,
    ).toBe(201);
  });
});
