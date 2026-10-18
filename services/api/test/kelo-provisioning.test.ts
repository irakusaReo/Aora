import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ProvisioningService } from '../src/modules/kelo/provisioning.service.js';
import { OutboxService } from '../src/modules/outbox/outbox.service.js';
import { type Harness, startHarness } from './support/harness.js';
import { newUser } from './support/users.js';

/**
 * KELO store enlistment and KELO-to-KONY provisioning (ADR 0008, brief §13.4,
 * journey K1's first half). Written before the code.
 */

let h: Harness;
let operator: string;

beforeAll(async () => {
  h = await startHarness();
  operator = await h.signIn('operator');
});
afterAll(() => h.close());

let regCounter = 5000;
const nextReg = (): string => `KELO-REG-${String((regCounter += 1))}`;

const registered = (name: string, value: string) => ({
  kind: 'registered',
  name,
  country: 'KE',
  registration: { type: 'sandbox_registration_number', value },
});

function enlist(token: string, body: unknown, key: string = randomUUID()): Promise<Response> {
  return h
    .http()
    .post('/v1/kelo/stores')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', key)
    .send(body as object);
}

const storeBody = (business: unknown, categories: string[] = ['electronics']) => ({
  display_name: 'Sandbox Electronics',
  categories,
  business,
});

/** Attests every vetting requirement of each category the store asked for. */
async function attestationsFor(storeId: string): Promise<Record<string, string[]>> {
  const store = await h
    .http()
    .get(`/v1/ops/kelo/stores/${storeId}`)
    .set('Authorization', `Bearer ${operator}`);
  expect(store.status).toBe(200);
  const result: Record<string, string[]> = {};
  for (const category of store.body.categories as { slug: string; requirements: string[] }[]) {
    result[category.slug] = category.requirements;
  }
  return result;
}

async function decide(
  storeId: string,
  outcome: 'approved' | 'rejected',
  extra: Record<string, unknown> = {},
): Promise<Response> {
  const attestations = outcome === 'approved' ? await attestationsFor(storeId) : {};
  return h
    .http()
    .post(`/v1/ops/kelo/stores/${storeId}/decision`)
    .set('Authorization', `Bearer ${operator}`)
    .send({ outcome, reason: 'Sandbox vetting completed by operator.', attestations, ...extra });
}

const count = async (sql: string, params: unknown[] = []): Promise<number> =>
  h.owner(async (client) => Number((await client.query(sql, params)).rows[0].n));

const provisioningOf = async (storeId: string) =>
  h.owner(async (client) => {
    const rows = await client.query(
      `select status, last_step, reason, tenant_id, business_id, admin_account_id
         from kelo.provisioning where store_id = $1`,
      [storeId],
    );
    return rows.rows as {
      status: string;
      last_step: string | null;
      reason: string | null;
      tenant_id: string | null;
      business_id: string | null;
      admin_account_id: string | null;
    }[];
  });

/** Enlists a new registered business and approves it; returns the store id. */
async function approvedStore(
  owner: { token: string },
  reg: string = nextReg(),
  extra: Record<string, unknown> = {},
): Promise<string> {
  const created = await enlist(owner.token, storeBody(registered(`Store ${reg} Ltd`, reg)));
  expect(created.status).toBe(201);
  const decided = await decide(created.body.id as string, 'approved', extra);
  expect(decided.status).toBe(200);
  return created.body.id as string;
}

describe('enlisting a store', () => {
  it('records an enlistment as submitted, with no business or workspace yet', async () => {
    const owner = await newUser(h, 'Akinyi');
    const response = await enlist(
      owner.token,
      storeBody(registered('Akinyi Gadgets Ltd', nextReg())),
    );
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      status: 'submitted',
      display_name: 'Sandbox Electronics',
      workspace_id: null,
      provisioning_status: null,
      mode: 'sandbox',
    });
    expect(
      await count(
        `select count(*) n from tenancy.membership m
                   join identity.user_account a on a.id = m.account_id where a.id = $1`,
        [owner.accountId],
      ),
    ).toBe(0);
  });

  it('replays the same request for the same Idempotency-Key and refuses a different one', async () => {
    const owner = await newUser(h, 'Baraka');
    const key = randomUUID();
    const body = storeBody(registered('Baraka Solar Ltd', nextReg()), ['solar-home-systems']);
    const first = await enlist(owner.token, body, key);
    const again = await enlist(owner.token, body, key);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(again.body.id).toBe(first.body.id);
    const other = await enlist(owner.token, { ...body, display_name: 'Something else' }, key);
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('idempotency_key_reused');
  });

  it('refuses an unknown category, and needs a phone number behind the business', async () => {
    const owner = await newUser(h, 'Chebet');
    const unknown = await enlist(
      owner.token,
      storeBody(registered('Chebet Ltd', nextReg()), ['weapons']),
    );
    expect(unknown.status).toBe(400);
    const noPhone = await newUser(h, 'Daudi', { phone: false });
    const refused = await enlist(noPhone.token, storeBody(registered('Daudi Ltd', nextReg())));
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('phone_required');
  });

  it("lets only the workspace's admin enlist an existing KONY workspace", async () => {
    const cashier = await h.signIn('cashierA');
    const refused = await enlist(cashier, storeBody({ workspace_id: h.seed.tenantA }));
    expect(refused.status).toBe(403);
    const stranger = await newUser(h, 'Esther');
    const alsoRefused = await enlist(stranger.token, storeBody({ workspace_id: h.seed.tenantA }));
    expect(alsoRefused.status).toBe(403);
  });

  it('shows an applicant only their own enlistments', async () => {
    const owner = await newUser(h, 'Faith');
    const created = await enlist(owner.token, storeBody(registered('Faith Ltd', nextReg())));
    const other = await newUser(h, 'Gitau');
    const peek = await h
      .http()
      .get(`/v1/kelo/stores/${created.body.id as string}`)
      .set('Authorization', `Bearer ${other.token}`);
    expect(peek.status).toBe(404);
    const mine = await h
      .http()
      .get('/v1/kelo/stores')
      .set('Authorization', `Bearer ${other.token}`);
    expect(mine.body.data).toEqual([]);
  });
});

describe('vetting', () => {
  it('is operator-only', async () => {
    const owner = await newUser(h, 'Hassan');
    const created = await enlist(owner.token, storeBody(registered('Hassan Ltd', nextReg())));
    const attempt = await h
      .http()
      .post(`/v1/ops/kelo/stores/${created.body.id as string}/decision`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ outcome: 'approved', reason: 'I approve my own store.', attestations: {} });
    expect(attempt.status).toBe(403);
  });

  it("refuses approval until every category's requirements are attested", async () => {
    const owner = await newUser(h, 'Imani');
    const created = await enlist(
      owner.token,
      storeBody(registered('Imani Optical Ltd', nextReg()), ['optical']),
    );
    const response = await h
      .http()
      .post(`/v1/ops/kelo/stores/${created.body.id as string}/decision`)
      .set('Authorization', `Bearer ${operator}`)
      .send({ outcome: 'approved', reason: 'Looks fine to me.', attestations: { optical: [] } });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_request');
  });

  it('is final: a rejected store creates nothing and cannot then be approved', async () => {
    const owner = await newUser(h, 'Juma');
    const created = await enlist(owner.token, storeBody(registered('Juma Ltd', nextReg())));
    const id = created.body.id as string;
    expect((await decide(id, 'rejected')).status).toBe(200);
    expect((await decide(id, 'approved')).status).toBe(409);
    await h.settle();
    expect(await provisioningOf(id)).toEqual([]);
  });
});

describe('provisioning (brief §13.4)', () => {
  it('gives an approved store exactly one linked KONY workspace, with the applicant as admin', async () => {
    const owner = await newUser(h, 'Kamau');
    const storeId = await approvedStore(owner);
    await h.settle();

    const [record] = await provisioningOf(storeId);
    expect(record).toMatchObject({ status: 'completed', admin_account_id: owner.accountId });
    const store = await h
      .http()
      .get(`/v1/kelo/stores/${storeId}`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(store.body).toMatchObject({
      status: 'approved',
      provisioning_status: 'completed',
      workspace_id: record?.tenant_id,
    });
    // The administrator is linked to the correct business.
    expect(
      await count(`select count(*) n from tenancy.workspace where id = $1 and business_id = $2`, [
        record?.tenant_id,
        record?.business_id,
      ]),
    ).toBe(1);
    const me = await h.http().get('/v1/me').set('Authorization', `Bearer ${owner.token}`);
    expect(me.body.memberships).toEqual([{ workspace_id: record?.tenant_id, role: 'admin' }]);
  });

  it('creates nothing new when the approval event is delivered again', async () => {
    const owner = await newUser(h, 'Lilian');
    const storeId = await approvedStore(owner);
    await h.settle();
    const workspaces = await count(`select count(*) n from tenancy.workspace`);
    const businesses = await count(`select count(*) n from business.business`);
    const memberships = await count(`select count(*) n from tenancy.membership`);
    // Redeliver: the outbox promises at least once, never exactly once.
    await h.owner((client) =>
      client.query(
        `update outbox.outbox_event set status = 'pending', available_at = now()
          where type = 'kelo.store.approved' and payload->>'store_id' = $1`,
        [storeId],
      ),
    );
    await h.settle();
    expect(await count(`select count(*) n from tenancy.workspace`)).toBe(workspaces);
    expect(await count(`select count(*) n from business.business`)).toBe(businesses);
    expect(await count(`select count(*) n from tenancy.membership`)).toBe(memberships);
    expect(await provisioningOf(storeId)).toHaveLength(1);
  });

  it('resumes from the last committed step after a crash', async () => {
    const owner = await newUser(h, 'Mwangi');
    const storeId = await approvedStore(owner);
    // Run exactly one step, as a worker that crashes straight afterwards would.
    const provisioning = h.app.get(ProvisioningService);
    await provisioning.stepByStore(storeId);
    expect((await provisioningOf(storeId))[0]?.status).toBe('business_resolved');
    // The outbox event is still there; the next worker picks it up and finishes.
    await h.settle();
    const [record] = await provisioningOf(storeId);
    expect(record?.status).toBe('completed');
    expect(
      await count(`select count(*) n from tenancy.workspace where business_id = $1`, [
        record?.business_id,
      ]),
    ).toBe(1);
  });

  it('marks an unexpected failure retryable and completes on a later attempt', async () => {
    const owner = await newUser(h, 'Njeri');
    const storeId = await approvedStore(owner);
    // The workspace step fails once, as a dropped connection would make it.
    const provisioning: { linkWorkspace: () => Promise<unknown> } = h.app.get<
      ProvisioningService,
      { linkWorkspace: () => Promise<unknown> }
    >(ProvisioningService);
    vi.spyOn(provisioning, 'linkWorkspace').mockRejectedValueOnce(new Error('connection lost'));
    await h.app.get(OutboxService).runUntilIdle();
    const [failed] = await provisioningOf(storeId);
    expect(failed).toMatchObject({ status: 'failed_retryable', last_step: 'business_resolved' });
    await h.makeDelayedEventsDue();
    await h.settle();
    expect((await provisioningOf(storeId))[0]?.status).toBe('completed');
  });

  it('backfills an approved store whose event never ran (the migration path)', async () => {
    const owner = await newUser(h, 'Otieno');
    const created = await enlist(owner.token, storeBody(registered('Otieno Ltd', nextReg())));
    const storeId = created.body.id as string;
    // As if the store had been approved before provisioning existed: no record, no event.
    await h.owner((client) =>
      client.query(
        `update kelo.store set status = 'approved', decided_at = now(),
                decision_reason = 'Approved before provisioning existed.' where id = $1`,
        [storeId],
      ),
    );
    expect(await provisioningOf(storeId)).toEqual([]);
    const run = await h
      .http()
      .get('/v1/internal/cron/kelo-provisioning-backfill')
      .set('Authorization', `Bearer ${h.config.cronSecret ?? ''}`);
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ enqueued: 1 });
    await h.settle();
    expect((await provisioningOf(storeId))[0]?.status).toBe('completed');
    // A second run finds nothing to do.
    const again = await h
      .http()
      .get('/v1/internal/cron/kelo-provisioning-backfill')
      .set('Authorization', `Bearer ${h.config.cronSecret ?? ''}`);
    expect(again.body).toMatchObject({ enqueued: 0 });
  });

  it('links an existing KONY workspace when its admin enlists it, creating no second workspace', async () => {
    const admin = await h.signIn('adminA');
    const before = await count(`select count(*) n from tenancy.workspace`);
    const created = await enlist(admin, storeBody({ workspace_id: h.seed.tenantA }, ['furniture']));
    expect(created.status).toBe(201);
    expect((await decide(created.body.id as string, 'approved')).status).toBe(200);
    await h.settle();
    const [record] = await provisioningOf(created.body.id as string);
    expect(record).toMatchObject({ status: 'completed', tenant_id: h.seed.tenantA });
    expect(await count(`select count(*) n from tenancy.workspace`)).toBe(before);
  });

  it("never hands a business's existing workspace to another person", async () => {
    const first = await newUser(h, 'Pendo');
    const reg = nextReg();
    await approvedStore(first, reg);
    await h.settle();
    // A second person enlists the same verified registered business.
    const second = await newUser(h, 'Quincy');
    const created = await enlist(second.token, storeBody(registered('Another Name Ltd', reg)));
    await decide(created.body.id as string, 'approved');
    await h.settle();
    const [record] = await provisioningOf(created.body.id as string);
    expect(record?.status).toBe('failed_needs_review');
    const me = await h.http().get('/v1/me').set('Authorization', `Bearer ${second.token}`);
    expect(me.body.memberships).toEqual([]);
  });

  it('gives two stores approved together for one new business one workspace between them', async () => {
    const owner = await newUser(h, 'Rehema');
    const reg = nextReg();
    const a = await enlist(owner.token, storeBody(registered('Rehema Ltd', reg)));
    const b = await enlist(owner.token, {
      ...storeBody(registered('Rehema Ltd', reg)),
      display_name: 'Second shop front',
    });
    await Promise.all([
      decide(a.body.id as string, 'approved'),
      decide(b.body.id as string, 'approved'),
    ]);
    await Promise.all([h.settle(), h.settle()]);
    const records = [
      ...(await provisioningOf(a.body.id as string)),
      ...(await provisioningOf(b.body.id as string)),
    ];
    expect(records.map((record) => record.status).sort()).toEqual([
      'completed',
      'failed_needs_review',
    ]);
    const businessId = records.find((record) => record.status === 'completed')?.business_id;
    expect(
      await count(`select count(*) n from tenancy.workspace where business_id = $1`, [businessId]),
    ).toBe(1);
  });

  it('grants workspace administration only, never payment or payout authority by itself', async () => {
    const owner = await newUser(h, 'Saida');
    const storeId = await approvedStore(owner);
    await h.settle();
    const workspace = (await provisioningOf(storeId))[0]?.tenant_id ?? '';
    // A payout still needs a PIN step-up; provisioning set none.
    const payout = await h
      .http()
      .post('/v1/payouts')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('Aora-Workspace-Id', workspace)
      .set('Idempotency-Key', randomUUID())
      .send({ recipient_id: randomUUID(), amount_minor: '1000', currency: 'KES' });
    expect(payout.status).toBe(403);
    expect(['step_up_required', 'pin_not_set']).toContain(payout.body.error.code);
  });
});

describe('restrictions (brief §13.4: restricted merchants remain restricted)', () => {
  it('copies a vetting restriction to the workspace, enforces it, and lets only an operator lift it', async () => {
    const owner = await newUser(h, 'Tumaini');
    const storeId = await approvedStore(owner, nextReg(), { restrictions: ['payouts_suspended'] });
    await h.settle();
    const workspace = (await provisioningOf(storeId))[0]?.tenant_id ?? '';
    await h.stepUp(owner.token);

    const preview = () =>
      h
        .http()
        .post('/v1/payouts/preview')
        .set('Authorization', `Bearer ${owner.token}`)
        .set('Aora-Workspace-Id', workspace)
        .send({ recipient_id: randomUUID(), amount_minor: '1000', currency: 'KES' });
    const refused = await preview();
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('workspace_restricted');

    const workspaceView = await h
      .http()
      .get('/v1/workspace')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('Aora-Workspace-Id', workspace);
    expect(workspaceView.body.restrictions).toEqual(['payouts_suspended']);

    const byOwner = await h
      .http()
      .post(`/v1/ops/workspaces/${workspace}/restrictions/payouts_suspended/lift`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ reason: 'Lifting my own restriction.' });
    expect(byOwner.status).toBe(403);
    const lifted = await h
      .http()
      .post(`/v1/ops/workspaces/${workspace}/restrictions/payouts_suspended/lift`)
      .set('Authorization', `Bearer ${operator}`)
      .send({ reason: 'Sandbox: documents received and checked.' });
    expect(lifted.status).toBe(200);
    expect((await preview()).body.error?.code).not.toBe('workspace_restricted');
    expect(
      await count(
        `select count(*) n from audit.audit_event where action = 'tenancy.restriction.lifted' and tenant_id = $1`,
        [workspace],
      ),
    ).toBe(1);
  });
});

describe('isolation and visibility', () => {
  it("never lets one merchant read another's provisioning or store", async () => {
    const owner = await newUser(h, 'Uhuru');
    const storeId = await approvedStore(owner);
    await h.settle();
    const adminB = await h.signIn('adminB');
    const peek = await h
      .http()
      .get(`/v1/kelo/stores/${storeId}`)
      .set('Authorization', `Bearer ${adminB}`);
    expect(peek.status).toBe(404);
    // At the database: the tenant role sees no store of another tenant.
    const workspace = (await provisioningOf(storeId))[0]?.tenant_id ?? '';
    const seen = await h.db.withTenant(
      h.seed.tenantB,
      (tx) =>
        tx.$queryRaw<
          { n: bigint }[]
        >`select count(*) n from kelo.store where tenant_id = ${workspace}::uuid`,
    );
    expect(Number(seen[0]?.n)).toBe(0);
  });

  it('shows operators provisioning records by status, and records each transition in the audit trail', async () => {
    const owner = await newUser(h, 'Wairimu');
    const storeId = await approvedStore(owner);
    await h.settle();
    const list = await h
      .http()
      .get('/v1/ops/kelo/provisioning?status=completed')
      .set('Authorization', `Bearer ${operator}`);
    expect(list.status).toBe(200);
    expect((list.body.data as { store_id: string }[]).map((row) => row.store_id)).toContain(
      storeId,
    );
    expect(
      await count(
        `select count(*) n from audit.audit_event where subject_type = 'kelo_provisioning'
           and detail->>'store_id' = $1`,
        [storeId],
      ),
    ).toBeGreaterThanOrEqual(4);
  });

  it('lets an operator retry a record that needs review, with an audited reason', async () => {
    const first = await newUser(h, 'Xavier');
    const reg = nextReg();
    await approvedStore(first, reg);
    await h.settle();
    const second = await newUser(h, 'Yusuf');
    const created = await enlist(second.token, storeBody(registered('Yusuf Ltd', reg)));
    await decide(created.body.id as string, 'approved');
    await h.settle();
    const list = await h
      .http()
      .get('/v1/ops/kelo/provisioning?status=failed_needs_review')
      .set('Authorization', `Bearer ${operator}`);
    const record = (list.body.data as { id: string; store_id: string }[]).find(
      (row) => row.store_id === created.body.id,
    );
    expect(record).toBeDefined();
    // Retrying does not change the facts: the workspace still belongs to someone else.
    const retried = await h
      .http()
      .post(`/v1/ops/kelo/provisioning/${record?.id ?? ''}/retry`)
      .set('Authorization', `Bearer ${operator}`)
      .send({ reason: 'Checked with the business; retrying after review.' });
    expect(retried.status).toBe(200);
    await h.settle();
    expect((await provisioningOf(created.body.id as string))[0]?.status).toBe(
      'failed_needs_review',
    );
  });
});
