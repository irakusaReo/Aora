import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Webhook } from 'svix';
import { type Harness, startHarness } from './support/harness.js';
import { type Caller, createIntent, ledgerFor } from './support/payments.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h.close());

function clerkEvent(type: string, data: Record<string, unknown>, id = `msg_${randomUUID()}`) {
  const payload = JSON.stringify({ type, data, object: 'event' });
  const timestamp = new Date();
  const signature = new Webhook(h.config.clerk.webhookSigningSecret).sign(id, timestamp, payload);
  return h
    .http()
    .post('/v1/webhooks/clerk')
    .set('Content-Type', 'application/json')
    .set('svix-id', id)
    .set('svix-timestamp', String(Math.floor(timestamp.getTime() / 1000)))
    .set('svix-signature', signature)
    .send(payload);
}

const user = (
  id: string,
  email: string,
  updatedAt: number,
  extra: Record<string, unknown> = {},
) => ({
  id,
  first_name: 'Sandbox',
  last_name: 'Person',
  primary_email_address_id: 'idn_1',
  email_addresses: [{ id: 'idn_1', email_address: email }],
  primary_phone_number_id: 'idn_2',
  phone_numbers: [
    {
      id: 'idn_2',
      phone_number: `+9992${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
    },
  ],
  updated_at: updatedAt,
  public_metadata: { role: 'admin', tenant: 'anything' },
  ...extra,
});

const account = (clerkId: string) =>
  h.owner(async (client) => {
    const result = await client.query(
      `select id, email, phone_e164, display_name, status, phone_verified_at, pin_hash from identity.user_account where clerk_user_id = $1`,
      [clerkId],
    );
    return result.rows[0] as Record<string, unknown> | undefined;
  });

describe('just-in-time provisioning', () => {
  it('creates one person and account on the first request from an unknown user, even under concurrency', async () => {
    const subject = `user_${randomUUID()}`;
    h.sandboxAuth.setProfile(subject, {
      email: 'new.person@sandbox.aora.test',
      phoneE164: '+99911100009',
      displayName: 'New Person',
    });
    const token = h.sandboxAuth.issue(subject);
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        h.http().get('/v1/me').set('Authorization', `Bearer ${token}`),
      ),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(new Set(responses.map((response) => response.body.account_id)).size).toBe(1);
    const row = await account(subject);
    // The phone number is not taken from the provider's profile; the user gives it to AORA.
    expect(row).toMatchObject({
      email: 'new.person@sandbox.aora.test',
      phone_e164: null,
      status: 'active',
    });
    expect(responses[0]?.body.memberships).toEqual([]);
  });

  it('gives a new user no access to anything', async () => {
    const subject = `user_${randomUUID()}`;
    const token = h.sandboxAuth.issue(subject);
    const response = await h
      .http()
      .get('/v1/ledger/balances')
      .set('Authorization', `Bearer ${token}`)
      .set('Aora-Workspace-Id', h.seed.tenantA);
    expect(response.status).toBe(403);
  });
});

describe('Clerk webhooks', () => {
  it('rejects a missing or wrong signature and stores nothing', async () => {
    const payload = JSON.stringify({
      type: 'user.created',
      data: user('user_x', 'x@sandbox.aora.test', 1),
    });
    const unsigned = await h
      .http()
      .post('/v1/webhooks/clerk')
      .set('Content-Type', 'application/json')
      .send(payload);
    const forged = await h
      .http()
      .post('/v1/webhooks/clerk')
      .set('Content-Type', 'application/json')
      .set('svix-id', 'msg_1')
      .set('svix-timestamp', String(Math.floor(Date.now() / 1000)))
      .set('svix-signature', 'v1,' + Buffer.from('nope').toString('base64'))
      .send(payload);
    expect(unsigned.status).toBe(401);
    expect(forged.status).toBe(401);
    expect(await account('user_x')).toBeUndefined();
  });

  it('creates and updates the account, and never reads roles or tenants from Clerk metadata', async () => {
    const id = `user_${randomUUID()}`;
    expect(
      (await clerkEvent('user.created', user(id, 'first@sandbox.aora.test', 100))).status,
    ).toBe(200);
    expect(await account(id)).toMatchObject({
      email: 'first@sandbox.aora.test',
      display_name: 'Sandbox Person',
    });
    expect(
      (await clerkEvent('user.updated', user(id, 'second@sandbox.aora.test', 200))).status,
    ).toBe(200);
    expect((await account(id))?.['email']).toBe('second@sandbox.aora.test');

    const token = h.sandboxAuth.issue(id);
    const me = await h.http().get('/v1/me').set('Authorization', `Bearer ${token}`);
    expect(me.body).toMatchObject({ is_platform_operator: false, memberships: [] });
  });

  it('has one effect when the same delivery arrives twice', async () => {
    const id = `user_${randomUUID()}`;
    const delivery = `msg_${randomUUID()}`;
    await clerkEvent('user.created', user(id, 'once@sandbox.aora.test', 100), delivery);
    const again = await clerkEvent(
      'user.created',
      user(id, 'once@sandbox.aora.test', 100),
      delivery,
    );
    expect(again.status).toBe(200);
    const count = await h.owner((client) =>
      client.query(`select count(*) as n from identity.user_account where clerk_user_id = $1`, [
        id,
      ]),
    );
    expect(count.rows[0]?.n).toBe('1');
  });

  it('ignores an update that is older than what is stored', async () => {
    const id = `user_${randomUUID()}`;
    await clerkEvent('user.updated', user(id, 'newer@sandbox.aora.test', 500));
    await clerkEvent('user.updated', user(id, 'older@sandbox.aora.test', 400));
    expect((await account(id))?.['email']).toBe('newer@sandbox.aora.test');
  });

  it('does not let a webhook race create a second account for a user provisioned just in time', async () => {
    const id = `user_${randomUUID()}`;
    h.sandboxAuth.setProfile(id, {
      email: 'race@sandbox.aora.test',
      phoneE164: null,
      displayName: 'Race',
    });
    await Promise.all([
      h
        .http()
        .get('/v1/me')
        .set('Authorization', `Bearer ${h.sandboxAuth.issue(id)}`),
      clerkEvent('user.created', user(id, 'race@sandbox.aora.test', 100)),
    ]);
    const count = await h.owner((client) =>
      client.query(`select count(*) as n from identity.user_account where clerk_user_id = $1`, [
        id,
      ]),
    );
    expect(count.rows[0]?.n).toBe('1');
  });
});

describe('phone numbers (held by AORA, not by the identity provider)', () => {
  const setPhone = (token: string, phone: string) =>
    h.http().put('/v1/me/phone').set('Authorization', `Bearer ${token}`).send({ phone });
  const newUser = () => {
    const id = `user_${randomUUID()}`;
    h.sandboxAuth.setProfile(id, {
      email: `${id}@sandbox.aora.test`,
      phoneE164: null,
      displayName: 'P',
    });
    return id;
  };

  it('are not taken from the identity provider, and a provider update never erases one', async () => {
    const id = newUser();
    const token = h.sandboxAuth.issue(id);
    await h.http().get('/v1/me').set('Authorization', `Bearer ${token}`);
    expect((await account(id))?.['phone_e164']).toBeNull();
    expect((await setPhone(token, '+99944400001')).status).toBe(200);
    await clerkEvent('user.updated', user(id, `${id}@sandbox.aora.test`, 900));
    expect(await account(id)).toMatchObject({
      phone_e164: '+99944400001',
      phone_verified_at: null,
    });
  });

  it('must be in international format', async () => {
    const token = h.sandboxAuth.issue(newUser());
    for (const bad of ['0712345678', '+0712345678', '254712345678', '+2547', 'abc', '']) {
      expect((await setPhone(token, bad)).status, bad).toBe(400);
    }
  });

  it('belong to one account: a second claim is refused and audited, and says nothing about who holds it', async () => {
    const first = h.sandboxAuth.issue(newUser());
    const secondId = newUser();
    const second = h.sandboxAuth.issue(secondId);
    expect((await setPhone(first, '+99944400002')).status).toBe(200);
    const refused = await setPhone(second, '+99944400002');
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).not.toMatch(/account|user_/i);
    expect((await account(secondId))?.['phone_e164']).toBeNull();
    const audits = await h.owner((client) =>
      client.query(
        `select count(*) as n from audit.audit_event where action = 'identity.phone.conflict'`,
      ),
    );
    expect(Number(audits.rows[0]?.n)).toBeGreaterThanOrEqual(1);
  });

  it('can be set freely the first time, but changing one needs a PIN step-up and clears verification', async () => {
    const id = newUser();
    const token = h.sandboxAuth.issue(id, { sessionId: `sess_${randomUUID()}` });
    expect((await setPhone(token, '+99944400003')).status).toBe(200);
    await h.owner((client) =>
      client.query(
        `update identity.user_account set phone_verified_at = now() where clerk_user_id = $1`,
        [id],
      ),
    );
    const blocked = await setPhone(token, '+99944400004');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('step_up_required');
    await h.stepUp(token);
    expect((await setPhone(token, '+99944400004')).status).toBe(200);
    expect(await account(id)).toMatchObject({
      phone_e164: '+99944400004',
      phone_verified_at: null,
    });
  });

  it('are shown back only masked', async () => {
    const token = h.sandboxAuth.issue(newUser());
    const response = await setPhone(token, '+99944400005');
    expect(response.body).toMatchObject({
      phone_hint: '•••005',
      phone_verified: false,
      mode: 'sandbox',
    });
    expect(JSON.stringify(response.body)).not.toContain('+99944400005');
  });
});

describe('user deletion', () => {
  it('closes and anonymises the account, removes access, and keeps every financial record', async () => {
    const admin: Caller = { token: await h.signIn('cashierA'), workspace: h.seed.tenantA };
    await h.stepUp(admin.token);
    const created = await createIntent(h, admin, { amount_minor: '2500', currency: 'KES' });
    await h.settle();
    const before = await h.owner((client) =>
      client.query(`select (select count(*) from ledger.posting) as postings,
                           (select count(*) from audit.audit_event) as audits,
                           (select count(*) from payments.payment_intent) as intents`),
    );

    const response = await clerkEvent('user.deleted', {
      id: h.seed.clerkIds.cashierA,
      deleted: true,
    });
    expect(response.status).toBe(200);

    const row = await h.owner(async (client) => {
      const result = await client.query(
        `select status, clerk_user_id, email, phone_e164, display_name, pin_hash, person_id is not null as has_person
         from identity.user_account where id = $1`,
        [h.seed.accounts.cashierA],
      );
      return result.rows[0];
    });
    expect(row).toEqual({
      status: 'closed',
      clerk_user_id: null,
      email: null,
      phone_e164: null,
      display_name: null,
      pin_hash: null,
      has_person: true,
    });

    const after = await h.owner((client) =>
      client.query(`select (select count(*) from ledger.posting) as postings,
                           (select count(*) from audit.audit_event) - 1 as audits,
                           (select count(*) from payments.payment_intent) as intents`),
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(await ledgerFor(h, created.body.id)).toEqual({ entries: 1, credited: '2500' });
    const intent = await h.owner((client) =>
      client.query(`select created_by from payments.payment_intent where id = $1`, [
        created.body.id,
      ]),
    );
    expect(intent.rows[0]?.created_by).toBe(h.seed.accounts.cashierA);

    const memberships = await h.owner((client) =>
      client.query(`select status from tenancy.membership where account_id = $1`, [
        h.seed.accounts.cashierA,
      ]),
    );
    expect(memberships.rows).toEqual([{ status: 'removed' }]);
    const stepUps = await h.owner((client) =>
      client.query(`select count(*) as n from identity.step_up where account_id = $1`, [
        h.seed.accounts.cashierA,
      ]),
    );
    expect(stepUps.rows[0]?.n).toBe('0');
  });

  it('is safe to receive for a user AORA never saw, and twice', async () => {
    const ghost = { id: `user_${randomUUID()}`, deleted: true };
    expect((await clerkEvent('user.deleted', ghost)).status).toBe(200);
    expect((await clerkEvent('user.deleted', ghost)).status).toBe(200);
  });
});

describe('Clerk test-mode identities on a deployed environment', () => {
  it('are refused when deployed and accepted on a developer machine', async () => {
    const subject = `user_${randomUUID()}`;
    h.sandboxAuth.setProfile(subject, {
      email: 'jane+clerk_test@example.com',
      phoneE164: null,
      displayName: 'Jane',
    });
    const token = h.sandboxAuth.issue(subject);
    expect((await h.http().get('/v1/me').set('Authorization', `Bearer ${token}`)).status).toBe(200);

    Object.assign(h.config, { deployed: true });
    try {
      const refused = await h.http().get('/v1/me').set('Authorization', `Bearer ${token}`);
      expect(refused.status).toBe(401);
      const fresh = `user_${randomUUID()}`;
      h.sandboxAuth.setProfile(fresh, {
        email: 'new+clerk_test@example.com',
        phoneE164: null,
        displayName: 'N',
      });
      expect(
        (
          await h
            .http()
            .get('/v1/me')
            .set('Authorization', `Bearer ${h.sandboxAuth.issue(fresh)}`)
        ).status,
      ).toBe(401);
      expect(await account(fresh)).toBeUndefined();
    } finally {
      Object.assign(h.config, { deployed: false });
    }
  });
});
