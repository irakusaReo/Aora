import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_STORES, seedDemo } from '../src/demo-data.js';
import { type Harness, startHarness } from './support/harness.js';

/**
 * The gate's demo catalogue (phase-10 10A, mvp-scope §4: demo data covers all
 * twelve categories). Written before the code: a second run must change nothing.
 */

let h: Harness;

const count = (table: string): Promise<number> =>
  h.owner(async (client) => {
    const result = await client.query<{ n: string }>(`select count(*)::text as n from ${table}`);
    return Number(result.rows[0]?.n ?? '0');
  });

const offers = (): Promise<string[]> =>
  h.owner(async (client) => {
    const result = await client.query<{ category_slug: string; template_key: string }>(
      `select l.category_slug, o.template_key
         from kelo.listing_plan_offer o join kelo.listing l on l.id = o.listing_id
        where o.withdrawn_at is null`,
    );
    return result.rows.map((row) => `${row.category_slug}:${row.template_key}`);
  });

beforeAll(async () => {
  h = await startHarness();
}, 120_000);

afterAll(async () => {
  await h.close();
}, 60_000);

describe('demo catalogue', () => {
  it('publishes at least one listing in each of the twelve categories, without a ledger entry', async () => {
    const entriesBefore = await count('ledger.journal_entry');
    await seedDemo((type) => h.app.get(type));

    const categories = await h.http().get('/v1/kelo/categories');
    const slugs = (categories.body.data as { slug: string }[]).map((c) => c.slug);
    expect(slugs).toHaveLength(12);
    for (const slug of slugs) {
      const listings = await h.http().get(`/v1/kelo/marketplace/listings?category=${slug}`);
      expect(listings.status, slug).toBe(200);
      expect(listings.body.data.length, slug).toBeGreaterThan(0);
    }
    expect(await count('ledger.journal_entry')).toBe(entriesBefore);
  }, 120_000);

  it('offers layaway for K4 holidays, and no credit plan while the flag is off', async () => {
    const offered = await offers();
    expect(offered.some((entry) => entry.startsWith('holidays:'))).toBe(true);
    expect(offered.some((entry) => entry.includes('pay_in_4') || entry.includes('monthly'))).toBe(
      false,
    );

    const holidays = await h.http().get('/v1/kelo/marketplace/listings?category=holidays');
    const detail = await h
      .http()
      .get(`/v1/kelo/marketplace/listings/${holidays.body.data[0].id as string}`);
    expect(detail.body.sessions.length).toBeGreaterThan(0);
    const plans = await h
      .http()
      .get(
        `/v1/kelo/marketplace/listings/${detail.body.id as string}/plans?session_id=${detail.body.sessions[0].id as string}`,
      );
    expect(
      (plans.body.data as { plan_type: string }[]).some((plan) => plan.plan_type === 'layaway'),
    ).toBe(true);
  });

  it('adds the credit plans of K2 electronics and K3 solar when run again with the flag on', async () => {
    await h.owner((client) =>
      client.query(`update ops.feature_flag set enabled = true where key = 'kelo_credit'`),
    );
    await seedDemo((type) => h.app.get(type));
    const offered = await offers();
    expect(offered).toContain('electronics:sandbox_pay_in_4');
    expect(offered).toContain('solar-home-systems:sandbox_monthly_6');
  }, 120_000);

  it('changes nothing when run again', async () => {
    const tables = [
      'identity.user_account',
      'kelo.store',
      'kelo.listing',
      'kelo.listing_variant',
      'kelo.listing_session',
      'kelo.listing_plan_offer',
      'tenancy.workspace',
      'audit.audit_event',
    ];
    const before = await Promise.all(tables.map(count));
    await seedDemo((type) => h.app.get(type));
    expect(await Promise.all(tables.map(count))).toEqual(before);
  }, 120_000);

  it('uses synthetic identities nobody can sign in as', async () => {
    const accounts = await h.owner(async (client) => {
      const result = await client.query<{
        clerk_user_id: string;
        email: string;
        phone_e164: string;
      }>(
        `select clerk_user_id, email, phone_e164 from identity.user_account where clerk_user_id like 'demo_%'`,
      );
      return result.rows;
    });
    expect(accounts.length).toBe(DEMO_STORES.length + 1);
    for (const account of accounts) {
      expect(account.email.endsWith('.aora.test')).toBe(true);
      expect(account.phone_e164.startsWith('+999')).toBe(true);
      // Clerk user ids start with `user_`; a `demo_` subject can never match one.
      expect(account.clerk_user_id.startsWith('user_')).toBe(false);
    }
  });
});
