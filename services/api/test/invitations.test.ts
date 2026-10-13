import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './support/harness.js';
import { newUser } from './support/users.js';

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

const inWorkspace = (token: string, workspace: string) => ({
  Authorization: `Bearer ${token}`,
  'Aora-Workspace-Id': workspace,
});

const invite = (token: string, workspace: string, body: object): Promise<Response> =>
  h.http().post('/v1/workspace/invitations').set(inWorkspace(token, workspace)).send(body);

const mine = (token: string): Promise<Response> =>
  h.http().get('/v1/me/invitations').set('Authorization', `Bearer ${token}`);

const accept = (token: string, id: string): Promise<Response> =>
  h.http().post(`/v1/me/invitations/${id}/accept`).set('Authorization', `Bearer ${token}`);

describe('inviting staff by email', () => {
  it('needs an admin and a PIN step-up', async () => {
    const fresh = await h.signIn('adminA');
    const noStepUp = await invite(fresh, h.seed.tenantA, {
      email: 'x@people.aora.test',
      role: 'cashier',
    });
    expect(noStepUp.body.error.code).toBe('step_up_required');
    const finance = await h.signIn('financeA');
    await h.stepUp(finance);
    const notAdmin = await invite(finance, h.seed.tenantA, {
      email: 'x@people.aora.test',
      role: 'cashier',
    });
    expect(notAdmin.status).toBe(403);
  });

  it('lets the invited person, and only them, see and accept the invitation', async () => {
    const invitee = await newUser(h, 'Njeri', { phone: false });
    const created = await invite(adminA, h.seed.tenantA, {
      email: invitee.email.toUpperCase(),
      role: 'cashier',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'pending', role: 'cashier', mode: 'sandbox' });
    const id = created.body.id as string;

    const stranger = await newUser(h, 'Stranger');
    expect((await mine(stranger.token)).body.data).toEqual([]);
    expect((await accept(stranger.token, id)).status).toBe(404);

    const seen = await mine(invitee.token);
    expect(seen.body.data).toHaveLength(1);
    expect(seen.body.data[0]).toMatchObject({
      id,
      role: 'cashier',
      workspace_name: 'Sandbox Hardware Ltd',
    });

    const accepted = await accept(invitee.token, id);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ workspace_id: h.seed.tenantA, role: 'cashier' });
    // Accepting again changes nothing and creates no second membership.
    expect((await accept(invitee.token, id)).status).toBe(200);
    const memberships = await h.owner((client) =>
      client.query(
        `select count(*)::int as n from tenancy.membership where account_id = $1 and tenant_id = $2`,
        [invitee.accountId, h.seed.tenantA],
      ),
    );
    expect(memberships.rows[0].n).toBe(1);

    const me = await h.http().get('/v1/me').set('Authorization', `Bearer ${invitee.token}`);
    expect(me.body.memberships).toEqual([{ workspace_id: h.seed.tenantA, role: 'cashier' }]);
    expect((await mine(invitee.token)).body.data).toEqual([]);
  });

  it('works for someone who has no account yet when they are invited', async () => {
    const address = 'future.hire@people.aora.test';
    const created = await invite(adminA, h.seed.tenantA, { email: address, role: 'finance' });
    expect(created.status).toBe(201);
    const later = await newUser(h, 'Future', { email: address, phone: false });
    const seen = await mine(later.token);
    expect(seen.body.data).toHaveLength(1);
    expect((await accept(later.token, seen.body.data[0].id as string)).status).toBe(200);
  });

  it('emails an invitee who already has an account, through the notifications module', async () => {
    const invitee = await newUser(h, 'Mailed', { phone: false });
    await invite(adminA, h.seed.tenantA, { email: invitee.email, role: 'cashier' });
    await h.settle();
    const sent = await h.owner((client) =>
      client.query(`select subject, body_text from sim.sim_email where to_address = $1`, [
        invitee.email,
      ]),
    );
    expect(sent.rows).toHaveLength(1);
    expect(sent.rows[0].subject).toMatch(/^\[SANDBOX\]/);
    // Nothing in the email can accept the invitation: no link carrying its id.
    expect(sent.rows[0].body_text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('refuses a second open invitation, an existing member, and a branch of another workspace', async () => {
    await invite(adminA, h.seed.tenantA, { email: 'dup@people.aora.test', role: 'cashier' });
    const twice = await invite(adminA, h.seed.tenantA, {
      email: 'DUP@people.aora.test',
      role: 'finance',
    });
    expect(twice.status).toBe(409);
    const member = await invite(adminA, h.seed.tenantA, {
      email: 'financeA@sandbox.aora.test',
      role: 'cashier',
    });
    expect(member.status).toBe(409);
    const branchB = await h
      .http()
      .post('/v1/workspace/branches')
      .set(inWorkspace(adminB, h.seed.tenantB))
      .send({ name: 'B branch' });
    const foreign = await invite(adminA, h.seed.tenantA, {
      email: 'branch@people.aora.test',
      role: 'cashier',
      branch_id: branchB.body.id,
    });
    expect(foreign.status).toBe(400);
  });

  it('puts an invited cashier straight into their branch', async () => {
    const branch = await h
      .http()
      .post('/v1/workspace/branches')
      .set(inWorkspace(adminA, h.seed.tenantA))
      .send({ name: 'Till 2' });
    const invitee = await newUser(h, 'Till', { phone: false });
    const created = await invite(adminA, h.seed.tenantA, {
      email: invitee.email,
      role: 'cashier',
      branch_id: branch.body.id,
    });
    await accept(invitee.token, created.body.id as string);
    const members = await h
      .http()
      .get('/v1/workspace/members')
      .set(inWorkspace(adminA, h.seed.tenantA));
    const row = (members.body.data as { account_id: string; branch_id: string | null }[]).find(
      (entry) => entry.account_id === invitee.accountId,
    );
    expect(row?.branch_id).toBe(branch.body.id);
  });

  it('cannot be accepted once revoked or expired', async () => {
    const revoked = await newUser(h, 'Revoked', { phone: false });
    const first = await invite(adminA, h.seed.tenantA, { email: revoked.email, role: 'cashier' });
    const gone = await h
      .http()
      .delete(`/v1/workspace/invitations/${first.body.id as string}`)
      .set(inWorkspace(adminA, h.seed.tenantA));
    expect(gone.status).toBe(200);
    expect(gone.body.status).toBe('revoked');
    expect((await accept(revoked.token, first.body.id as string)).status).toBe(404);

    const late = await newUser(h, 'Late', { phone: false });
    const second = await invite(adminA, h.seed.tenantA, { email: late.email, role: 'cashier' });
    await h.owner((client) =>
      client.query(
        `update tenancy.invitation set expires_at = now() - interval '1 minute' where id = $1`,
        [second.body.id],
      ),
    );
    expect((await mine(late.token)).body.data).toEqual([]);
    expect((await accept(late.token, second.body.id as string)).status).toBe(404);
  });

  it('shows a workspace only its own invitations, at the API and in the database', async () => {
    const listA = await h
      .http()
      .get('/v1/workspace/invitations')
      .set(inWorkspace(adminA, h.seed.tenantA));
    expect(listA.status).toBe(200);
    expect(listA.body.data.length).toBeGreaterThan(0);
    const listB = await h
      .http()
      .get('/v1/workspace/invitations')
      .set(inWorkspace(adminB, h.seed.tenantB));
    expect(listB.body.data).toEqual([]);

    const someId = (listA.body.data as { id: string }[])[0]?.id ?? '';
    const cross = await h
      .http()
      .delete(`/v1/workspace/invitations/${someId}`)
      .set(inWorkspace(adminB, h.seed.tenantB));
    expect(cross.status).toBe(404);

    expect(await h.db.withTenant(h.seed.tenantB, (tx) => tx.invitation.findMany())).toEqual([]);
    await expect(
      h.db.withTenant(
        h.seed.tenantA,
        (tx) => tx.$executeRaw`update tenancy.invitation set status = 'accepted'`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('audits each invitation, acceptance and revocation once', async () => {
    const result = await h.owner((client) =>
      client.query(
        `select action, count(*)::int as n from audit.audit_event
         where action like 'tenancy.invitation.%' group by action order by action`,
      ),
    );
    const byAction = Object.fromEntries(
      (result.rows as { action: string; n: number }[]).map((row) => [row.action, row.n]),
    );
    expect(byAction['tenancy.invitation.revoked']).toBe(1);
    expect(byAction['tenancy.invitation.accepted']).toBe(3);
    expect(byAction['tenancy.invitation.created']).toBeGreaterThanOrEqual(7);
  });

  it('no longer offers the old route that added a member by phone number', async () => {
    const response = await h
      .http()
      .post('/v1/workspace/members')
      .set(inWorkspace(adminA, h.seed.tenantA))
      .send({ phone: '+99900000050', role: 'cashier' });
    expect(response.status).toBe(404);
  });
});
