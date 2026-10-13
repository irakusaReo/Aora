import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type IntentStatus, TRANSITIONS } from '../src/modules/payments/payments.service.js';
import { type Harness, startHarness } from './support/harness.js';
import { type Caller, createIntent, getIntent } from './support/payments.js';

let h: Harness;
let adminA: Caller;
let cashierA: Caller;
let adminB: Caller;

beforeAll(async () => {
  h = await startHarness();
  adminA = { token: await h.signIn('adminA'), workspace: h.seed.tenantA };
  cashierA = { token: await h.signIn('cashierA'), workspace: h.seed.tenantA };
  adminB = { token: await h.signIn('adminB'), workspace: h.seed.tenantB };
});
afterAll(() => h.close());

const body = { amount_minor: '15000', currency: 'KES' };

describe('creating a payment intent', () => {
  it('creates a sandbox intent in status created', async () => {
    const response = await createIntent(h, cashierA, body);
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      status: 'created',
      amount_minor: '15000',
      currency: 'KES',
      mode: 'sandbox',
    });
    const stored = await h.owner((client) =>
      client.query(`select mode, created_by from payments.payment_intent where id = $1`, [
        response.body.id,
      ]),
    );
    expect(stored.rows[0]).toEqual({ mode: 'sandbox', created_by: h.seed.accounts.cashierA });
  });

  it('requires an Idempotency-Key', async () => {
    const response = await h
      .http()
      .post('/v1/payment-intents')
      .set('Authorization', `Bearer ${adminA.token}`)
      .set('Aora-Workspace-Id', adminA.workspace)
      .send(body);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('idempotency_key_required');
  });

  it('rejects amounts that are not strings of digits in minor units', async () => {
    for (const amount of [15000, 150.5, '150.50', '1e3', '-100', '0', '', ' 100', '0100', null]) {
      const response = await createIntent(h, adminA, { ...body, amount_minor: amount });
      expect(response.status, JSON.stringify(amount)).toBe(400);
      expect(response.body.error.code).toBe('invalid_request');
    }
    const missing = await createIntent(h, adminA, { currency: 'KES' });
    expect(missing.status).toBe(400);
  });

  it('rejects unknown fields, unknown scenarios and unsupported currencies', async () => {
    expect((await createIntent(h, adminA, { ...body, extra: true })).status).toBe(400);
    expect((await createIntent(h, adminA, { ...body, sandbox_scenario: 'nope' })).status).toBe(400);
    const usd = await createIntent(h, adminA, { ...body, currency: 'USD' });
    expect(usd.status).toBe(422);
    expect(usd.body.error.code).toBe('capability_not_supported');
  });
});

describe('idempotency', () => {
  it('returns the original intent for the same key and body', async () => {
    const key = randomUUID();
    const first = await createIntent(h, adminA, body, key);
    const second = await createIntent(h, adminA, body, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.body.id).toBe(first.body.id);
  });

  it('refuses the same key with a different body', async () => {
    const key = randomUUID();
    await createIntent(h, adminA, body, key);
    const changed = await createIntent(h, adminA, { ...body, amount_minor: '15001' }, key);
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe('idempotency_key_reused');
  });

  it('creates one intent, one outbox event and one audit event under concurrent duplicates', async () => {
    const key = randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => createIntent(h, adminA, body, key)),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([
      200, 200, 200, 200, 200, 200, 200, 200, 200, 201,
    ]);
    const id = responses[0]?.body.id as string;
    expect(new Set(responses.map((r) => r.body.id))).toEqual(new Set([id]));
    const counts = await h.owner((client) =>
      client.query(
        `select
           (select count(*) from payments.payment_intent where idempotency_key = $1) as intents,
           (select count(*) from outbox.outbox_event where payload->>'intent_id' = $2) as events,
           (select count(*) from audit.audit_event where subject_id = $2 and action = 'payments.intent.created') as audits`,
        [key, id],
      ),
    );
    expect(counts.rows[0]).toEqual({ intents: '1', events: '1', audits: '1' });
  });

  it('scopes keys to the tenant: the same key in another workspace is a different intent', async () => {
    const key = randomUUID();
    const a = await createIntent(h, adminA, body, key);
    const b = await createIntent(h, adminB, body, key);
    expect(b.status).toBe(201);
    expect(b.body.id).not.toBe(a.body.id);
  });
});

describe('tenant isolation and authorization at the API', () => {
  it('rejects unauthenticated requests', async () => {
    const response = await h.http().post('/v1/payment-intents').send(body);
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('unauthenticated');
  });

  it("does not let a user read or create in another merchant's workspace", async () => {
    const created = await createIntent(h, adminA, body);
    const id = created.body.id as string;

    // B asks in its own workspace: the intent does not exist there.
    const own = await getIntent(h, adminB, id);
    expect(own.status).toBe(404);
    // B names A's workspace: refused before any lookup.
    const foreign = await getIntent(h, { ...adminB, workspace: h.seed.tenantA }, id);
    expect(foreign.status).toBe(403);
    const write = await createIntent(h, { ...adminB, workspace: h.seed.tenantA }, body);
    expect(write.status).toBe(403);

    expect((await getIntent(h, adminA, id)).status).toBe(200);
  });

  it('lets a cashier create and read intents but not reach operator endpoints', async () => {
    const created = await createIntent(h, cashierA, body);
    expect(created.status).toBe(201);
    expect((await getIntent(h, cashierA, created.body.id)).status).toBe(200);
    for (const [method, path] of [
      ['get', '/v1/ops/reconciliation-exceptions'],
      ['post', '/v1/ops/reconciliation-runs'],
    ] as const) {
      const response = await h
        .http()
        [method](path)
        .set('Authorization', `Bearer ${cashierA.token}`);
      expect(response.status, path).toBe(403);
    }
  });

  it('returns 404 for a malformed or unknown id', async () => {
    expect((await getIntent(h, adminA, 'not-a-uuid')).status).toBe(404);
    expect((await getIntent(h, adminA, randomUUID())).status).toBe(404);
  });
});

describe('state machine', () => {
  const all = Object.keys(TRANSITIONS) as IntentStatus[];

  it('has no way out of reconciliation_required, and only that way out of a final state', () => {
    expect(TRANSITIONS.reconciliation_required).toEqual([]);
    expect(TRANSITIONS.succeeded).toEqual(['reconciliation_required']);
    expect(TRANSITIONS.failed).toEqual(['reconciliation_required']);
  });

  it('never allows a move back to created, or a second submission', () => {
    for (const from of all) {
      expect(TRANSITIONS[from]).not.toContain('created');
      if (from !== 'created') expect(TRANSITIONS[from]).not.toContain('submitting');
    }
  });

  it('only reaches succeeded from a state in which the provider was asked', () => {
    const sources = all.filter((from) => TRANSITIONS[from].includes('succeeded'));
    expect(sources.sort()).toEqual(['pending_provider', 'status_unknown', 'submitting']);
  });

  it('protects the amount, currency and tenant of an intent in the database', async () => {
    const created = await createIntent(h, adminA, body);
    for (const sql of [
      `update payments.payment_intent set amount = amount + 1 where id = $1`,
      `update payments.payment_intent set asset_code = 'KES', tenant_id = '${h.seed.tenantB}' where id = $1`,
      `delete from payments.payment_intent where id = $1`,
    ]) {
      await expect(
        h.owner((client) => client.query(sql, [created.body.id])),
        sql,
      ).rejects.toThrow(/immutable|append-only/);
    }
  });
});
