import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { expect } from 'vitest';
import type { Harness } from './harness.js';
import { newUser } from './users.js';

/** Shared set-up for KELO credit tests (phase 8): a vetted store, listings, the flag, decisions. */

export type Who = { token: string; workspace?: string; accountId?: string };

export function creditKit(h: () => Harness, operator: () => string) {
  const call = (who: Who, method: 'get' | 'post', path: string, body: object = {}) => {
    let r = h().http()[method](path).set('Authorization', `Bearer ${who.token}`);
    if (who.workspace) r = r.set('Aora-Workspace-Id', who.workspace);
    return method === 'post' ? r.send(body) : r;
  };

  async function store(categories: string[]): Promise<{ token: string; workspace: string }> {
    const owner = await newUser(h(), 'Merchant');
    const created = await call(owner, 'post', '/v1/kelo/stores', {
      display_name: 'Sandbox Credit Store',
      categories,
      business: {
        kind: 'registered',
        name: `Credit ${randomUUID().slice(0, 8)} Ltd`,
        country: 'KE',
        registration: { type: 'sandbox_registration_number', value: randomUUID().slice(0, 12) },
      },
    }).set('Idempotency-Key', randomUUID());
    const id = created.body.id as string;
    const detail = await call({ token: operator() }, 'get', `/v1/ops/kelo/stores/${id}`);
    const attestations = Object.fromEntries(
      (detail.body.categories as { slug: string; requirements: string[] }[]).map((c) => [
        c.slug,
        c.requirements,
      ]),
    );
    await call({ token: operator() }, 'post', `/v1/ops/kelo/stores/${id}/decision`, {
      outcome: 'approved',
      reason: 'Sandbox vetting completed.',
      attestations,
    });
    await h().settle();
    const view = await call(owner, 'get', `/v1/kelo/stores/${id}`);
    return { token: owner.token, workspace: view.body.workspace_id as string };
  }

  async function listing(
    merchant: Who,
    category: string,
    title: string,
    price: bigint,
    stock: number,
    templates: string[],
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
    await call({ token: operator() }, 'post', `/v1/ops/kelo/listings/${id}/decision`, {
      outcome: 'approved',
      reason: 'Sandbox moderation decision.',
    });
    for (const template of templates) {
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
    return { listing: id, variant: variant.body.id as string };
  }

  async function flagOn(): Promise<void> {
    await h().stepUp(operator());
    const on = await call({ token: operator() }, 'post', '/v1/ops/feature-flags/kelo_credit', {
      enabled: true,
      reason: 'Sandbox: credit tests.',
    });
    expect(on.status).toBe(200);
  }

  const decide = (
    who: Who,
    body: Record<string, unknown>,
    key: string = randomUUID(),
  ): Promise<Response> =>
    call(who, 'post', '/v1/kelo/credit/decisions', {
      declared_monthly_income_minor: '15000000',
      ...body,
    }).set('Idempotency-Key', key);

  async function buyWith(who: Who, decision: Response, key = randomUUID()): Promise<Response> {
    const plan = decision.body.plan as { template_key: string; total_payable_minor: string };
    const agreement = await h().http().get('/v1/terms/kelo_credit_agreement');
    const kid = await h().http().get(`/v1/terms/kelo_credit_kid_${plan.template_key}`);
    return call(who, 'post', '/v1/kelo/purchases', {
      decision_id: decision.body.id as string,
      expected_total_payable_minor: plan.total_payable_minor,
      agreement_version: agreement.body.version as string,
      kid_version: kid.body.version as string,
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
    h().owner(async (client) => {
      const result = await client.query<{ balance: string }>(
        `select coalesce(sum(b.balance), 0)::text as balance from ledger.account a
           left join ledger.account_balance b on b.account_id = a.id
          where a.type = $2 and a.consumer_account_id = $1`,
        [accountId, type],
      );
      return BigInt(result.rows[0]?.balance ?? '0');
    });

  return { call, store, listing, flagOn, decide, buyWith, pay, purchaseOf, consumerBalance };
}
