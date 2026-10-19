import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGREEMENT_TRANSITIONS } from '../src/modules/kelo/credit/credit.service.js';
import { type Harness, startHarness } from './support/harness.js';
import { balanceOf, trialBalance } from './support/money.js';
import { newUser } from './support/users.js';

/**
 * Phase 8A: KELO credit behind the `kelo_credit` flag (phase-8 plan P8-1 to
 * P8-12; journeys K2, K3, K6). Written before the code.
 */

let h: Harness;
let operator: string;
let merchant: { token: string; workspace: string };
let radio: string;
let radioVariant: string;
let solar: string;
let solarVariant: string;

type Who = { token: string; workspace?: string };
const call = (who: Who, method: 'get' | 'post', path: string, body: object = {}) => {
  let r = h.http()[method](path).set('Authorization', `Bearer ${who.token}`);
  if (who.workspace) r = r.set('Aora-Workspace-Id', who.workspace);
  return method === 'post' ? r.send(body) : r;
};

const RADIO_PRICE = 800_001n; // KES 8,000.01: Pay in 4, the last part takes the remainder.
const SOLAR_PRICE = 4_500_000n; // KES 45,000: monthly financing, 10% deposit.
const PAY_IN_4 = 'sandbox_pay_in_4';
const MONTHLY_6 = 'sandbox_monthly_6';
const INCOME = '15000000'; // KES 150,000 a month, declared.

async function store(categories: string[]): Promise<{ token: string; workspace: string }> {
  const owner = await newUser(h, 'Merchant');
  const created = await call(owner, 'post', '/v1/kelo/stores', {
    display_name: 'Sandbox Electronics',
    categories,
    business: {
      kind: 'registered',
      name: `Electronics ${randomUUID().slice(0, 8)} Ltd`,
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
    { outcome: 'approved', reason: 'Sandbox vetting completed.', attestations },
  );
  await h.settle();
  const view = await call(owner, 'get', `/v1/kelo/stores/${created.body.id as string}`);
  return { token: owner.token, workspace: view.body.workspace_id as string };
}

async function listing(
  category: string,
  title: string,
  price: bigint,
  stock: number,
): Promise<{ listing: string; variant: string }> {
  const created = await call(merchant, 'post', '/v1/workspace/kelo/listings', {
    category,
    type: 'stock_item',
    title,
    description: `${title}, sandbox stock for credit tests.`,
    currency: 'KES',
  });
  const id = created.body.id as string;
  const variant = await call(merchant, 'post', `/v1/workspace/kelo/listings/${id}/variants`, {
    name: 'Standard',
    price_minor: price.toString(),
    stock_on_hand: stock,
  });
  expect((await call(merchant, 'post', `/v1/workspace/kelo/listings/${id}/submit`)).status).toBe(
    200,
  );
  await call({ token: operator }, 'post', `/v1/ops/kelo/listings/${id}/decision`, {
    outcome: 'approved',
    reason: 'Sandbox moderation decision.',
  });
  return { listing: id, variant: variant.body.id as string };
}

const setFlag = async (enabled: boolean): Promise<Response> => {
  await h.stepUp(operator);
  return call({ token: operator }, 'post', '/v1/ops/feature-flags/kelo_credit', {
    enabled,
    reason: enabled ? 'Sandbox: credit tests.' : 'Sandbox: switched back off.',
  });
};

const decide = (
  who: Who,
  body: Record<string, unknown> = {},
  key: string = randomUUID(),
): Promise<Response> =>
  call(who, 'post', '/v1/kelo/credit/decisions', {
    listing_id: radio,
    variant_id: radioVariant,
    template_key: PAY_IN_4,
    declared_monthly_income_minor: INCOME,
    ...body,
  }).set('Idempotency-Key', key);

async function documents(templateKey: string): Promise<{ agreement: string; kid: string }> {
  const agreement = await h.http().get('/v1/terms/kelo_credit_agreement');
  const kid = await h.http().get(`/v1/terms/kelo_credit_kid_${templateKey}`);
  return { agreement: agreement.body.version as string, kid: kid.body.version as string };
}

async function buyWith(
  who: Who,
  decision: Response,
  key: string = randomUUID(),
): Promise<Response> {
  const plan = decision.body.plan as { template_key: string; total_payable_minor: string };
  const docs = await documents(plan.template_key);
  return call(who, 'post', '/v1/kelo/purchases', {
    decision_id: decision.body.id as string,
    expected_total_payable_minor: plan.total_payable_minor,
    agreement_version: docs.agreement,
    kid_version: docs.kid,
  }).set('Idempotency-Key', key);
}

const pay = (who: Who, purchase: string, seq: number, scenario = 'success', key = randomUUID()) =>
  call(who, 'post', `/v1/kelo/me/purchases/${purchase}/credit/instalments/${String(seq)}/pay`, {
    sandbox_scenario: scenario,
  }).set('Idempotency-Key', key);

const purchaseOf = async (who: Who, id: string) =>
  (await call(who, 'get', `/v1/kelo/me/purchases/${id}`)).body;

/** A consumer's own ledger balance of one account type, read past row-level security. */
const consumerBalance = (accountId: string, type: string): Promise<bigint> =>
  h.owner(async (client) => {
    const result = await client.query<{ balance: string }>(
      `select coalesce(sum(b.balance), 0)::text as balance from ledger.account a
         left join ledger.account_balance b on b.account_id = a.id
        where a.type = $2 and a.consumer_account_id = $1`,
      [accountId, type],
    );
    return BigInt(result.rows[0]?.balance ?? '0');
  });

/** Keys anywhere in a JSON value. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)]);
  }
  return [];
}
const BANNED = /balance|available|funds|cash/i;

beforeAll(async () => {
  h = await startHarness();
  operator = await h.signIn('operator');
  merchant = await store(['electronics', 'solar-home-systems']);
  ({ listing: radio, variant: radioVariant } = await listing(
    'electronics',
    'Sandbox radio',
    RADIO_PRICE,
    20,
  ));
  ({ listing: solar, variant: solarVariant } = await listing(
    'solar-home-systems',
    'Sandbox solar kit',
    SOLAR_PRICE,
    5,
  ));
  // Layaway stays available whatever the flag says.
  await call(merchant, 'post', `/v1/workspace/kelo/listings/${radio}/plan-offers`, {
    template_key: 'sandbox_layaway_4x2w',
  });
});
afterAll(() => h.close());

describe('agreement state machine', () => {
  it('allows exactly the transitions of the phase-8 plan', () => {
    expect(AGREEMENT_TRANSITIONS).toEqual({
      pending_first_payment: ['active', 'cancelled'],
      active: ['paid_off', 'cancelled', 'defaulted', 'paused'],
      defaulted: ['paused', 'active', 'paid_off'],
      paused: ['active', 'defaulted', 'cancelled'],
      paid_off: [],
      cancelled: [],
    });
  });
});

describe('with the flag off (P8-1)', () => {
  it('starts off', async () => {
    const flags = await call({ token: operator }, 'get', '/v1/ops/feature-flags');
    expect(flags.status).toBe(200);
    expect(flags.body.data).toContainEqual(
      expect.objectContaining({ key: 'kelo_credit', enabled: false }),
    );
  });

  it('answers every credit route as if it did not exist', async () => {
    const buyer = await newUser(h, 'Buyer');
    expect((await call(buyer, 'get', '/v1/kelo/credit/limit')).status).toBe(404);
    const decision = await decide(buyer);
    expect(decision.status).toBe(404);
    expect(decision.body.error.code).toBe('not_found');
    expect((await call(buyer, 'get', `/v1/kelo/credit/decisions/${randomUUID()}`)).status).toBe(
      404,
    );
    const purchase = await call(buyer, 'post', '/v1/kelo/purchases', {
      decision_id: randomUUID(),
      expected_total_payable_minor: '1',
      agreement_version: 'x',
      kid_version: 'x',
    }).set('Idempotency-Key', randomUUID());
    expect(purchase.status).toBe(404);
  });

  it('offers no credit template to the merchant and shows no credit plan to the buyer', async () => {
    const options = await call(
      merchant,
      'get',
      `/v1/workspace/kelo/listings/${radio}/plan-options`,
    );
    const keys = (options.body.data as { template_key: string }[]).map((o) => o.template_key);
    expect(keys).not.toContain(PAY_IN_4);
    const refused = await call(
      merchant,
      'post',
      `/v1/workspace/kelo/listings/${radio}/plan-offers`,
      {
        template_key: PAY_IN_4,
      },
    );
    expect(refused.status).toBe(400);
    const plans = await h
      .http()
      .get(`/v1/kelo/marketplace/listings/${radio}/plans?variant_id=${radioVariant}`);
    expect(plans.status).toBe(200);
    expect((plans.body.data as { plan_type: string }[]).map((p) => p.plan_type)).toEqual([
      'layaway',
    ]);
    expect(JSON.stringify(plans.body)).not.toMatch(/credit|interest|apr/i);
  });
});

describe('the operator switch', () => {
  it('is for platform operators only, needs a step-up and a reason, and is audited', async () => {
    const someone = await newUser(h, 'Someone');
    await h.stepUp(operator);
    const denied = await call(someone, 'post', '/v1/ops/feature-flags/kelo_credit', {
      enabled: true,
      reason: 'Trying.',
    });
    expect(denied.status).toBe(403);
    const noReason = await call({ token: operator }, 'post', '/v1/ops/feature-flags/kelo_credit', {
      enabled: true,
    });
    expect(noReason.status).toBe(400);
    const unknown = await call({ token: operator }, 'post', '/v1/ops/feature-flags/not_a_flag', {
      enabled: true,
      reason: 'No such flag.',
    });
    expect([403, 404]).toContain(unknown.status);

    const on = await setFlag(true);
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ key: 'kelo_credit', enabled: true });
    const audit = await h.owner((c) =>
      c.query(
        `select detail from audit.audit_event where action = 'ops.feature_flag.changed' order by occurred_at desc limit 1`,
      ),
    );
    expect(audit.rows[0]?.detail).toMatchObject({ key: 'kelo_credit', enabled: true });
  });
});

describe('offering credit plans (flag on)', () => {
  it('lets the merchant offer the credit templates its category allows', async () => {
    const options = await call(
      merchant,
      'get',
      `/v1/workspace/kelo/listings/${radio}/plan-options`,
    );
    const keys = (options.body.data as { template_key: string }[]).map((o) => o.template_key);
    expect(keys).toContain(PAY_IN_4);
    expect(keys).not.toContain(MONTHLY_6); // electronics allows Pay in 4 only
    for (const [id, template] of [
      [radio, PAY_IN_4],
      [solar, MONTHLY_6],
    ] as const) {
      const offered = await call(
        merchant,
        'post',
        `/v1/workspace/kelo/listings/${id}/plan-offers`,
        {
          template_key: template,
        },
      );
      expect(offered.status).toBe(201);
    }
  });

  it('shows the whole cost before any decision: parts, interest, APR, the lender and the documents', async () => {
    const plans = await h
      .http()
      .get(`/v1/kelo/marketplace/listings/${solar}/plans?variant_id=${solarVariant}`);
    const monthly = (plans.body.data as Record<string, unknown>[]).find(
      (p) => p['template_key'] === MONTHLY_6,
    );
    expect(monthly).toMatchObject({
      plan_type: 'monthly_financing',
      pricing_model: 'daily_interest',
      total_minor: SOLAR_PRICE.toString(),
      deposit_minor: '450000',
      interest_total_minor: '212625',
      total_payable_minor: '4712625',
      apr_text: '18.25%',
      daily_rate_text: '0.0500%',
      needs_decision: true,
      receive_after_last_payment: false,
      lender_of_record: 'KELO sandbox book (simulated lender, not licensed)',
      kid: { key: `kelo_credit_kid_${MONTHLY_6}` },
      terms: { key: 'kelo_credit_agreement' },
      late_charges: { fee_minor: '10000', total_cap_minor: '60000', grace_days: 5 },
    });
    expect((monthly?.['instalments'] as unknown[]).length).toBe(7);
  });
});

describe('decisions (P8-5, K6)', () => {
  it('approves with an input snapshot, states the limit, and can be read back only by its owner', async () => {
    const buyer = await newUser(h, 'Buyer');
    const key = randomUUID();
    const decision = await decide(buyer, {}, key);
    expect(decision.status).toBe(201);
    expect(decision.body).toMatchObject({
      outcome: 'approved',
      reason_codes: [],
      lender_of_record: 'KELO sandbox book (simulated lender, not licensed)',
      limit: { limit_minor: '5000000', limit_used_minor: '0', currency: 'KES' },
      mode: 'sandbox',
    });
    expect(decision.body.plan).toMatchObject({
      template_key: PAY_IN_4,
      total_payable_minor: RADIO_PRICE.toString(),
    });
    const again = await decide(buyer, {}, key);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(decision.body.id);

    const stored = await h.owner((c) =>
      c.query(
        `select inputs, rule_set_version, limit_policy_version from kelo.credit_decision where id = $1`,
        [decision.body.id],
      ),
    );
    expect(stored.rows[0]).toMatchObject({ rule_set_version: 1, limit_policy_version: 1 });
    expect(stored.rows[0].inputs).toMatchObject({
      price_minor: RADIO_PRICE.toString(),
      declared_monthly_income_minor: INCOME,
      open_agreements: 0,
      limit_minor: '5000000',
      limit_used_minor: '0',
      bureau: 'not_requested',
    });

    const stranger = await newUser(h, 'Stranger');
    expect(
      (await call(stranger, 'get', `/v1/kelo/credit/decisions/${decision.body.id as string}`))
        .status,
    ).toBe(404);
    expect(
      (await call(buyer, 'get', `/v1/kelo/credit/decisions/${decision.body.id as string}`)).body,
    ).toMatchObject({ id: decision.body.id, outcome: 'approved' });
  });

  it('declines with its reasons at once, charges nothing, reserves nothing and places no order', async () => {
    const buyer = await newUser(h, 'Buyer');
    const reservedBefore = await h.owner((c) =>
      c.query(`select stock_reserved from kelo.listing_variant where id = $1`, [radioVariant]),
    );
    const decision = await decide(buyer, { declared_monthly_income_minor: '100000' });
    expect(decision.status).toBe(201);
    expect(decision.body.outcome).toBe('declined');
    expect(decision.body.reason_codes).toEqual(['unaffordable']);
    expect(decision.body.reasons[0]).toEqual(expect.any(String));
    const stored = await h.owner((c) =>
      c.query(`select inputs from kelo.credit_decision where id = $1`, [decision.body.id]),
    );
    expect(stored.rows[0].inputs.largest_instalment_minor).toBe('200001');

    const purchase = await buyWith(buyer, decision);
    expect(purchase.status).toBe(409);
    const orders = await h.owner((c) =>
      c.query(`select count(*)::int as n from kelo.purchase where consumer_account_id = $1`, [
        buyer.accountId,
      ]),
    );
    expect(orders.rows[0].n).toBe(0);
    const intents = await h.owner((c) =>
      c.query(`select count(*)::int as n from payments.payment_intent where created_by = $1`, [
        buyer.accountId,
      ]),
    );
    expect(intents.rows[0].n).toBe(0);
    const reservedAfter = await h.owner((c) =>
      c.query(`select stock_reserved from kelo.listing_variant where id = $1`, [radioVariant]),
    );
    expect(reservedAfter.rows[0]).toEqual(reservedBefore.rows[0]);
  });

  it('declines beyond the limit, and on an adverse bureau result given with its own consent', async () => {
    const buyer = await newUser(h, 'Buyer');
    // A KES 80,000 kit less a 10% deposit is KES 72,000 of credit, over the KES 50,000 starting limit.
    const { listing: big, variant: bigVariant } = await listing(
      'solar-home-systems',
      'Sandbox large solar kit',
      8_000_000n,
      1,
    );
    await call(merchant, 'post', `/v1/workspace/kelo/listings/${big}/plan-offers`, {
      template_key: MONTHLY_6,
    });
    const over = await decide(buyer, {
      listing_id: big,
      variant_id: bigVariant,
      template_key: MONTHLY_6,
      declared_monthly_income_minor: '100000000',
    });
    expect(over.body.reason_codes).toEqual(['over_limit']);

    const consent = await h.http().get('/v1/terms/kelo_bureau_check_consent');
    const adverse = await decide(buyer, {
      bureau_check: { consent_version: consent.body.version as string, sandbox_result: 'adverse' },
    });
    expect(adverse.body.reason_codes).toEqual(['bureau_adverse']);
    const consents = await h.owner((c) =>
      c.query(
        `select r.action, t.key from consent.consent_record r join consent.terms_document t on t.id = r.terms_document_id
          where r.account_id = $1`,
        [buyer.accountId],
      ),
    );
    expect(consents.rows).toEqual([
      { action: 'kelo.credit.bureau_check', key: 'kelo_bureau_check_consent' },
    ]);
  });

  it('refuses a person with no phone number on file', async () => {
    const buyer = await newUser(h, 'Buyer', { phone: false });
    const decision = await decide(buyer);
    expect(decision.body.reason_codes).toContain('phone_missing');
  });

  it('never words the limit as a balance, cash or funds (kelo-experience §2)', async () => {
    const buyer = await newUser(h, 'Buyer');
    const limit = await call(buyer, 'get', '/v1/kelo/credit/limit');
    expect(limit.status).toBe(200);
    expect(limit.body).toMatchObject({ limit_minor: '5000000', limit_used_minor: '0' });
    const decision = await decide(buyer);
    for (const body of [limit.body, decision.body]) {
      expect(keysOf(body).filter((key) => BANNED.test(key))).toEqual([]);
    }
    // The kelo-web credit screens never use those words either.
    const root = join(import.meta.dirname, '../../../apps/kelo-web/app/credit');
    const files = (function walk(dir: string): string[] {
      return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : [path];
      });
    })(root);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const visible = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'));
      expect(visible.filter((line) => /\b(balance|cash|funds)\b/i.test(line))).toEqual([]);
    }
  });
});

describe('checkout and agreement (K2)', () => {
  it('creates the agreement from an approved decision, snapshotting every version, and uses a decision once', async () => {
    const buyer = await newUser(h, 'Buyer');
    const decision = await decide(buyer);
    const key = randomUUID();
    const placed = await buyWith(buyer, decision, key);
    expect(placed.status).toBe(201);
    expect(placed.body).toMatchObject({
      status: 'placed',
      plan_type: 'pay_in_n',
      total_minor: RADIO_PRICE.toString(),
      credit: {
        status: 'pending_first_payment',
        lender_of_record: 'KELO sandbox book (simulated lender, not licensed)',
        principal_minor: RADIO_PRICE.toString(),
        interest_total_minor: '0',
        total_payable_minor: RADIO_PRICE.toString(),
        apr_text: '0.00%',
        checkout_seq: 1,
      },
    });
    expect(placed.body.credit.instalments).toHaveLength(4);
    const again = await buyWith(buyer, decision, key);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(placed.body.id);
    // A second purchase with the same decision is refused.
    expect((await buyWith(buyer, decision)).status).toBe(409);

    const agreement = await h.owner((c) =>
      c.query(
        `select a.*, t.key as template_key, t.version as template_version,
                at.key as agreement_key, kt.key as kid_key, r.action
           from kelo.credit_agreement a
           join kelo.plan_template t on t.id = a.template_id
           join consent.terms_document at on at.id = a.agreement_terms_id
           join consent.terms_document kt on kt.id = a.kid_terms_id
           join consent.consent_record r on r.id = a.consent_id
          where a.purchase_id = $1`,
        [placed.body.id],
      ),
    );
    expect(agreement.rows[0]).toMatchObject({
      template_key: PAY_IN_4,
      template_version: 1,
      agreement_key: 'kelo_credit_agreement',
      kid_key: `kelo_credit_kid_${PAY_IN_4}`,
      action: 'kelo.credit.accept',
      decision_id: decision.body.id,
      late_fee_minor: '5000',
      late_fee_total_cap_minor: '20000',
    });
  });

  it('refuses a total that differs from the one shown', async () => {
    const buyer = await newUser(h, 'Buyer');
    const decision = await decide(buyer);
    const docs = await documents(PAY_IN_4);
    const wrong = await call(buyer, 'post', '/v1/kelo/purchases', {
      decision_id: decision.body.id as string,
      expected_total_payable_minor: (RADIO_PRICE - 1n).toString(),
      agreement_version: docs.agreement,
      kid_version: docs.kid,
    }).set('Idempotency-Key', randomUUID());
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.code).toBe('fee_changed');
  });

  it('refuses someone else’s decision', async () => {
    const buyer = await newUser(h, 'Buyer');
    const other = await newUser(h, 'Other');
    const decision = await decide(buyer);
    expect((await buyWith(other, decision)).status).toBe(404);
  });

  it('activates on the first payment: the receivable is the buyer’s, the merchant gets nothing yet', async () => {
    const buyer = await newUser(h, 'Buyer');
    const purchase = (await buyWith(buyer, await decide(buyer))).body.id as string;
    const payableBefore = await balanceOf(h, null, 'kelo_merchant_payable_pending');
    const availableBefore = await balanceOf(h, merchant.workspace, 'merchant_available');
    const pendingBefore = await balanceOf(h, merchant.workspace, 'merchant_collections_pending');

    const started = await pay(buyer, purchase, 1);
    expect(started.status).toBe(202);
    await h.settle();

    const view = await purchaseOf(buyer, purchase);
    expect(view).toMatchObject({ status: 'payment_ready', credit: { status: 'active' } });
    expect(view.credit.instalments[0]).toMatchObject({ seq: 1, status: 'paid' });
    expect(await consumerBalance(buyer.accountId, 'consumer_kelo_credit_receivable')).toBe(
      RADIO_PRICE - 200_000n,
    );
    expect(await balanceOf(h, null, 'kelo_merchant_payable_pending')).toBe(
      payableBefore + RADIO_PRICE,
    );
    expect(await balanceOf(h, null, 'kelo_credit_repayments_unapplied')).toBe(0n);
    expect(await balanceOf(h, merchant.workspace, 'merchant_available')).toBe(availableBefore);
    expect(await balanceOf(h, merchant.workspace, 'merchant_collections_pending')).toBe(
      pendingBefore,
    );
    // Not one of the merchant's collections.
    const intentId = started.body.payment_intent_id as string;
    expect((await call(merchant, 'get', `/v1/payment-intents/${intentId}`)).status).toBe(404);
    // A part not yet due waits for 8B's early repayment.
    expect((await pay(buyer, purchase, 2)).status).toBe(409);
    expect(await trialBalance(h)).toBe(0n);
  });

  it('keeps the agreement pending when the first payment fails, and lets the buyer try again', async () => {
    const buyer = await newUser(h, 'Buyer');
    const purchase = (await buyWith(buyer, await decide(buyer))).body.id as string;
    expect((await pay(buyer, purchase, 1, 'decline')).status).toBe(202);
    await h.settle();
    const failed = await purchaseOf(buyer, purchase);
    expect(failed).toMatchObject({ status: 'placed', credit: { status: 'pending_first_payment' } });
    expect(failed.credit.instalments[0].status).toBe('due');
    expect((await pay(buyer, purchase, 1)).status).toBe(202);
    await h.settle();
    expect((await purchaseOf(buyer, purchase)).credit.status).toBe('active');
  });

  it('monthly financing: the deposit is taken at checkout and interest is never booked before it is paid', async () => {
    const buyer = await newUser(h, 'Buyer');
    const decision = await decide(buyer, {
      listing_id: solar,
      variant_id: solarVariant,
      template_key: MONTHLY_6,
    });
    expect(decision.body.outcome).toBe('approved');
    const placed = await buyWith(buyer, decision);
    expect(placed.status).toBe(201);
    expect(placed.body.credit).toMatchObject({
      checkout_seq: 0,
      deposit_minor: '450000',
      principal_minor: '4050000',
      interest_total_minor: '212625',
      apr_text: '18.25%',
    });
    const incomeBefore = await balanceOf(h, null, 'kelo_interest_income');
    expect((await pay(buyer, placed.body.id as string, 0)).status).toBe(202);
    await h.settle();
    expect(await consumerBalance(buyer.accountId, 'consumer_kelo_credit_receivable')).toBe(
      SOLAR_PRICE - 450_000n,
    );
    expect(await balanceOf(h, null, 'kelo_interest_income')).toBe(incomeBefore);
    // The limit now counts what is still owed.
    const limit = await call(buyer, 'get', '/v1/kelo/credit/limit');
    expect(limit.body.limit_used_minor).toBe('4050000');
  });

  it('settles the merchant on fulfilment, net of the discount fee, and only then', async () => {
    const buyer = await newUser(h, 'Buyer');
    const purchase = (await buyWith(buyer, await decide(buyer))).body.id as string;
    await pay(buyer, purchase, 1);
    await h.settle();
    const availableBefore = await balanceOf(h, merchant.workspace, 'merchant_available');
    const feesBefore = await balanceOf(h, null, 'kelo_fee_revenue');
    const payableBefore = await balanceOf(h, null, 'kelo_merchant_payable_pending');

    const list = await call(merchant, 'get', '/v1/workspace/kelo/purchases');
    const row = (list.body.data as { id: string; next_action: string }[]).find(
      (p) => p.id === purchase,
    );
    expect(row?.next_action).toBe('confirm');
    expect(
      (await call(merchant, 'post', `/v1/workspace/kelo/purchases/${purchase}/confirm`)).status,
    ).toBe(200);
    const delivered = await call(
      buyer,
      'post',
      `/v1/kelo/me/purchases/${purchase}/confirm-delivery`,
    );
    expect(delivered.status).toBe(200);
    expect(delivered.body).toMatchObject({ status: 'completed', credit: { status: 'active' } });

    const fee = (RADIO_PRICE * 400n * 2n + 10_000n) / 20_000n;
    expect(await balanceOf(h, merchant.workspace, 'merchant_available')).toBe(
      availableBefore + RADIO_PRICE - fee,
    );
    expect(await balanceOf(h, null, 'kelo_fee_revenue')).toBe(feesBefore + fee);
    expect(await balanceOf(h, null, 'kelo_merchant_payable_pending')).toBe(
      payableBefore - RADIO_PRICE,
    );
    // The buyer still owes the rest, to KELO.
    expect(await consumerBalance(buyer.accountId, 'consumer_kelo_credit_receivable')).toBe(
      RADIO_PRICE - 200_000n,
    );
    expect(await trialBalance(h)).toBe(0n);
  });

  it('a merchant sees the order but never the limit, decision, reasons or the buyer’s credit', async () => {
    const list = await call(merchant, 'get', '/v1/workspace/kelo/purchases');
    expect(list.status).toBe(200);
    const text = JSON.stringify(list.body);
    expect(text).toContain('pay_in_n');
    expect(text).not.toMatch(/limit|decision|reason|income|interest|apr|bureau|instalments/i);
    // Row-level security: the merchant's workspace context reads no credit row.
    const visible = await h.db.withTenant(
      merchant.workspace,
      (tx) => tx.$queryRaw<{ decisions: number; agreements: number; instalments: number }[]>`
        select (select count(*) from kelo.credit_decision)::int as decisions,
               (select count(*) from kelo.credit_agreement)::int as agreements,
               (select count(*) from kelo.credit_instalment)::int as instalments`,
    );
    expect(visible[0]).toEqual({ decisions: 0, agreements: 0, instalments: 0 });
  });

  it('cancels a pending agreement freely, and refunds everything paid when cancelled before fulfilment', async () => {
    const buyer = await newUser(h, 'Buyer');
    const pending = (await buyWith(buyer, await decide(buyer))).body.id as string;
    const cancelled = await call(buyer, 'post', `/v1/kelo/me/purchases/${pending}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ status: 'cancelled', credit: { status: 'cancelled' } });

    const active = (await buyWith(buyer, await decide(buyer))).body.id as string;
    await pay(buyer, active, 1);
    await h.settle();
    const payableBefore = await balanceOf(h, null, 'kelo_merchant_payable_pending');
    const refunded = await call(buyer, 'post', `/v1/kelo/me/purchases/${active}/cancel`);
    expect(refunded.status).toBe(200);
    await h.settle();
    const view = await purchaseOf(buyer, active);
    expect(view).toMatchObject({
      status: 'cancelled',
      plan_status: 'refunded',
      credit: { status: 'cancelled' },
      refund: { refund_minor: '200000', status: 'succeeded' },
    });
    expect(await consumerBalance(buyer.accountId, 'consumer_kelo_credit_receivable')).toBe(0n);
    expect(await balanceOf(h, null, 'kelo_merchant_payable_pending')).toBe(
      payableBefore - RADIO_PRICE,
    );
    expect(await trialBalance(h)).toBe(0n);
  });

  it('never oversells stock to concurrent approved buyers', async () => {
    const { listing: last, variant: lastVariant } = await listing(
      'electronics',
      'Sandbox last radio',
      RADIO_PRICE,
      1,
    );
    await call(merchant, 'post', `/v1/workspace/kelo/listings/${last}/plan-offers`, {
      template_key: PAY_IN_4,
    });
    const buyers = await Promise.all([newUser(h, 'A'), newUser(h, 'B'), newUser(h, 'C')]);
    const decisions = await Promise.all(
      buyers.map((b) => decide(b, { listing_id: last, variant_id: lastVariant })),
    );
    const results = await Promise.all(buyers.map((b, i) => buyWith(b, decisions[i] as Response)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
  });

  it('a later template version changes nothing in an existing agreement', async () => {
    const buyer = await newUser(h, 'Buyer');
    const purchase = (await buyWith(buyer, await decide(buyer))).body.id as string;
    const before = await purchaseOf(buyer, purchase);
    await h.owner((c) =>
      c.query(
        `insert into kelo.plan_template
           (key, version, name, plan_type, instalment_count, interval_days, merchant_fee_bps,
            min_order_minor, max_order_minor, currency, effective_from, pricing_model, daily_rate_ppm,
            deposit_bps, first_payment_at_checkout, grace_days, late_fee_minor, late_fee_total_cap_minor,
            default_after_days, lender_of_record)
         values ('sandbox_pay_in_4', 2, 'SANDBOX Pay in 4 v2', 'pay_in_n', 4, 14, 900, 200000, 10000000,
                 'KES', now() - interval '1 second', 'none', 0, 0, true, 1, 9000, 30000, 30,
                 'KELO sandbox book (simulated lender, not licensed)')`,
      ),
    );
    const after = await purchaseOf(buyer, purchase);
    expect(after.credit).toEqual(before.credit);
  });
});

describe('the template check (P8-4)', () => {
  it('refuses a credit template that breaks the r. 29 cap', async () => {
    await expect(
      h.owner((c) =>
        c.query(
          `insert into kelo.plan_template
             (key, version, name, plan_type, instalment_count, interval_days, merchant_fee_bps,
              min_order_minor, max_order_minor, currency, effective_from, pricing_model, daily_rate_ppm,
              deposit_bps, first_payment_at_checkout, grace_days, late_fee_minor, late_fee_total_cap_minor,
              default_after_days, lender_of_record)
           values ('sandbox_bad_12', 1, 'Too costly', 'monthly_financing', 12, 30, 500, 1000000, 2000000,
                   'KES', now(), 'daily_interest', 3000, 1000, false, 5, 10000, 60000, 90, 'KELO sandbox book')`,
        ),
      ),
    ).rejects.toThrow(/plan_template_recovery_cap/);
  });
});
