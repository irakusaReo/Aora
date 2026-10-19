import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './support/harness.js';
import { creditKit, type Who } from './support/kelo-credit.js';
import { balanceOf } from './support/money.js';
import { newUser } from './support/users.js';

/**
 * Phase 8D: the KELO dashboard in the merchant's KONY workspace (kelo-experience
 * §3): orders needing action, BNPL sales, settlements due and paid, returns,
 * fees, every money figure equal to the ledger, and nothing about any
 * consumer's credit. Written before the code.
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
const { call, decide, buyWith, pay } = kit;

const PRICE = 800_000n;
const FEE = (PRICE * 400n * 2n + 10_000n) / 20_000n;
const NET = PRICE - FEE;

async function bought(): Promise<{ buyer: Who & { accountId: string }; purchase: string }> {
  const buyer = await newUser(h, 'Buyer');
  const decision = await decide(buyer, {
    listing_id: radio.listing,
    variant_id: radio.variant,
    template_key: 'sandbox_pay_in_4',
  });
  const purchase = (await buyWith(buyer, decision)).body.id as string;
  expect((await pay(buyer, purchase, 1)).status).toBe(202);
  await h.settle();
  return { buyer, purchase };
}

async function deliver(buyer: Who, purchase: string): Promise<void> {
  await call(merchant, 'post', `/v1/workspace/kelo/purchases/${purchase}/confirm`);
  const done = await call(buyer, 'post', `/v1/kelo/me/purchases/${purchase}/confirm-delivery`);
  expect(done.body.status).toBe('completed');
}

const dashboard = (who: Who) => call(who, 'get', '/v1/workspace/kelo/dashboard');

beforeAll(async () => {
  h = await startHarness();
  operator = await h.signIn('operator');
  merchant = await kit.store(['electronics']);
  other = await kit.store(['electronics']);
  await kit.flagOn();
  radio = await kit.listing(merchant, 'electronics', 'Sandbox radio', PRICE, 50, [
    'sandbox_pay_in_4',
  ]);

  // One order waiting for the merchant's confirmation.
  await bought();
  // Two delivered and settled.
  for (let i = 0; i < 2; i += 1) {
    const { buyer, purchase } = await bought();
    await deliver(buyer, purchase);
  }
  // One delivered, then returned and accepted: a clawback.
  const returned = await bought();
  await deliver(returned.buyer, returned.purchase);
  const claim = await call(
    returned.buyer,
    'post',
    `/v1/kelo/me/purchases/${returned.purchase}/claims`,
    {
      kind: 'return',
      reason_code: 'faulty',
    },
  ).set('Idempotency-Key', `return-${returned.purchase}`);
  await h.stepUp(merchant.token);
  expect(
    (await call(merchant, 'post', `/v1/workspace/kelo/claims/${claim.body.id as string}/accept`))
      .status,
  ).toBe(200);
  // One with an open return.
  const open = await bought();
  await deliver(open.buyer, open.purchase);
  await call(open.buyer, 'post', `/v1/kelo/me/purchases/${open.purchase}/claims`, {
    kind: 'return',
    reason_code: 'changed_mind',
  }).set('Idempotency-Key', `return-${open.purchase}`);
  await h.settle();
});
afterAll(() => h.close());

describe('the KELO dashboard (8D)', () => {
  it('lists what needs action, in order', async () => {
    const view = await dashboard(merchant);
    expect(view.status).toBe(200);
    expect(view.body.orders_needing_action).toEqual({
      confirm: 1,
      fulfil: 0,
      respond_to_return: 1,
      total: 2,
    });
  });

  it('shows BNPL sales, settlements, returns and fees, each equal to the ledger', async () => {
    const view = (await dashboard(merchant)).body;
    expect(view.currency).toBe('KES');
    // Four delivered credit orders (one since returned).
    expect(view.bnpl_sales).toEqual({ count: 4, gross_minor: (PRICE * 4n).toString() });
    // Settled on delivery: four sales, gross, fee and net, of which one return's net was netted back.
    expect(view.settlements.paid).toMatchObject({
      count: 4,
      gross_minor: (PRICE * 4n).toString(),
      fees_minor: (FEE * 4n).toString(),
    });
    // Due: the order awaiting confirmation, paid on delivery.
    expect(view.settlements.due).toEqual({ count: 1, net_minor: NET.toString() });
    expect(view.returns).toEqual({
      open: 1,
      accepted: 1,
      clawed_back_minor: NET.toString(),
      clawback_outstanding_minor: (
        await balanceOf(h, merchant.workspace, 'merchant_kelo_clawback_receivable')
      ).toString(),
    });
    // Fees: charged on four settlements, one given up on the accepted return.
    expect(view.fees).toEqual({
      charged_minor: (FEE * 4n).toString(),
      refunded_minor: FEE.toString(),
      net_minor: (FEE * 3n).toString(),
    });
    // Money reached the merchant's available balance exactly as the dashboard says.
    const available = await balanceOf(h, merchant.workspace, 'merchant_available');
    expect(BigInt(view.settlements.paid.to_available_minor as string)).toBe(available);
    expect(
      BigInt(view.settlements.paid.to_available_minor as string) +
        BigInt(view.settlements.paid.clawback_netted_minor as string),
    ).toBe(NET * 4n);
  });

  it('carries nothing about any consumer or their credit', async () => {
    const text = JSON.stringify((await dashboard(merchant)).body);
    expect(text).not.toMatch(
      /limit|decision|reason_code|income|interest|instalment|apr|bureau|consumer|buyer|account_id/i,
    );
  });

  it('is the workspace’s own: another workspace sees only its own (empty) figures', async () => {
    const view = (await dashboard(other)).body;
    expect(view.orders_needing_action.total).toBe(0);
    expect(view.bnpl_sales).toEqual({ count: 0, gross_minor: '0' });
    expect(view.settlements.paid.gross_minor).toBe('0');
  });
});
