import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CreditCollectionsService } from '../src/modules/kelo/credit/collections.service.js';
import { addDays } from '../src/modules/kelo/schedule.js';
import { type Harness, startHarness } from './support/harness.js';
import { creditKit, type Who } from './support/kelo-credit.js';
import { balanceOf, trialBalance } from './support/money.js';
import { exceptionTypes } from './support/payments.js';
import { newUser } from './support/users.js';

/**
 * Phase 8B: repayments and collections (journeys K3, K5). Early repayment
 * costs interest only to the day (r. 56(4)); allocation is principal, then
 * charges, then interest (r. 56(2)); late charges after the grace period,
 * capped (r. 29, r. 30(2)); default marking; reminders to the borrower only,
 * inside the contact window (r. 30(1)). Written before the code.
 */

let h: Harness;
let operator: string;
let merchant: { token: string; workspace: string };
let radio: { listing: string; variant: string };
let solar: { listing: string; variant: string };
const kit = creditKit(
  () => h,
  () => operator,
);
const { call, decide, buyWith, pay, purchaseOf, consumerBalance } = kit;

const RADIO_PRICE = 800_000n;
const SOLAR_PRICE = 4_500_000n;

const quoteOf = async (who: Who, purchase: string) =>
  (await call(who, 'get', `/v1/kelo/me/purchases/${purchase}/credit/quote`)).body;
const repay = (
  who: Who,
  purchase: string,
  kind: 'next' | 'payoff',
  expected: string,
  scenario = 'success',
  key = randomUUID(),
) =>
  call(who, 'post', `/v1/kelo/me/purchases/${purchase}/credit/repay`, {
    kind,
    expected_amount_minor: expected,
    sandbox_scenario: scenario,
  }).set('Idempotency-Key', key);

/** A buyer with an agreement in force: Pay in 4 on the radio, or monthly financing on the kit. */
async function activeAgreement(plan: 'pay_in_4' | 'monthly_6'): Promise<{
  buyer: Who & { accountId: string };
  purchase: string;
}> {
  const buyer = await newUser(h, 'Buyer');
  const target = plan === 'pay_in_4' ? radio : solar;
  const decision = await decide(buyer, {
    listing_id: target.listing,
    variant_id: target.variant,
    template_key: `sandbox_${plan}`,
  });
  expect(decision.body.outcome).toBe('approved');
  const placed = await buyWith(buyer, decision);
  expect(placed.status).toBe(201);
  const purchase = placed.body.id as string;
  expect((await pay(buyer, purchase, plan === 'pay_in_4' ? 1 : 0)).status).toBe(202);
  await h.settle();
  return { buyer, purchase };
}

/** A moment in Nairobi on a given date (UTC+3 all year). */
const nairobi = (date: string, hour: number): Date =>
  new Date(`${date}T${String(hour).padStart(2, '0')}:00:00+03:00`);
const collections = () => h.app.get(CreditCollectionsService);
const dueOf = async (who: Who, purchase: string, seq: number): Promise<string> =>
  ((await purchaseOf(who, purchase)).credit.instalments as { seq: number; due_on: string }[]).find(
    (line) => line.seq === seq,
  )?.due_on ?? '';

beforeAll(async () => {
  h = await startHarness();
  operator = await h.signIn('operator');
  merchant = await kit.store(['electronics', 'solar-home-systems']);
  await kit.flagOn();
  radio = await kit.listing(merchant, 'electronics', 'Sandbox radio', RADIO_PRICE, 50, [
    'sandbox_pay_in_4',
  ]);
  solar = await kit.listing(merchant, 'solar-home-systems', 'Sandbox solar kit', SOLAR_PRICE, 50, [
    'sandbox_monthly_6',
  ]);
});
afterAll(() => h.close());

describe('paying early (r. 56(3)–(4))', () => {
  it('quotes the exact payoff: on the first day, the principal and no interest at all', async () => {
    const { buyer, purchase } = await activeAgreement('monthly_6');
    const quote = await quoteOf(buyer, purchase);
    expect(quote.payoff).toMatchObject({
      amount_minor: '4050000',
      principal_minor: '4050000',
      charges_minor: '0',
      interest_minor: '0',
      waived_minor: '212625',
    });
    expect(quote.payoff.no_penalty).toBe(true);
    expect(quote.next).toMatchObject({ amount_minor: '675000', waived_minor: '60750' });
  });

  it('pays off in one repayment: the agreement closes, the receivable is zero, no interest is booked', async () => {
    const { buyer, purchase } = await activeAgreement('monthly_6');
    const incomeBefore = await balanceOf(h, null, 'kelo_interest_income');
    const started = await repay(buyer, purchase, 'payoff', '4050000');
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ status: 'pending', amount_minor: '4050000' });
    await h.settle();

    const view = await purchaseOf(buyer, purchase);
    expect(view.credit.status).toBe('paid_off');
    expect(
      (view.credit.instalments as { status: string }[]).every((line) => line.status === 'paid'),
    ).toBe(true);
    expect(await consumerBalance(buyer.accountId, 'consumer_kelo_credit_receivable')).toBe(0n);
    expect(await balanceOf(h, null, 'kelo_interest_income')).toBe(incomeBefore);
    expect(await balanceOf(h, null, 'kelo_credit_repayments_unapplied')).toBe(0n);

    const statement = await call(
      buyer,
      'get',
      `/v1/kelo/me/purchases/${purchase}/credit/statement`,
    );
    expect(statement.status).toBe(200);
    expect(statement.body.totals).toMatchObject({
      paid_principal_minor: SOLAR_PRICE.toString(),
      paid_interest_minor: '0',
      paid_charges_minor: '0',
      waived_interest_minor: '212625',
      outstanding_minor: '0',
    });
    expect(statement.body.repayments).toHaveLength(2);

    // A receipt for the repayment, to the borrower (r. 39).
    const receipts = await h.owner((c) =>
      c.query(
        `select account_id from notifications.notification where type = 'kelo.credit.receipt'`,
      ),
    );
    expect(receipts.rows.map((row) => row.account_id)).toContain(buyer.accountId);
    // Repaid on time: the limit grows by one step (P8-6).
    const limit = await call(buyer, 'get', '/v1/kelo/credit/limit');
    expect(limit.body).toMatchObject({ limit_minor: '7500000', limit_used_minor: '0' });
    expect(await trialBalance(h)).toBe(0n);
  });

  it('pays the next part early, with the interest it has earned so far only', async () => {
    const { buyer, purchase } = await activeAgreement('monthly_6');
    const quote = await quoteOf(buyer, purchase);
    const started = await repay(buyer, purchase, 'next', quote.next.amount_minor as string);
    expect(started.status).toBe(202);
    await h.settle();
    const view = await purchaseOf(buyer, purchase);
    expect(view.credit.status).toBe('active');
    expect(view.credit.instalments[1]).toMatchObject({ seq: 1, status: 'paid' });
    expect(await consumerBalance(buyer.accountId, 'consumer_kelo_credit_receivable')).toBe(
      SOLAR_PRICE - 450_000n - 675_000n,
    );
  });

  it('refuses an amount that is not the quote, and a second repayment while one is in flight', async () => {
    const { buyer, purchase } = await activeAgreement('pay_in_4');
    const wrong = await repay(buyer, purchase, 'payoff', '1');
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.code).toBe('fee_changed');
    const key = randomUUID();
    expect((await repay(buyer, purchase, 'next', '200000', 'success', key)).status).toBe(202);
    // The same request again adopts it; a different one is refused until it has a result.
    expect((await repay(buyer, purchase, 'next', '200000', 'success', key)).status).toBe(202);
    expect((await repay(buyer, purchase, 'payoff', '600000')).status).toBe(409);
    await h.settle();
    expect((await purchaseOf(buyer, purchase)).credit.instalments[1].status).toBe('paid');
  });

  it('leaves everything as it was when a repayment fails', async () => {
    const { buyer, purchase } = await activeAgreement('pay_in_4');
    const before = await consumerBalance(buyer.accountId, 'consumer_kelo_credit_receivable');
    expect((await repay(buyer, purchase, 'payoff', '600000', 'decline')).status).toBe(202);
    await h.settle();
    const view = await purchaseOf(buyer, purchase);
    expect(view.credit.status).toBe('active');
    expect(
      (view.credit.instalments as { seq: number; status: string }[])
        .filter((line) => line.seq > 1)
        .every((line) => line.status === 'due'),
    ).toBe(true);
    expect(await consumerBalance(buyer.accountId, 'consumer_kelo_credit_receivable')).toBe(before);
    expect((await quoteOf(buyer, purchase)).payoff.amount_minor).toBe('600000');
  });
});

describe('late charges and default (r. 29, r. 30(2), r. 57)', () => {
  it('charges once after the grace period, capped, and takes it after principal and before interest', async () => {
    const { buyer, purchase } = await activeAgreement('pay_in_4');
    const due = await dueOf(buyer, purchase, 2);
    // Grace is three days: on day three nothing happens; on day four the part is late.
    await collections().run(nairobi(addDays(due, 3), 12));
    expect((await purchaseOf(buyer, purchase)).credit.instalments[1].status).toBe('due');
    const late = await collections().run(nairobi(addDays(due, 4), 12));
    expect(late.late_marked).toBeGreaterThanOrEqual(1);
    await collections().run(nairobi(addDays(due, 5), 12));
    const view = await purchaseOf(buyer, purchase);
    expect(view.credit.instalments[1]).toMatchObject({
      status: 'late',
      late_charges_minor: '5000',
    });
    expect(view.credit.instalments[2].late_charges_minor).toBe('0');

    const chargesBefore = await balanceOf(h, null, 'kelo_late_charge_income');
    const quote = await quoteOf(buyer, purchase);
    expect(quote.next).toMatchObject({ amount_minor: '205000', charges_minor: '5000' });
    expect((await repay(buyer, purchase, 'next', '205000')).status).toBe(202);
    await h.settle();
    expect(await balanceOf(h, null, 'kelo_late_charge_income')).toBe(chargesBefore + 5_000n);
    expect((await purchaseOf(buyer, purchase)).credit.instalments[1].status).toBe('paid');
    expect(await trialBalance(h)).toBe(0n);
  });

  it('never charges beyond the agreement’s cap, however long parts stay late', async () => {
    const { buyer, purchase } = await activeAgreement('pay_in_4');
    const last = await dueOf(buyer, purchase, 4);
    for (let day = 0; day < 10; day += 1) {
      await collections().run(nairobi(addDays(last, 4 + day), 12));
    }
    const view = await purchaseOf(buyer, purchase);
    const charged = (view.credit.instalments as { late_charges_minor: string }[]).reduce(
      (sum, line) => sum + BigInt(line.late_charges_minor),
      0n,
    );
    expect(charged).toBe(15_000n); // three late parts × KES 50, under the KES 200 cap
    expect(charged <= 20_000n).toBe(true);
  });

  it('marks the agreement non-performing after its default period, and a payoff closes it', async () => {
    const { buyer, purchase } = await activeAgreement('pay_in_4');
    const due = await dueOf(buyer, purchase, 2);
    await collections().run(nairobi(addDays(due, 60), 12));
    expect((await purchaseOf(buyer, purchase)).credit.status).toBe('active');
    const run = await collections().run(nairobi(addDays(due, 61), 12));
    expect(run.defaulted).toBeGreaterThanOrEqual(1);
    expect((await purchaseOf(buyer, purchase)).credit.status).toBe('defaulted');

    const quote = await quoteOf(buyer, purchase);
    expect(
      (await repay(buyer, purchase, 'payoff', quote.payoff.amount_minor as string)).status,
    ).toBe(202);
    await h.settle();
    expect((await purchaseOf(buyer, purchase)).credit.status).toBe('paid_off');
    // Not repaid on time: the limit does not grow.
    expect((await call(buyer, 'get', '/v1/kelo/credit/limit')).body.limit_minor).toBe('5000000');
  });
});

describe('reminders (r. 30(1), P8-11)', () => {
  it('reminds the borrower only, before the due date, inside the contact window, once', async () => {
    const { buyer, purchase } = await activeAgreement('pay_in_4');
    const due = await dueOf(buyer, purchase, 2);
    const count = async (type: string) =>
      (
        await h.owner((c) =>
          c.query<{ account_id: string; params: Record<string, unknown> }>(
            `select n.account_id, n.params from notifications.notification n
              where n.type = $1 and n.params->>'purchase_id' = $2`,
            [type, purchase],
          ),
        )
      ).rows;

    // Outside the window (22:00 in Nairobi): nothing is sent.
    await collections().run(nairobi(addDays(due, -3), 22));
    expect(await count('kelo.credit.reminder')).toHaveLength(0);
    await collections().run(nairobi(addDays(due, -3), 10));
    await collections().run(nairobi(addDays(due, -3), 11));
    const upcoming = await count('kelo.credit.reminder');
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0]?.account_id).toBe(buyer.accountId);
    expect(upcoming[0]?.params).toMatchObject({ kind: 'upcoming', amount_minor: '200000' });
    // No action link and no threat in what is sent.
    expect(JSON.stringify(upcoming[0]?.params)).not.toMatch(/http|bureau|crb/i);

    await collections().run(nairobi(addDays(due, 4), 9));
    const all = await count('kelo.credit.reminder');
    expect(all.map((row) => row.params['kind']).sort()).toEqual(['overdue', 'upcoming']);
    expect(all.find((row) => row.params['kind'] === 'overdue')?.params).toMatchObject({
      late_charge_minor: '5000',
      late_charge_cap_minor: '20000',
    });
  });
});

describe('isolation and reconciliation', () => {
  it('a merchant sees no repayment, charge or statement, and reconciliation stays clean', async () => {
    const { buyer, purchase } = await activeAgreement('pay_in_4');
    expect((await repay(buyer, purchase, 'next', '200000')).status).toBe(202);
    await h.settle();
    expect(
      (await call(merchant, 'get', `/v1/kelo/me/purchases/${purchase}/credit/statement`)).status,
    ).toBe(404);
    const visible = await h.db.withTenant(
      merchant.workspace,
      (tx) => tx.$queryRaw<{ n: number }[]>`select count(*)::int as n from kelo.credit_repayment`,
    );
    expect(visible[0]?.n).toBe(0);
    const before = await exceptionTypes(h);
    const run = await h
      .http()
      .get('/v1/internal/cron/reconciliation')
      .set('Authorization', `Bearer ${h.config.cronSecret ?? ''}`);
    expect(run.status).toBe(200);
    expect(await exceptionTypes(h)).toEqual(before);
  });
});
