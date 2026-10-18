import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './support/harness.js';
import { newUser } from './support/users.js';

/**
 * Quotes for quote-based services (ADR 0017), and the consumer row-level
 * barrier (phase-4 P4-6). Written before the code.
 */

let h: Harness;
let operator: string;
let merchant: { token: string; workspace: string };
let movingListing: string;
let stockListing: string;

type Who = { token: string; workspace?: string };
const call = (who: Who, method: 'get' | 'post', path: string, body: object = {}) => {
  let r = h.http()[method](path).set('Authorization', `Bearer ${who.token}`);
  if (who.workspace) r = r.set('Aora-Workspace-Id', who.workspace);
  return method === 'post' ? r.send(body) : r;
};

async function provisionedStore(
  categories: string[],
): Promise<{ token: string; workspace: string }> {
  const owner = await newUser(h, 'Mover');
  const created = await call(owner, 'post', '/v1/kelo/stores', {
    display_name: 'Sandbox Movers',
    categories,
    business: {
      kind: 'registered',
      name: `Movers ${randomUUID().slice(0, 8)} Ltd`,
      country: 'KE',
      registration: { type: 'sandbox_registration_number', value: randomUUID().slice(0, 12) },
    },
  }).set('Idempotency-Key', randomUUID());
  const detail = await call(
    { token: operator },
    'get',
    `/v1/ops/kelo/stores/${created.body.id as string}`,
  );
  const attestations = Object.fromEntries(
    (detail.body.categories as { slug: string; requirements: string[] }[]).map((c) => [
      c.slug,
      c.requirements,
    ]),
  );
  await call(
    { token: operator },
    'post',
    `/v1/ops/kelo/stores/${created.body.id as string}/decision`,
    {
      outcome: 'approved',
      reason: 'Sandbox vetting completed.',
      attestations,
    },
  );
  await h.settle();
  const store = await call(owner, 'get', `/v1/kelo/stores/${created.body.id as string}`);
  return { token: owner.token, workspace: store.body.workspace_id as string };
}

async function publish(body: Record<string, unknown>, variant = false): Promise<string> {
  const created = await call(merchant, 'post', '/v1/workspace/kelo/listings', {
    currency: 'KES',
    ...body,
  });
  expect(created.status).toBe(201);
  const id = created.body.id as string;
  if (variant) {
    await call(merchant, 'post', `/v1/workspace/kelo/listings/${id}/variants`, {
      name: 'Standard',
      price_minor: '500000',
      stock_on_hand: 3,
    });
  }
  expect((await call(merchant, 'post', `/v1/workspace/kelo/listings/${id}/submit`)).status).toBe(
    200,
  );
  await call({ token: operator }, 'post', `/v1/ops/kelo/listings/${id}/decision`, {
    outcome: 'approved',
    reason: 'Sandbox moderation decision.',
  });
  return id;
}

function requestQuote(who: Who, listing: string, key: string = randomUUID()): Promise<Response> {
  return call(who, 'post', '/v1/kelo/quote-requests', {
    listing_id: listing,
    details: 'Two-bedroom flat, third floor, moving across town on a weekday.',
  }).set('Idempotency-Key', key);
}

const inDays = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString();

beforeAll(async () => {
  h = await startHarness();
  operator = await h.signIn('operator');
  merchant = await provisionedStore(['moving', 'electronics']);
  movingListing = await publish({
    category: 'moving',
    type: 'quote_service',
    title: 'Sandbox household move',
    description: 'We move households within the city.',
  });
  stockListing = await publish(
    {
      category: 'electronics',
      type: 'stock_item',
      title: 'Sandbox radio',
      description: 'A sandbox radio.',
    },
    true,
  );
});
afterAll(() => h.close());

describe('requesting a quote', () => {
  it('records a request for a published quote-based listing, idempotently', async () => {
    const buyer = await newUser(h, 'Buyer');
    const key = randomUUID();
    const first = await requestQuote(buyer, movingListing, key);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      status: 'open',
      listing_id: movingListing,
      quotes: [],
      mode: 'sandbox',
    });
    const again = await requestQuote(buyer, movingListing, key);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
  });

  it('refuses a listing that is not quote-based, or not published', async () => {
    const buyer = await newUser(h, 'Buyer');
    expect((await requestQuote(buyer, stockListing)).status).toBe(400);
    expect((await requestQuote(buyer, randomUUID())).status).toBe(404);
  });

  it('needs a signed-in person', async () => {
    const anonymous = await h
      .http()
      .post('/v1/kelo/quote-requests')
      .send({ listing_id: movingListing, details: 'x' });
    expect(anonymous.status).toBe(401);
  });
});

describe('quoting', () => {
  it('lets the merchant see the request and answer it with a price and an expiry', async () => {
    const buyer = await newUser(h, 'Buyer');
    const request = await requestQuote(buyer, movingListing);
    const inbox = await call(merchant, 'get', '/v1/workspace/kelo/quote-requests');
    expect(inbox.status).toBe(200);
    const row = (inbox.body.data as { id: string; details: string }[]).find(
      (r) => r.id === request.body.id,
    );
    expect(row?.details).toContain('Two-bedroom');
    // The merchant sees the request, never who the buyer is beyond the request itself.
    expect(JSON.stringify(row)).not.toContain(buyer.email);

    const quoted = await call(
      merchant,
      'post',
      `/v1/workspace/kelo/quote-requests/${request.body.id as string}/quotes`,
      {
        price_minor: '2500000',
        expires_at: inDays(7),
      },
    );
    expect(quoted.status).toBe(201);
    expect(quoted.body).toMatchObject({
      price_minor: '2500000',
      currency: 'KES',
      status: 'offered',
    });

    const mine = await call(buyer, 'get', '/v1/kelo/me/quote-requests');
    const seen = (
      mine.body.data as { id: string; status: string; quotes: { price_minor: string }[] }[]
    ).find((r) => r.id === request.body.id);
    expect(seen).toMatchObject({ status: 'quoted' });
    expect(seen?.quotes.map((q) => q.price_minor)).toEqual(['2500000']);
  });

  it('refuses an expiry in the past or more than 30 days ahead, and a quote from another workspace', async () => {
    const buyer = await newUser(h, 'Buyer');
    const request = await requestQuote(buyer, movingListing);
    const path = `/v1/workspace/kelo/quote-requests/${request.body.id as string}/quotes`;
    expect(
      (await call(merchant, 'post', path, { price_minor: '100000', expires_at: inDays(-1) }))
        .status,
    ).toBe(400);
    expect(
      (await call(merchant, 'post', path, { price_minor: '100000', expires_at: inDays(31) }))
        .status,
    ).toBe(400);
    const adminB = { token: await h.signIn('adminB'), workspace: h.seed.tenantB };
    expect(
      (await call(adminB, 'post', path, { price_minor: '100000', expires_at: inDays(3) })).status,
    ).toBe(404);
  });

  it('shows a quote past its expiry as expired, and lets the buyer decline a live one', async () => {
    const buyer = await newUser(h, 'Buyer');
    const request = await requestQuote(buyer, movingListing);
    const path = `/v1/workspace/kelo/quote-requests/${request.body.id as string}/quotes`;
    const quote = await call(merchant, 'post', path, {
      price_minor: '900000',
      expires_at: inDays(2),
    });
    // Time passes: a quote is immutable, so the test steps around its trigger, as superuser only.
    await h.owner(async (client) => {
      await client.query('begin');
      await client.query(`set local session_replication_role = replica`);
      await client.query(
        `update kelo.quote set created_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute' where id = $1`,
        [quote.body.id],
      );
      await client.query('commit');
    });
    const mine = await call(buyer, 'get', '/v1/kelo/me/quote-requests');
    const seen = (mine.body.data as { id: string; quotes: { status: string }[] }[]).find(
      (r) => r.id === request.body.id,
    );
    expect(seen?.quotes[0]?.status).toBe('expired');

    const fresh = await call(merchant, 'post', path, {
      price_minor: '800000',
      expires_at: inDays(2),
    });
    const declined = await call(
      buyer,
      'post',
      `/v1/kelo/me/quotes/${fresh.body.id as string}/decline`,
    );
    expect(declined.status).toBe(200);
    expect(declined.body.status).toBe('declined');
    const again = await call(
      buyer,
      'post',
      `/v1/kelo/me/quotes/${fresh.body.id as string}/decline`,
    );
    expect(again.status).toBe(409);
  });
});

describe('consumer isolation (P4-6)', () => {
  it("never shows one buyer another buyer's requests or quotes", async () => {
    const alice = await newUser(h, 'Alice');
    const bob = await newUser(h, 'Bob');
    const request = await requestQuote(alice, movingListing);
    const quote = await call(
      merchant,
      'post',
      `/v1/workspace/kelo/quote-requests/${request.body.id as string}/quotes`,
      {
        price_minor: '700000',
        expires_at: inDays(5),
      },
    );
    const bobs = await call(bob, 'get', '/v1/kelo/me/quote-requests');
    expect(bobs.body.data).toEqual([]);
    expect(
      (await call(bob, 'post', `/v1/kelo/me/quotes/${quote.body.id as string}/decline`)).status,
    ).toBe(404);
  });

  it('enforces it at the database: each buyer sees only their own rows, and nobody sees any without a context', async () => {
    const alice = await newUser(h, 'Alice');
    const bob = await newUser(h, 'Bob');
    const request = await requestQuote(alice, movingListing);
    const countFor = (accountId: string) =>
      h.db.withConsumer(accountId, async (tx) => {
        const rows = await tx.$queryRaw<{ n: bigint }[]>`
          select count(*) n from kelo.quote_request where id = ${request.body.id as string}::uuid`;
        return Number(rows[0]?.n);
      });
    expect(await countFor(alice.accountId)).toBe(1);
    expect(await countFor(bob.accountId)).toBe(0);
    const none = await h.db.withoutTenantForTest(
      (tx) => tx.$queryRaw<{ n: bigint }[]>`select count(*) n from kelo.quote_request`,
    );
    expect(Number(none[0]?.n)).toBe(0);
    const otherTenant = await h.db.withTenant(
      h.seed.tenantB,
      (tx) => tx.$queryRaw<{ n: bigint }[]>`select count(*) n from kelo.quote_request`,
    );
    expect(Number(otherTenant[0]?.n)).toBe(0);
  });

  it('does not leak the consumer setting into the next transaction on the connection', async () => {
    const alice = await newUser(h, 'Alice');
    await h.db.withConsumer(alice.accountId, () => Promise.resolve());
    const after = await h.db.withoutTenantForTest(
      (tx) =>
        tx.$queryRaw<
          { v: string | null }[]
        >`select nullif(current_setting('app.account_id', true), '') v`,
    );
    expect(after[0]?.v ?? null).toBeNull();
  });
});
