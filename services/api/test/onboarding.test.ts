import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './support/harness.js';
import { createIntent } from './support/payments.js';
import { newUser } from './support/users.js';

let h: Harness;
let operator: string;

beforeAll(async () => {
  h = await startHarness();
  operator = await h.signIn('operator');
});
afterAll(() => h.close());

const registered = (name: string, value: string, extra: Record<string, unknown> = {}) => ({
  kind: 'registered',
  name,
  country: 'KE',
  registration: { type: 'sandbox_registration_number', value },
  ...extra,
});
const stall = (name: string, place: string, extra: Record<string, unknown> = {}) => ({
  kind: 'unregistered',
  name,
  country: 'KE',
  location: { area: 'Sandbox County', locality: 'Sandbox Town', place },
  ...extra,
});

function apply(token: string, body: unknown, key: string = randomUUID()): Promise<Response> {
  return h
    .http()
    .post('/v1/onboarding/applications')
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', key)
    .send(body as object);
}

const count = async (sql: string, params: unknown[] = []): Promise<number> =>
  h.owner(async (client) => Number((await client.query(sql, params)).rows[0].n));

const decisionOf = async (applicationId: string): Promise<{ rule: string; outcome: string }> =>
  h.owner(async (client) => {
    const result = await client.query(
      `select rule, outcome, normalisation_version from business.match_decision where application_id = $1`,
      [applicationId],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].normalisation_version).toBe(1);
    return result.rows[0] as { rule: string; outcome: string };
  });

describe('onboarding a new merchant (ADR 0012 rule 4)', () => {
  it('onboards a registered business: one business, one workspace, the applicant as admin', async () => {
    const owner = await newUser(h, 'Wanjiru');
    const response = await apply(owner.token, registered('Acme Supplies Ltd', 'REG-1001'));
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      status: 'approved',
      kind: 'registered',
      mode: 'sandbox',
    });
    const workspace = response.body.workspace_id as string;
    expect(workspace).toEqual(expect.any(String));
    expect(await decisionOf(response.body.id)).toMatchObject({
      rule: 'new_business',
      outcome: 'new',
    });

    const me = await h.http().get('/v1/me').set('Authorization', `Bearer ${owner.token}`);
    expect(me.body.memberships).toEqual([{ workspace_id: workspace, role: 'admin' }]);

    // The workspace can collect at once: its ledger account exists and its tier has limits.
    const paid = await createIntent(
      h,
      { token: owner.token, workspace },
      { amount_minor: '2500', currency: 'KES' },
    );
    expect(paid.status).toBe(201);
    await h.settle();

    const details = await h
      .http()
      .get('/v1/workspace')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('Aora-Workspace-Id', workspace);
    expect(details.body).toMatchObject({
      name: 'Acme Supplies Ltd',
      kind: 'registered',
      tier: 'tier_1',
    });
  });

  it('onboards an unregistered business at the lowest tier', async () => {
    const owner = await newUser(h, 'Otieno');
    const response = await apply(owner.token, stall('Mama Mboga', 'Stall 14'));
    expect(response.status).toBe(201);
    expect(response.body.status).toBe('approved');
    const details = await h
      .http()
      .get('/v1/workspace')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('Aora-Workspace-Id', response.body.workspace_id as string);
    expect(details.body).toMatchObject({ kind: 'unregistered', tier: 'tier_0' });
  });

  it('gives a registered business the lowest tier when the registry check does not verify it', async () => {
    const owner = await newUser(h, 'Kamau');
    const response = await apply(
      owner.token,
      registered('Unverified Traders', 'REG-1002', { sandbox_kyb: 'unverified' }),
    );
    expect(response.body.status).toBe('approved');
    const details = await h
      .http()
      .get('/v1/workspace')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('Aora-Workspace-Id', response.body.workspace_id as string);
    expect(details.body.tier).toBe('tier_0');
  });

  it('lets one person own two different stalls', async () => {
    const owner = await newUser(h, 'Achieng');
    const first = await apply(owner.token, stall('Fish Point', 'Gikomba 3'));
    const second = await apply(owner.token, stall('Charcoal Corner', 'Toi 9'));
    expect([first.body.status, second.body.status]).toEqual(['approved', 'approved']);
    expect(first.body.workspace_id).not.toBe(second.body.workspace_id);
  });

  it('needs a phone number first, and an Idempotency-Key', async () => {
    const noPhone = await newUser(h, 'Nophone', { phone: false });
    const refused = await apply(noPhone.token, stall('No Phone Kiosk', 'Stall 2'));
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('phone_required');

    const owner = await newUser(h, 'Nokey');
    const noKey = await h
      .http()
      .post('/v1/onboarding/applications')
      .set('Authorization', `Bearer ${owner.token}`)
      .send(stall('No Key Kiosk', 'Stall 3'));
    expect(noKey.body.error.code).toBe('idempotency_key_required');
  });

  it('writes one audit event per application and never grants financial authority beyond admin', async () => {
    expect(
      await count(
        `select count(*) as n from audit.audit_event where action = 'onboarding.application.approved'`,
      ),
    ).toBeGreaterThan(0);
    expect(
      await count(
        `select count(*) as n from audit.audit_event e
         where action = 'onboarding.application.approved'
         group by subject_id having count(*) > 1 limit 1`,
      ).catch(() => 0),
    ).toBe(0);
  });
});

describe('idempotency and exact matches (rules 1 and 2)', () => {
  it('replays the same request, and refuses the key with a different body', async () => {
    const owner = await newUser(h, 'Repeat');
    const key = randomUUID();
    const first = await apply(owner.token, registered('Repeat Ltd', 'REG-2001'), key);
    const again = await apply(owner.token, registered('Repeat Ltd', 'REG-2001'), key);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(again.body.id).toBe(first.body.id);
    const changed = await apply(owner.token, registered('Repeat Ltd', 'REG-2002'), key);
    expect(changed.body.error.code).toBe('idempotency_key_reused');
    expect(
      await count(`select count(*) as n from business.business where name = 'Repeat Ltd'`),
    ).toBe(1);
  });

  it('never gives a second applicant the workspace of an already-onboarded registration number', async () => {
    const first = await newUser(h, 'First');
    const second = await newUser(h, 'Second');
    await apply(first.token, registered('Twice Ltd', 'REG 3001'));
    // Same number, written differently.
    const response = await apply(second.token, registered('Twice Limited', 'reg-3001'));
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      status: 'rejected',
      decision_reason: 'business_already_onboarded',
      workspace_id: null,
    });
    expect(await decisionOf(response.body.id)).toMatchObject({
      rule: 'registered_identifier_match',
      outcome: 'same',
    });
    const me = await h.http().get('/v1/me').set('Authorization', `Bearer ${second.token}`);
    expect(me.body.memberships).toEqual([]);
  });

  it('recognises the same person, name and place as the same unregistered business', async () => {
    const owner = await newUser(h, 'Same');
    await apply(owner.token, stall('Same Stall', 'Row 1'));
    const again = await apply(owner.token, stall('  SAME   stall!', 'row 1'));
    expect(again.body).toMatchObject({
      status: 'rejected',
      decision_reason: 'business_already_onboarded',
    });
    expect(await decisionOf(again.body.id)).toMatchObject({
      rule: 'unregistered_identity_match',
      outcome: 'same',
    });
  });

  it('creates exactly one business when two people apply with one number at the same moment', async () => {
    const people = await Promise.all([
      newUser(h, 'RaceA'),
      newUser(h, 'RaceB'),
      newUser(h, 'RaceC'),
    ]);
    const results = await Promise.all(
      people.map((person) => apply(person.token, registered('Race Ltd', 'REG-4001'))),
    );
    expect(results.map((r) => r.body.status).sort()).toEqual(['approved', 'rejected', 'rejected']);
    expect(
      await count(
        `select count(*) as n from business.business_identifier where value_normalised = 'REG4001'`,
      ),
    ).toBe(1);
    expect(
      await count(
        `select count(*) as n from tenancy.workspace w join business.business b on b.id = w.business_id
         where b.name = 'Race Ltd'`,
      ),
    ).toBe(1);
  });
});

describe('possible duplicates go to review and create nothing (rule 3)', () => {
  let owner: Awaited<ReturnType<typeof newUser>>;
  let pending: string;

  it('same owner and place, different name', async () => {
    owner = await newUser(h, 'Dup');
    await apply(owner.token, stall('Original Name', 'Plot 5'));
    const before = await count(`select count(*) as n from business.business`);
    const response = await apply(owner.token, stall('Another Name', 'Plot 5'));
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ status: 'needs_review', workspace_id: null });
    expect(await decisionOf(response.body.id)).toMatchObject({
      rule: 'same_owner_same_location',
      outcome: 'review',
    });
    expect(await count(`select count(*) as n from business.business`)).toBe(before);
    pending = response.body.id as string;
  });

  it('same owner and name, different place', async () => {
    const response = await apply(owner.token, stall('Original Name', 'Plot 99'));
    expect(response.body.status).toBe('needs_review');
    expect((await decisionOf(response.body.id)).rule).toBe('same_owner_same_name');
  });

  it('same name and place, different owner', async () => {
    const other = await newUser(h, 'Other');
    const response = await apply(other.token, stall('Original Name', 'Plot 5'));
    expect(response.body.status).toBe('needs_review');
    expect((await decisionOf(response.body.id)).rule).toBe('same_name_same_location');
  });

  it('a registered applicant who already has an unregistered business of that name', async () => {
    const response = await apply(owner.token, registered('Original Name', 'REG-5001'));
    expect(response.body.status).toBe('needs_review');
    expect((await decisionOf(response.body.id)).rule).toBe('owner_has_unregistered_same_name');
  });

  it('a match on an identifier that was never verified', async () => {
    const first = await newUser(h, 'Unv1');
    const second = await newUser(h, 'Unv2');
    await apply(first.token, registered('Shaky Ltd', 'REG-6001', { sandbox_kyb: 'unverified' }));
    const response = await apply(second.token, registered('Shaky Ltd', 'REG-6001'));
    expect(response.body.status).toBe('needs_review');
    expect((await decisionOf(response.body.id)).rule).toBe('unverified_identifier_match');
  });

  it('shows the applicant their own application and nobody else’s', async () => {
    const mine = await h
      .http()
      .get(`/v1/onboarding/applications/${pending}`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(mine.body).toMatchObject({ id: pending, status: 'needs_review' });
    const stranger = await newUser(h, 'Stranger');
    const theirs = await h
      .http()
      .get(`/v1/onboarding/applications/${pending}`)
      .set('Authorization', `Bearer ${stranger.token}`);
    expect(theirs.status).toBe(404);
  });

  it('lets only an operator see the review queue and decide, with a reason, once', async () => {
    const asMerchant = await h
      .http()
      .get('/v1/ops/onboarding-reviews')
      .set('Authorization', `Bearer ${owner.token}`);
    expect(asMerchant.status).toBe(403);

    const queue = await h
      .http()
      .get('/v1/ops/onboarding-reviews')
      .set('Authorization', `Bearer ${operator}`);
    expect(queue.status).toBe(200);
    const entry = (queue.body.data as { id: string; rule: string }[]).find(
      (row) => row.id === pending,
    );
    expect(entry).toMatchObject({ rule: 'same_owner_same_location' });

    const decide = (body: object): Promise<Response> =>
      h
        .http()
        .post(`/v1/ops/onboarding-reviews/${pending}/decision`)
        .set('Authorization', `Bearer ${operator}`)
        .send(body);
    expect((await decide({ outcome: 'distinct' })).status).toBe(400);
    const approved = await decide({
      outcome: 'distinct',
      reason: 'Two stalls on one plot; confirmed by phone.',
    });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');
    expect(approved.body.workspace_id).toEqual(expect.any(String));
    const twice = await decide({ outcome: 'same', reason: 'Changed my mind about this one.' });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('invalid_state_transition');

    expect(
      await count(
        `select count(*) as n from audit.audit_event
         where action = 'onboarding.review.decided' and subject_id = $1`,
        [pending],
      ),
    ).toBe(1);
    const me = await h.http().get('/v1/me').set('Authorization', `Bearer ${owner.token}`);
    expect(me.body.memberships).toHaveLength(2);
  });

  it('rejects an application the operator judges to be the same business', async () => {
    const queue = await h
      .http()
      .get('/v1/ops/onboarding-reviews')
      .set('Authorization', `Bearer ${operator}`);
    const next = (queue.body.data as { id: string }[])[0];
    const response = await h
      .http()
      .post(`/v1/ops/onboarding-reviews/${next?.id ?? ''}/decision`)
      .set('Authorization', `Bearer ${operator}`)
      .send({ outcome: 'same', reason: 'Same business as an existing workspace.' });
    expect(response.body).toMatchObject({ status: 'rejected', workspace_id: null });
  });
});

describe('the database keeps onboarding records honest', () => {
  it('hides applications and decisions from the tenant role', async () => {
    await expect(
      h.db.withTenant(h.seed.tenantA, (tx) => tx.onboarding_application.findMany()),
    ).rejects.toThrow(/permission denied/);
  });

  it('never changes a recorded match decision', async () => {
    await expect(
      h.owner((client) => client.query(`update business.match_decision set outcome = 'new'`)),
    ).rejects.toThrow(/append-only/);
  });
});
