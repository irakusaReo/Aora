import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PURCHASE_TRANSITIONS } from '../src/modules/kelo/layaway.service.js';
import { type Harness, startHarness } from './support/harness.js';
import { balanceOf, trialBalance } from './support/money.js';
import { exceptionTypes } from './support/payments.js';
import { newUser } from './support/users.js';

/**
 * Journey K4: a layaway purchase of a holiday package (ADRs 0017, 0018).
 * No credit is extended. Written before the code.
 */

let h: Harness;
let operator: string;
let merchant: { token: string; workspace: string };
let holiday: string;
let session: string;
let radio: string;
let radioVariant: string;

type Who = { token: string; workspace?: string };
const call = (who: Who, method: 'get' | 'post', path: string, body: object = {}) => {
  let r = h.http()[method](path).set('Authorization', `Bearer ${who.token}`);
  if (who.workspace) r = r.set('Aora-Workspace-Id', who.workspace);
  return method === 'post' ? r.send(body) : r;
};
const cron = (job: string) =>
  h
    .http()
    .get(`/v1/internal/cron/${job}`)
    .set('Authorization', `Bearer ${h.config.cronSecret ?? ''}`);

const PRICE = 4_500_001n; // KES 45,000.01: not divisible by 4, so the last instalment takes the remainder.
const TEMPLATE = 'sandbox_layaway_4x2w';

async function store(categories: string[]): Promise<{ token: string; workspace: string }> {
  const owner = await newUser(h, 'Merchant');
  const created = await call(owner, 'post', '/v1/kelo/stores', {
    display_name: 'Sandbox Holidays',
    categories,
    business: {
      kind: 'registered',
      name: `Holidays ${randomUUID().slice(0, 8)} Ltd`,
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
  const view = await call(owner, 'get', `/v1/kelo/stores/${created.body.id as string}`);
  return { token: owner.token, workspace: view.body.workspace_id as string };
}

async function publish(listing: string): Promise<void> {
  expect(
    (await call(merchant, 'post', `/v1/workspace/kelo/listings/${listing}/submit`)).status,
  ).toBe(200);
  await call({ token: operator }, 'post', `/v1/ops/kelo/listings/${listing}/decision`, {
    outcome: 'approved',
    reason: 'Sandbox moderation decision.',
  });
}

async function plansFor(listing: string, query: string): Promise<Response> {
  return h.http().get(`/v1/kelo/marketplace/listings/${listing}/plans?${query}`);
}

async function buy(
  who: Who,
  body: Record<string, unknown> = {},
  key: string = randomUUID(),
): Promise<Response> {
  const terms = await h.http().get('/v1/terms/kelo_layaway_terms');
  return call(who, 'post', '/v1/kelo/purchases', {
    listing_id: holiday,
    session_id: session,
    template_key: TEMPLATE,
    expected_total_minor: PRICE.toString(),
    terms_version: terms.body.version as string,
    ...body,
  }).set('Idempotency-Key', key);
}

const pay = (who: Who, purchase: string, seq: number, scenario = 'success', key = randomUUID()) =>
  call(who, 'post', `/v1/kelo/me/purchases/${purchase}/instalments/${String(seq)}/pay`, {
    sandbox_scenario: scenario,
  }).set('Idempotency-Key', key);

const purchaseOf = async (who: Who, id: string) =>
  (await call(who, 'get', `/v1/kelo/me/purchases/${id}`)).body;

async function payAll(who: Who, purchase: string): Promise<void> {
  for (let seq = 1; seq <= 4; seq += 1) {
    expect((await pay(who, purchase, seq)).status).toBe(202);
    await h.settle();
  }
}

/** Lets the session start (scheduled services are fulfilled when they start). */
const startSession = (id: string) =>
  h.owner((client) =>
    client.query(
      `update kelo.listing_session set starts_at = now() - interval '1 hour' where id = $1`,
      [id],
    ),
  );

beforeAll(async () => {
  h = await startHarness();
  operator = await h.signIn('operator');
  merchant = await store(['holidays', 'electronics']);

  const created = await call(merchant, 'post', '/v1/workspace/kelo/listings', {
    category: 'holidays',
    type: 'scheduled_service',
    title: 'Sandbox coast weekend',
    description: 'Two nights at a sandbox resort, breakfast included.',
    currency: 'KES',
  });
  holiday = created.body.id as string;
  const added = await call(merchant, 'post', `/v1/workspace/kelo/listings/${holiday}/sessions`, {
    starts_at: new Date(Date.now() + 90 * 86_400_000).toISOString(),
    price_minor: PRICE.toString(),
    capacity: 50,
  });
  session = added.body.id as string;
  await publish(holiday);

  const r = await call(merchant, 'post', '/v1/workspace/kelo/listings', {
    category: 'electronics',
    type: 'stock_item',
    title: 'Sandbox radio',
    description: 'A sandbox radio with a solar panel.',
    currency: 'KES',
  });
  radio = r.body.id as string;
  const v = await call(merchant, 'post', `/v1/workspace/kelo/listings/${radio}/variants`, {
    name: 'Black',
    price_minor: '800000',
    stock_on_hand: 2,
  });
  radioVariant = v.body.id as string;
  await publish(radio);
});
afterAll(() => h.close());

describe('purchase state machine', () => {
  it('allows exactly the layaway subset of the ADR 0017 order machine', () => {
    expect(PURCHASE_TRANSITIONS).toEqual({
      placed: ['payment_ready', 'cancelled'],
      payment_ready: ['merchant_confirmed', 'cancelled'],
      merchant_confirmed: ['fulfilled', 'cancelled'],
      fulfilled: ['completed'],
      completed: [],
      cancelled: [],
    });
  });
});

describe('offering layaway', () => {
  it('shows no plan until the merchant chooses to offer one', async () => {
    const plans = await plansFor(holiday, `session_id=${session}`);
    expect(plans.status).toBe(200);
    expect(plans.body.data).toEqual([]);
  });

  it('lists the templates the category allows, none offered by default, each with its fee', async () => {
    const options = await call(
      merchant,
      'get',
      `/v1/workspace/kelo/listings/${holiday}/plan-options`,
    );
    expect(options.status).toBe(200);
    const layaway = (
      options.body.data as { template_key: string; offered: boolean; merchant_fee_bps: number }[]
    ).find((o) => o.template_key === TEMPLATE);
    expect(layaway).toMatchObject({ offered: false });
    expect(typeof layaway?.merchant_fee_bps).toBe('number');
    const offered = await call(
      merchant,
      'post',
      `/v1/workspace/kelo/listings/${holiday}/plan-offers`,
      {
        template_key: TEMPLATE,
      },
    );
    expect(offered.status).toBe(201);
    await call(merchant, 'post', `/v1/workspace/kelo/listings/${radio}/plan-offers`, {
      template_key: TEMPLATE,
    });
  });

  it('shows the full schedule, the total and the cancellation rule before anything is agreed', async () => {
    const plans = await plansFor(holiday, `session_id=${session}`);
    const [plan] = plans.body.data as {
      template_key: string;
      plan_type: string;
      total_minor: string;
      fees_minor: string;
      receive_after_last_payment: boolean;
      instalments: { seq: number; amount_minor: string }[];
      cancellation: { fee_bps: number; fee_cap_minor: string };
    }[];
    expect(plan).toMatchObject({
      template_key: TEMPLATE,
      plan_type: 'layaway',
      total_minor: PRICE.toString(),
      fees_minor: '0',
      receive_after_last_payment: true,
    });
    expect(plan?.instalments.map((i) => i.amount_minor)).toEqual([
      '1125000',
      '1125000',
      '1125000',
      '1125001',
    ]);
    expect(plan?.cancellation.fee_bps).toEqual(expect.any(Number));
  });
});

describe('buying on layaway (K4)', () => {
  it('needs the total the buyer was shown, and terms in effect', async () => {
    const buyer = await newUser(h, 'Buyer');
    const wrong = await buy(buyer, { expected_total_minor: (PRICE - 1n).toString() });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.code).toBe('fee_changed');
    const oldTerms = await buy(buyer, { terms_version: 'not-a-version' });
    expect(oldTerms.status).toBe(400);
  });

  it('places the purchase, reserves a place, records consent, and creates no credit agreement', async () => {
    const buyer = await newUser(h, 'Buyer');
    const key = randomUUID();
    const placed = await buy(buyer, {}, key);
    expect(placed.status).toBe(201);
    expect(placed.body).toMatchObject({
      status: 'placed',
      plan_status: 'active',
      plan_type: 'layaway',
      total_minor: PRICE.toString(),
      paid_minor: '0',
      mode: 'sandbox',
    });
    expect(placed.body).not.toHaveProperty('credit_limit');
    expect(placed.body.instalments).toHaveLength(4);
    const again = await buy(buyer, {}, key);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(placed.body.id);

    const reserved = await h.owner((c) =>
      c.query(`select reserved from kelo.listing_session where id = $1`, [session]),
    );
    expect(reserved.rows[0].reserved).toBeGreaterThanOrEqual(1);
    const consents = await h.owner((c) =>
      c.query(
        `select t.key, t.version from consent.consent_record r join consent.terms_document t on t.id = r.terms_document_id
          where r.account_id = $1 and r.action = 'kelo.layaway.accept'`,
        [buyer.accountId],
      ),
    );
    expect(consents.rows).toEqual([expect.objectContaining({ key: 'kelo_layaway_terms' })]);
  });

  it('holds every instalment in "layaway funds held", never with the merchant, and settles nothing early', async () => {
    const buyer = await newUser(h, 'Buyer');
    const purchase = (await buy(buyer)).body.id as string;
    const heldBefore = await balanceOf(h, null, 'kelo_layaway_funds_held');
    const pendingBefore = await balanceOf(h, merchant.workspace, 'merchant_collections_pending');
    const availableBefore = await balanceOf(h, merchant.workspace, 'merchant_available');

    const started = await pay(buyer, purchase, 1);
    expect(started.status).toBe(202);
    await h.settle();
    await cron('settlement');

    expect(await balanceOf(h, null, 'kelo_layaway_funds_held')).toBe(heldBefore + 1_125_000n);
    expect(await balanceOf(h, merchant.workspace, 'merchant_collections_pending')).toBe(
      pendingBefore,
    );
    expect(await balanceOf(h, merchant.workspace, 'merchant_available')).toBe(availableBefore);
    const view = await purchaseOf(buyer, purchase);
    expect(view).toMatchObject({ status: 'payment_ready', paid_minor: '1125000' });
    expect(view.instalments[0].status).toBe('paid');
    // Not one of the merchant's collections.
    const collections = await call(merchant, 'get', '/v1/payment-intents');
    expect(JSON.stringify(collections.body)).not.toContain('"amount_minor":"1125000"');
    // Nor can the merchant refund it as if it were one.
    const intentId = started.body.payment_intent_id as string;
    expect((await call(merchant, 'get', `/v1/payment-intents/${intentId}`)).status).toBe(404);
    await h.stepUp(merchant.token);
    const refund = await call(merchant, 'post', `/v1/payment-intents/${intentId}/refunds`, {
      amount_minor: '1000',
    }).set('Idempotency-Key', randomUUID());
    expect(refund.status).toBe(404);
  });

  it('takes instalments in order only', async () => {
    const buyer = await newUser(h, 'Buyer');
    const purchase = (await buy(buyer)).body.id as string;
    const early = await pay(buyer, purchase, 2);
    expect(early.status).toBe(409);
  });

  it('never re-pushes an instalment whose payment is unknown, and settles it once the status is known', async () => {
    const buyer = await newUser(h, 'Buyer');
    const purchase = (await buy(buyer)).body.id as string;
    expect((await pay(buyer, purchase, 1, 'timeout_then_success')).status).toBe(202);
    await h.settle();
    const checking = await purchaseOf(buyer, purchase);
    expect(checking.instalments[0].status).toBe('pending');
    expect((await pay(buyer, purchase, 1)).status).toBe(409);
    await h.makeDelayedEventsDue();
    await h.settle();
    const done = await purchaseOf(buyer, purchase);
    expect(done.instalments[0].status).toBe('paid');
    const intents = await h.owner((c) =>
      c.query(
        `select count(*)::int n from payments.payment_intent where purpose = 'kelo_layaway' and created_by = $1`,
        [buyer.accountId],
      ),
    );
    expect(intents.rows[0].n).toBe(1);
  });

  it('lets a declined instalment be paid again', async () => {
    const buyer = await newUser(h, 'Buyer');
    const purchase = (await buy(buyer)).body.id as string;
    await pay(buyer, purchase, 1, 'decline');
    await h.settle();
    expect((await purchaseOf(buyer, purchase)).instalments[0].status).toBe('due');
    expect((await pay(buyer, purchase, 1)).status).toBe(202);
    await h.settle();
    expect((await purchaseOf(buyer, purchase)).instalments[0].status).toBe('paid');
  });

  it('fulfils only after the last instalment, then settles the merchant net of the discount fee, exactly', async () => {
    const buyer = await newUser(h, 'Buyer');
    const purchase = (await buy(buyer)).body.id as string;
    await pay(buyer, purchase, 1);
    await h.settle();
    expect(
      (await call(merchant, 'post', `/v1/workspace/kelo/purchases/${purchase}/confirm`)).status,
    ).toBe(200);
    await startSession(session);
    const tooEarly = await call(
      merchant,
      'post',
      `/v1/workspace/kelo/purchases/${purchase}/fulfil`,
    );
    expect(tooEarly.status).toBe(409);

    for (let seq = 2; seq <= 4; seq += 1) {
      await pay(buyer, purchase, seq);
      await h.settle();
    }
    expect((await purchaseOf(buyer, purchase)).plan_status).toBe('paid_in_full');

    const available = await balanceOf(h, merchant.workspace, 'merchant_available');
    const fees = await balanceOf(h, null, 'kelo_fee_revenue');
    const held = await balanceOf(h, null, 'kelo_layaway_funds_held');
    const fulfilled = await call(
      merchant,
      'post',
      `/v1/workspace/kelo/purchases/${purchase}/fulfil`,
    );
    expect(fulfilled.status).toBe(200);
    expect(fulfilled.body).toMatchObject({ status: 'completed', plan_status: 'settled' });
    const fee = BigInt(fulfilled.body.merchant_fee_minor as string);
    expect(fee).toBeGreaterThan(0n);
    expect(await balanceOf(h, merchant.workspace, 'merchant_available')).toBe(
      available + PRICE - fee,
    );
    expect(await balanceOf(h, null, 'kelo_fee_revenue')).toBe(fees + fee);
    expect(await balanceOf(h, null, 'kelo_layaway_funds_held')).toBe(held - PRICE);
    expect(fulfilled.body.net_minor).toBe((PRICE - fee).toString());

    expect(await trialBalance(h)).toBe(0n);
    await cron('reconciliation');
    expect(await exceptionTypes(h)).toEqual([]);
    // Back to a future date for the other tests.
    await h.owner((c) =>
      c.query(
        `update kelo.listing_session set starts_at = now() + interval '90 days' where id = $1`,
        [session],
      ),
    );
  });

  it('refunds a cancellation by the configured rule, to the minor unit, and releases the place', async () => {
    const buyer = await newUser(h, 'Buyer');
    const purchase = (await buy(buyer)).body.id as string;
    await pay(buyer, purchase, 1);
    await h.settle();
    await pay(buyer, purchase, 2);
    await h.settle();
    const reservedBefore = (
      await h.owner((c) =>
        c.query(`select reserved from kelo.listing_session where id = $1`, [session]),
      )
    ).rows[0].reserved as number;

    const cancelled = await call(buyer, 'post', `/v1/kelo/me/purchases/${purchase}/cancel`);
    expect(cancelled.status).toBe(200);
    // Paid 2,250,000; the sandbox rule keeps 5% (112,500) capped at KES 1,000.00 (100,000).
    expect(cancelled.body).toMatchObject({
      status: 'cancelled',
      refund: { paid_minor: '2250000', fee_minor: '100000', refund_minor: '2150000' },
    });
    await h.settle();
    const after = await purchaseOf(buyer, purchase);
    expect(after.plan_status).toBe('refunded');
    expect(after.refund.status).toBe('succeeded');
    const reservedAfter = (
      await h.owner((c) =>
        c.query(`select reserved from kelo.listing_session where id = $1`, [session]),
      )
    ).rows[0].reserved as number;
    expect(reservedAfter).toBe(reservedBefore - 1);
    expect(await trialBalance(h)).toBe(0n);
    expect((await call(buyer, 'post', `/v1/kelo/me/purchases/${purchase}/cancel`)).status).toBe(
      409,
    );
  });

  it('never lets the merchant settle or fulfil a cancelled purchase', async () => {
    const buyer = await newUser(h, 'Buyer');
    const purchase = (await buy(buyer)).body.id as string;
    await call(buyer, 'post', `/v1/kelo/me/purchases/${purchase}/cancel`);
    expect(
      (await call(merchant, 'post', `/v1/workspace/kelo/purchases/${purchase}/confirm`)).status,
    ).toBe(409);
  });
});

describe('stock items and consumer confirmation', () => {
  it('reserves stock, refuses to oversell under concurrent purchases, and is fulfilled by the buyer confirming delivery', async () => {
    const terms = await h.http().get('/v1/terms/kelo_layaway_terms');
    const buyers = await Promise.all([newUser(h, 'A'), newUser(h, 'B'), newUser(h, 'C')]);
    const results = await Promise.all(
      buyers.map((buyer) =>
        call(buyer, 'post', '/v1/kelo/purchases', {
          listing_id: radio,
          variant_id: radioVariant,
          template_key: TEMPLATE,
          expected_total_minor: '800000',
          terms_version: terms.body.version as string,
        }).set('Idempotency-Key', randomUUID()),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 201, 409]);
    expect(results.find((r) => r.status === 409)?.body.error.code).toBe('sold_out');

    const index = results.findIndex((r) => r.status === 201);
    const buyer = buyers[index];
    const purchase = results[index]?.body.id as string;
    if (buyer === undefined) throw new Error('no buyer');
    await payAll(buyer, purchase);
    await call(merchant, 'post', `/v1/workspace/kelo/purchases/${purchase}/confirm`);
    // Electronics needs the buyer's confirmation, not the merchant's word.
    expect(
      (await call(merchant, 'post', `/v1/workspace/kelo/purchases/${purchase}/fulfil`)).status,
    ).toBe(409);
    const confirmed = await call(
      buyer,
      'post',
      `/v1/kelo/me/purchases/${purchase}/confirm-delivery`,
    );
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe('completed');
    const stock = await h.owner((c) =>
      c.query(`select stock_on_hand, stock_reserved from kelo.listing_variant where id = $1`, [
        radioVariant,
      ]),
    );
    expect(stock.rows[0]).toEqual({ stock_on_hand: 1, stock_reserved: 1 });
  });
});

describe('isolation', () => {
  it("shows a buyer only their own purchases, and a merchant only its own, without the buyer's identity", async () => {
    const buyer = await newUser(h, 'Buyer');
    const purchase = (await buy(buyer)).body.id as string;
    const other = await newUser(h, 'Other');
    expect((await call(other, 'get', `/v1/kelo/me/purchases/${purchase}`)).status).toBe(404);
    expect((await call(other, 'post', `/v1/kelo/me/purchases/${purchase}/cancel`)).status).toBe(
      404,
    );
    const adminB = { token: await h.signIn('adminB'), workspace: h.seed.tenantB };
    expect(
      (await call(adminB, 'post', `/v1/workspace/kelo/purchases/${purchase}/confirm`)).status,
    ).toBe(404);
    const list = await call(merchant, 'get', '/v1/workspace/kelo/purchases');
    expect(list.status).toBe(200);
    expect((list.body.data as { id: string }[]).map((p) => p.id)).toContain(purchase);
    expect(JSON.stringify(list.body)).not.toContain(buyer.email);
    const seen = await h.db.withConsumer(
      other.accountId,
      (tx) =>
        tx.$queryRaw<
          { n: bigint }[]
        >`select count(*) n from kelo.purchase where id = ${purchase}::uuid`,
    );
    expect(Number(seen[0]?.n)).toBe(0);
  });
});
