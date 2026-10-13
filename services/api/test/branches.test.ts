import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './support/harness.js';
import { type Caller, createIntent, getIntent, ids } from './support/payments.js';

let h: Harness;
let admin: Caller;
let finance: Caller;
let cashier: Caller;
let adminB: Caller;
let counter: string;
let kiosk: string;

const as = (caller: Caller, method: 'get' | 'post' | 'patch', path: string) =>
  h
    .http()
    [method](path)
    .set('Authorization', `Bearer ${caller.token}`)
    .set('Aora-Workspace-Id', caller.workspace);

beforeAll(async () => {
  h = await startHarness();
  admin = { token: await h.signIn('adminA'), workspace: h.seed.tenantA };
  finance = { token: await h.signIn('financeA'), workspace: h.seed.tenantA };
  cashier = { token: await h.signIn('cashierA'), workspace: h.seed.tenantA };
  adminB = { token: await h.signIn('adminB'), workspace: h.seed.tenantB };
  await h.stepUp(admin.token);
});
afterAll(() => h.close());

describe('branches', () => {
  it('lets an admin add branches, and nobody else', async () => {
    const first = await as(admin, 'post', '/v1/workspace/branches').send({ name: 'Front counter' });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ name: 'Front counter', status: 'active' });
    counter = first.body.id as string;
    kiosk = (await as(admin, 'post', '/v1/workspace/branches').send({ name: 'Market kiosk' })).body
      .id as string;

    expect((await as(finance, 'post', '/v1/workspace/branches').send({ name: 'X' })).status).toBe(
      403,
    );
    expect((await as(cashier, 'post', '/v1/workspace/branches').send({ name: 'X' })).status).toBe(
      403,
    );
  });

  it('refuses a second branch with the same name, ignoring case and spacing', async () => {
    const response = await as(admin, 'post', '/v1/workspace/branches').send({
      name: '  front COUNTER ',
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('conflict');
  });

  it('records one audit event per branch created', async () => {
    const events = await h.owner((client) =>
      client.query(
        `select count(*)::int as n from audit.audit_event where action = 'tenancy.branch.created'`,
      ),
    );
    expect(events.rows[0].n).toBe(2);
  });

  it('shows a workspace only its own branches, at the API and in the database', async () => {
    const mine = await as(admin, 'get', '/v1/workspace/branches');
    expect(ids(mine).sort()).toEqual([counter, kiosk].sort());
    expect((await as(adminB, 'get', '/v1/workspace/branches')).body.data).toEqual([]);

    const rows = await h.db.withTenant(h.seed.tenantB, (tx) => tx.branch.findMany());
    expect(rows).toEqual([]);
    await expect(
      h.db.withTenant(h.seed.tenantA, (tx) =>
        tx.branch.create({ data: { tenant_id: h.seed.tenantA, name: 'Sneaky' } }),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('cannot rename or close a branch of another workspace', async () => {
    const response = await as(adminB, 'patch', `/v1/workspace/branches/${counter}`).send({
      status: 'closed',
    });
    expect(response.status).toBe(404);
  });
});

describe('a cashier and their branch', () => {
  let cashierMembership: string;
  let atCounter: string;
  let atKiosk: string;
  let noBranch: string;

  it('is assigned by an admin, and only to a branch of the same workspace', async () => {
    const members = await as(admin, 'get', '/v1/workspace/members');
    cashierMembership =
      (members.body.data as { id: string; role: string }[]).find((row) => row.role === 'cashier')
        ?.id ?? '';

    const other = await as(adminB, 'post', '/v1/workspace/branches').send({ name: 'Stall' });
    const foreign = await as(admin, 'patch', `/v1/workspace/members/${cashierMembership}`).send({
      branch_id: other.body.id,
    });
    expect(foreign.status).toBe(400);

    const assigned = await as(admin, 'patch', `/v1/workspace/members/${cashierMembership}`).send({
      branch_id: counter,
    });
    expect(assigned.status).toBe(200);
    expect(assigned.body.branch_id).toBe(counter);
  });

  it('takes collections for their own branch only', async () => {
    // The session reads memberships on each request, so the assignment applies at once.
    const own = await createIntent(h, cashier, {
      amount_minor: '2000',
      currency: 'KES',
      reference: 'ORDER-17',
    });
    expect(own.status).toBe(201);
    expect(own.body).toMatchObject({ branch_id: counter, reference: 'ORDER-17' });
    atCounter = own.body.id as string;

    const elsewhere = await createIntent(h, cashier, {
      amount_minor: '2000',
      currency: 'KES',
      branch_id: kiosk,
    });
    expect(elsewhere.status).toBe(403);
  });

  it('sees only the collections of their branch', async () => {
    atKiosk = (
      await createIntent(h, admin, { amount_minor: '3000', currency: 'KES', branch_id: kiosk })
    ).body.id as string;
    noBranch = (await createIntent(h, admin, { amount_minor: '4000', currency: 'KES' })).body
      .id as string;

    const listed = await as(cashier, 'get', '/v1/payment-intents');
    expect(listed.status).toBe(200);
    expect(ids(listed)).toEqual([atCounter]);

    expect((await getIntent(h, cashier, atCounter)).status).toBe(200);
    expect((await getIntent(h, cashier, atKiosk)).status).toBe(404);
    expect((await getIntent(h, cashier, noBranch)).status).toBe(404);
  });

  it('lets finance and admin see every branch, newest first, and filter by one', async () => {
    const all = await as(finance, 'get', '/v1/payment-intents');
    expect(ids(all)).toEqual([noBranch, atKiosk, atCounter]);
    const filtered = await as(finance, 'get', '/v1/payment-intents').query({ branch_id: kiosk });
    expect(ids(filtered)).toEqual([atKiosk]);
  });

  it('pages through the list with a cursor, without repeats or gaps', async () => {
    const first = await as(admin, 'get', '/v1/payment-intents').query({ limit: 2 });
    expect(first.body.data).toHaveLength(2);
    expect(first.body.next_cursor).toEqual(expect.any(String));
    const second = await as(admin, 'get', '/v1/payment-intents').query({
      limit: 2,
      cursor: first.body.next_cursor,
    });
    expect(ids(second)).toEqual([atCounter]);
    expect(second.body.next_cursor).toBeNull();
  });

  it('refuses a collection for a branch of another workspace or a closed branch', async () => {
    const foreign = await createIntent(h, adminB, {
      amount_minor: '1000',
      currency: 'KES',
      branch_id: counter,
    });
    expect(foreign.status).toBe(400);

    const closed = await as(admin, 'patch', `/v1/workspace/branches/${kiosk}`).send({
      status: 'closed',
    });
    expect(closed.status).toBe(200);
    const late = await createIntent(h, admin, {
      amount_minor: '1000',
      currency: 'KES',
      branch_id: kiosk,
    });
    expect(late.status).toBe(400);
  });

  it('never lets another workspace list these collections', async () => {
    expect((await as(adminB, 'get', '/v1/payment-intents')).body.data).toEqual([]);
  });
});
