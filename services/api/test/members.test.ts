import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './support/harness.js';

let h: Harness;
let adminA: string;
let adminB: string;

beforeAll(async () => {
  h = await startHarness();
  adminA = await h.signIn('adminA');
  adminB = await h.signIn('adminB');
  await h.stepUp(adminA);
  await h.stepUp(adminB);
});
afterAll(() => h.close());

const call = (token: string, workspace: string) => ({
  Authorization: `Bearer ${token}`,
  'Aora-Workspace-Id': workspace,
});

async function members(token: string, workspace: string) {
  const response = await h.http().get('/v1/workspace/members').set(call(token, workspace));
  expect(response.status).toBe(200);
  return response.body.data as { id: string; account_id: string; role: string; status: string }[];
}

describe('member management', () => {
  it('lists only the caller’s workspace, without full phone numbers', async () => {
    const list = await members(adminA, h.seed.tenantA);
    expect(list.map((m) => m.role).sort()).toEqual(['admin', 'cashier', 'finance']);
    expect(JSON.stringify(list)).not.toContain('+9990000000');
    expect(await members(adminB, h.seed.tenantB)).toHaveLength(1);
  });

  it('requires a step-up to add a member', async () => {
    const fresh = await h.signIn('adminA');
    const response = await h
      .http()
      .post('/v1/workspace/members')
      .set(call(fresh, h.seed.tenantA))
      .send({ phone: '+99900000050', role: 'cashier' });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('step_up_required');
  });

  it('adds a member, creating the account if the number is new, and audits it', async () => {
    const response = await h
      .http()
      .post('/v1/workspace/members')
      .set(call(adminA, h.seed.tenantA))
      .send({ phone: '+99900000050', role: 'cashier' });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ role: 'cashier', status: 'active', mode: 'sandbox' });
    const again = await h
      .http()
      .post('/v1/workspace/members')
      .set(call(adminA, h.seed.tenantA))
      .send({ phone: '+99900000050', role: 'finance' });
    expect(again.status).toBe(409);
    const audit = await h.owner((client) =>
      client.query(
        `select count(*) as n from audit.audit_event where action = 'tenancy.member.added' and tenant_id = $1`,
        [h.seed.tenantA],
      ),
    );
    expect(audit.rows[0]?.n).toBe('1');
  });

  it("cannot see, change or add to another merchant's workspace", async () => {
    const victim = (await members(adminA, h.seed.tenantA)).find((m) => m.role === 'cashier');
    const viaOwnWorkspace = await h
      .http()
      .patch(`/v1/workspace/members/${victim?.id ?? ''}`)
      .set(call(adminB, h.seed.tenantB))
      .send({ role: 'admin' });
    expect(viaOwnWorkspace.status).toBe(404);
    const viaTheirWorkspace = await h
      .http()
      .patch(`/v1/workspace/members/${victim?.id ?? ''}`)
      .set(call(adminB, h.seed.tenantA))
      .send({ role: 'admin' });
    expect(viaTheirWorkspace.status).toBe(403);
    const add = await h
      .http()
      .post('/v1/workspace/members')
      .set(call(adminB, h.seed.tenantA))
      .send({ phone: '+99900000004', role: 'admin' });
    expect(add.status).toBe(403);
    expect((await members(adminA, h.seed.tenantA)).find((m) => m.id === victim?.id)?.role).toBe(
      'cashier',
    );
  });

  it('changes a role and removes a member; a removed member loses access at once', async () => {
    const cashierToken = await h.signIn('cashierA');
    const cashier = (await members(adminA, h.seed.tenantA)).find(
      (m) => m.account_id === h.seed.accounts.cashierA,
    );
    const promote = await h
      .http()
      .patch(`/v1/workspace/members/${cashier?.id ?? ''}`)
      .set(call(adminA, h.seed.tenantA))
      .send({ role: 'finance' });
    expect(promote.status).toBe(200);
    expect(promote.body.role).toBe('finance');

    const remove = await h
      .http()
      .patch(`/v1/workspace/members/${cashier?.id ?? ''}`)
      .set(call(adminA, h.seed.tenantA))
      .send({ status: 'removed' });
    expect(remove.status).toBe(200);
    const after = await h.http().get('/v1/ledger/balances').set(call(cashierToken, h.seed.tenantA));
    expect(after.status).toBe(403);
  });

  it('never leaves a workspace without an active admin', async () => {
    const self = (await members(adminB, h.seed.tenantB))[0];
    for (const change of [{ role: 'cashier' }, { status: 'removed' }]) {
      const response = await h
        .http()
        .patch(`/v1/workspace/members/${self?.id ?? ''}`)
        .set(call(adminB, h.seed.tenantB))
        .send(change);
      expect(response.status).toBe(409);
    }
    // And the database refuses it too, whatever the application does.
    await expect(
      h.db.asPlatform((tx) =>
        tx.membership.update({ where: { id: self?.id ?? '' }, data: { role: 'cashier' } }),
      ),
    ).rejects.toThrow(/active admin/);
  });
});
