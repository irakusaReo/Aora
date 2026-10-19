import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CreditCollectionsService } from '../src/modules/kelo/credit/collections.service.js';
import { CLAIM_TRANSITIONS } from '../src/modules/kelo/credit/claims.service.js';
import { addDays } from '../src/modules/kelo/schedule.js';
import { type Harness, startHarness } from './support/harness.js';
import { creditKit, type Who } from './support/kelo-credit.js';
import { balanceOf, trialBalance } from './support/money.js';
import { newUser } from './support/users.js';

/**
 * Phase 8C: returns and disputes (ADR 0017 "Returns and disputes"; journey K7).
 * A claim pauses the schedule (no reminders, no late charges); an accepted
 * return reverses the credit by compensating entries and refunds what was
 * paid; money already settled to the merchant is clawed back from the next
 * KELO settlement, as a visible receivable meanwhile. Written before the code.
 */

let h: Harness;
let operator: string;
let merchant: { token: string; workspace: string };
let other: { token: string; workspace: string };
let radio: { listing: string; variant: string };
const kit = creditKit(
  () => h,
  () => operator,
);
const { call, decide, buyWith, pay, purchaseOf, consumerBalance } = kit;

const PRICE = 800_000n;
const FEE = (PRICE * 400n * 2n + 10_000n) / 20_000n; // Pay in 4: 4% discount fee
const NET = PRICE - FEE;

/** An agreement in force on the radio; optionally delivered (and so the merchant settled). */
async function bought(
  delivered: boolean,
): Promise<{ buyer: Who & { accountId: string }; purchase: string }> {
  const buyer = await newUser(h, 'Buyer');
  const decision = await decide(buyer, {
    listing_id: radio.listing,
    variant_id: radio.variant,
    template_key: 'sandbox_pay_in_4',
  });
  const purchase = (await buyWith(buyer, decision)).body.id as string;
  expect((await pay(buyer, purchase, 1)).status).toBe(202);
  await h.settle();
  if (delivered) {
    expect(
      (await call(merchant, 'post', `/v1/workspace/kelo/purchases/${purchase}/confirm`)).status,
    ).toBe(200);
    const done = await call(buyer, 'post', `/v1/kelo/me/purchases/${purchase}/confirm-delivery`);
    expect(done.body.status).toBe('completed');
  }
  return { buyer, purchase };
}

const claim = (who: Who, purchase: string, body: Record<string, unknown>) =>
  call(who, 'post', `/v1/kelo/me/purchases/${purchase}/claims`, body).set(
    'Idempotency-Key',
    randomUUID(),
  );
const accept = async (who: Who, claimId: string) => {
  await h.stepUp(who.token);
  return call(who, 'post', `/v1/workspace/kelo/claims/${claimId}/accept`);
};
const collections = () => h.app.get(CreditCollectionsService);
const nairobi = (date: string, hour: number): Date =>
  new Date(`${date}T${String(hour).padStart(2, '0')}:00:00+03:00`);
const clawbackOf = (tenant: string) => balanceOf(h, tenant, 'merchant_kelo_clawback_receivable');

beforeAll(async () => {
  h = await startHarness();
  operator = await h.signIn('operator');
  merchant = await kit.store(['electronics']);
  other = await kit.store(['electronics']);
  await kit.flagOn();
  radio = await kit.listing(merchant, 'electronics', 'Sandbox radio', PRICE, 50, [
    'sandbox_pay_in_4',
  ]);
});
afterAll(() => h.close());

describe('claim state machine', () => {
  it('allows exactly the transitions of the plan', () => {
    expect(CLAIM_TRANSITIONS).toEqual({
      open: ['accepted', 'rejected', 'withdrawn'],
      accepted: [],
      rejected: [],
      withdrawn: [],
    });
  });
});

describe('a return request pauses the schedule (ADR 0017)', () => {
  it('holds every open part: no repayment, no late charge, no reminder', async () => {
    const { buyer, purchase } = await bought(true);
    const opened = await claim(buyer, purchase, {
      kind: 'return',
      reason_code: 'faulty',
      details: 'The radio does not switch on.',
    });
    expect(opened.status).toBe(201);
    expect(opened.body).toMatchObject({ kind: 'return', status: 'open', reason_code: 'faulty' });
    const view = await purchaseOf(buyer, purchase);
    expect(view.status).toBe('return_requested');
    expect(view.claim).toMatchObject({ id: opened.body.id, status: 'open' });
    expect(view.credit.status).toBe('paused');
    expect(
      (view.credit.instalments as { seq: number; status: string }[])
        .filter((line) => line.seq > 1)
        .map((line) => line.status),
    ).toEqual(['paused', 'paused', 'paused']);
    const quote = await call(buyer, 'get', `/v1/kelo/me/purchases/${purchase}/credit/quote`);
    expect(quote.body).toMatchObject({ next: null, payoff: null });

    const last = view.credit.instalments[3].due_on as string;
    await collections().run(nairobi(addDays(last, 30), 10));
    const after = await purchaseOf(buyer, purchase);
    expect(
      (after.credit.instalments as { late_charges_minor: string }[]).every(
        (line) => line.late_charges_minor === '0',
      ),
    ).toBe(true);
    const reminders = await h.owner((c) =>
      c.query(
        `select count(*)::int as n from notifications.notification
          where type = 'kelo.credit.reminder' and params->>'purchase_id' = $1`,
        [purchase],
      ),
    );
    expect(reminders.rows[0].n).toBe(0);
    // One open claim at a time.
    expect((await claim(buyer, purchase, { kind: 'dispute', reason_code: 'faulty' })).status).toBe(
      409,
    );
  });

  it('a rejected return puts everything back, and lateness counts from the day it resumed', async () => {
    const { buyer, purchase } = await bought(true);
    const opened = await claim(buyer, purchase, { kind: 'return', reason_code: 'changed_mind' });
    const list = await call(merchant, 'get', '/v1/workspace/kelo/purchases');
    const row = (list.body.data as { id: string; next_action: string; claim: unknown }[]).find(
      (p) => p.id === purchase,
    );
    expect(row).toMatchObject({
      next_action: 'respond_to_return',
      claim: { kind: 'return', reason_code: 'changed_mind', status: 'open' },
    });
    // The merchant sees the claim, never the buyer's credit.
    expect(JSON.stringify(row)).not.toMatch(
      /limit|reason_codes|income|interest|instalments|apr|bureau/i,
    );

    const noReason = await call(
      merchant,
      'post',
      `/v1/workspace/kelo/claims/${opened.body.id as string}/reject`,
      {},
    );
    expect(noReason.status).toBe(400);
    const rejected = await call(
      merchant,
      'post',
      `/v1/workspace/kelo/claims/${opened.body.id as string}/reject`,
      { reason: 'Sandbox: outside the return window.' },
    );
    expect(rejected.status).toBe(200);
    const view = await purchaseOf(buyer, purchase);
    expect(view.status).toBe('completed');
    expect(view.credit.status).toBe('active');
    expect(view.claim).toMatchObject({
      status: 'rejected',
      decision_reason: 'Sandbox: outside the return window.',
    });
    expect(
      (view.credit.instalments as { seq: number; status: string }[])
        .filter((line) => line.seq > 1)
        .map((line) => line.status),
    ).toEqual(['due', 'due', 'due']);

    // A part whose due date passed during a pause gets its full grace from the day it resumed.
    const due = view.credit.instalments[1].due_on as string;
    const resumed = addDays(due, 10);
    await h.owner((c) =>
      c.query(
        `update kelo.credit_instalment i set grace_from = $2::date
           from kelo.credit_agreement a
          where a.id = i.agreement_id and a.purchase_id = $1 and i.status = 'due'`,
        [purchase, resumed],
      ),
    );
    await collections().run(nairobi(addDays(resumed, 3), 10));
    expect((await purchaseOf(buyer, purchase)).credit.instalments[1].status).toBe('due');
    await collections().run(nairobi(addDays(resumed, 4), 10));
    expect((await purchaseOf(buyer, purchase)).credit.instalments[1].status).toBe('late');
  });

  it('the buyer can withdraw an open claim', async () => {
    const { buyer, purchase } = await bought(true);
    const opened = await claim(buyer, purchase, { kind: 'return', reason_code: 'changed_mind' });
    const withdrawn = await call(
      buyer,
      'post',
      `/v1/kelo/me/purchases/${purchase}/claims/${opened.body.id as string}/withdraw`,
    );
    expect(withdrawn.status).toBe(200);
    const view = await purchaseOf(buyer, purchase);
    expect(view).toMatchObject({ status: 'completed', credit: { status: 'active' } });
    expect(view.claim.status).toBe('withdrawn');
  });
});

describe('an accepted return (compensating entries, clawback, refund)', () => {
  it('needs the merchant’s refund permission and a step-up; no one else can decide it', async () => {
    const { buyer, purchase } = await bought(true);
    const opened = await claim(buyer, purchase, { kind: 'return', reason_code: 'faulty' });
    const id = opened.body.id as string;
    const noStepUp = await call(merchant, 'post', `/v1/workspace/kelo/claims/${id}/accept`);
    expect(noStepUp.status).toBe(403);
    expect((await accept(other, id)).status).toBe(404);
    expect((await call(buyer, 'post', `/v1/workspace/kelo/claims/${id}/accept`)).status).toBe(403);
  });

  it('cancels what the buyer owes, refunds what they paid, and claws back from the merchant as a receivable', async () => {
    const { buyer, purchase } = await bought(true);
    const availableBefore = await balanceOf(h, merchant.workspace, 'merchant_available');
    const feesBefore = await balanceOf(h, null, 'kelo_fee_revenue');
    const clawbackBefore = await clawbackOf(merchant.workspace);
    const opened = await claim(buyer, purchase, { kind: 'return', reason_code: 'faulty' });
    const accepted = await accept(merchant, opened.body.id as string);
    expect(accepted.status).toBe(200);
    await h.settle();

    const view = await purchaseOf(buyer, purchase);
    expect(view).toMatchObject({
      status: 'returned',
      plan_status: 'refunded',
      credit: { status: 'cancelled' },
      claim: { status: 'accepted' },
      refund: { refund_minor: '200000', fee_minor: '0', status: 'succeeded' },
    });
    expect(await consumerBalance(buyer.accountId, 'consumer_kelo_credit_receivable')).toBe(0n);
    // Never taken silently from the merchant's money: a receivable of its own.
    expect(await balanceOf(h, merchant.workspace, 'merchant_available')).toBe(availableBefore);
    expect(await clawbackOf(merchant.workspace)).toBe(clawbackBefore + NET);
    expect(await balanceOf(h, null, 'kelo_fee_revenue')).toBe(feesBefore - FEE);
    expect(await trialBalance(h)).toBe(0n);

    // The next KELO settlement nets the clawback first.
    const next = await bought(true);
    expect(next.purchase).toBeDefined();
    expect(await clawbackOf(merchant.workspace)).toBe(clawbackBefore);
    expect(await balanceOf(h, merchant.workspace, 'merchant_available')).toBe(availableBefore);
    expect(await trialBalance(h)).toBe(0n);
  });
});

describe('disputes (decided by an operator)', () => {
  it('a dispute before delivery, upheld, cancels the purchase and refunds what was paid', async () => {
    const { buyer, purchase } = await bought(false);
    const payableBefore = await balanceOf(h, null, 'kelo_merchant_payable_pending');
    const opened = await claim(buyer, purchase, {
      kind: 'dispute',
      reason_code: 'not_delivered',
      details: 'Nothing has arrived.',
    });
    expect(opened.status).toBe(201);
    expect((await purchaseOf(buyer, purchase)).status).toBe('disputed');
    // A merchant cannot decide a dispute.
    expect((await accept(merchant, opened.body.id as string)).status).toBe(409);

    const queue = await call({ token: operator }, 'get', '/v1/ops/kelo/claims');
    expect((queue.body.data as { id: string }[]).map((c) => c.id)).toContain(opened.body.id);
    await h.stepUp(operator);
    const decided = await call(
      { token: operator },
      'post',
      `/v1/ops/kelo/claims/${opened.body.id as string}/decision`,
      { outcome: 'accepted', reason: 'Sandbox: no proof of delivery.' },
    );
    expect(decided.status).toBe(200);
    await h.settle();
    const view = await purchaseOf(buyer, purchase);
    expect(view).toMatchObject({
      status: 'cancelled',
      plan_status: 'refunded',
      credit: { status: 'cancelled' },
      refund: { refund_minor: '200000', status: 'succeeded' },
    });
    expect(await balanceOf(h, null, 'kelo_merchant_payable_pending')).toBe(payableBefore - PRICE);
    expect(await consumerBalance(buyer.accountId, 'consumer_kelo_credit_receivable')).toBe(0n);
    expect(await trialBalance(h)).toBe(0n);
  });

  it('a dispute rejected by the operator returns the purchase to where it was', async () => {
    const { buyer, purchase } = await bought(false);
    const opened = await claim(buyer, purchase, { kind: 'dispute', reason_code: 'other' });
    await h.stepUp(operator);
    const decided = await call(
      { token: operator },
      'post',
      `/v1/ops/kelo/claims/${opened.body.id as string}/decision`,
      { outcome: 'rejected', reason: 'Sandbox: delivery is not yet due.' },
    );
    expect(decided.status).toBe(200);
    expect(await purchaseOf(buyer, purchase)).toMatchObject({
      status: 'payment_ready',
      credit: { status: 'active' },
      claim: { status: 'rejected' },
    });
  });

  it('refuses a return before delivery, and a claim on someone else’s purchase', async () => {
    const { buyer, purchase } = await bought(false);
    expect((await claim(buyer, purchase, { kind: 'return', reason_code: 'faulty' })).status).toBe(
      409,
    );
    const stranger = await newUser(h, 'Stranger');
    expect(
      (await claim(stranger, purchase, { kind: 'dispute', reason_code: 'faulty' })).status,
    ).toBe(404);
  });
});
