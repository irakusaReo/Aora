import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConsentService } from '../src/modules/consent/consent.service.js';
import { type Harness, startHarness } from './support/harness.js';

let h: Harness;
let token: string;

beforeAll(async () => {
  h = await startHarness();
  token = await h.signIn('adminA');
  const consent = h.app.get(ConsentService);
  await h.db.asPlatform(async (tx) => {
    await consent.publishTerms(tx, {
      key: 'platform_terms',
      version: '1',
      language: 'en',
      title: 'Sandbox terms v1',
      body: 'SANDBOX terms, version one.',
      effectiveFrom: new Date(Date.now() - 86_400_000),
    });
    await consent.publishTerms(tx, {
      key: 'platform_terms',
      version: '2',
      language: 'en',
      title: 'Sandbox terms v2',
      body: 'SANDBOX terms, version two.',
      effectiveFrom: new Date(Date.now() - 1000),
    });
  });
});
afterAll(() => h.close());

const post = (body: Record<string, unknown>, bearer = token) =>
  h.http().post('/v1/consents').set('Authorization', `Bearer ${bearer}`).send(body);

describe('consent records (brief §7.4)', () => {
  it('serves the terms version currently in effect', async () => {
    const response = await h.http().get('/v1/terms/platform_terms');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      key: 'platform_terms',
      version: '2',
      language: 'en',
      mode: 'sandbox',
    });
    expect((await h.http().get('/v1/terms/nothing')).status).toBe(404);
  });

  it('records the person, capacity, action, time and terms version', async () => {
    const response = await post({
      terms_key: 'platform_terms',
      terms_version: '2',
      action: 'accept_platform_terms',
      capacity: 'personal',
    });
    expect(response.status).toBe(201);
    const row = await h.owner((client) =>
      client.query(
        `select c.account_id, c.person_id is not null as has_person, c.capacity, c.action, c.tenant_id,
                t.key, t.version, c.created_at > now() - interval '1 minute' as recent, c.mode
         from consent.consent_record c join consent.terms_document t on t.id = c.terms_document_id
         where c.id = $1`,
        [response.body.id],
      ),
    );
    expect(row.rows[0]).toEqual({
      account_id: h.seed.accounts.adminA,
      has_person: true,
      capacity: 'personal',
      action: 'accept_platform_terms',
      tenant_id: null,
      key: 'platform_terms',
      version: '2',
      recent: true,
      mode: 'sandbox',
    });
  });

  it('records business capacity only for a workspace the person belongs to', async () => {
    const body = {
      terms_key: 'platform_terms',
      terms_version: '2',
      action: 'accept_platform_terms',
      capacity: 'business',
    };
    expect((await post({ ...body, workspace_id: h.seed.tenantA })).status).toBe(201);
    expect((await post({ ...body, workspace_id: h.seed.tenantB })).status).toBe(403);
    expect((await post(body)).status).toBe(400);
    expect(
      (await post({ ...body, capacity: 'personal', workspace_id: h.seed.tenantA })).status,
    ).toBe(400);
  });

  it('refuses a version that does not exist or is no longer in effect', async () => {
    const base = {
      terms_key: 'platform_terms',
      action: 'accept_platform_terms',
      capacity: 'personal',
    };
    expect((await post({ ...base, terms_version: '9' })).status).toBe(400);
    expect((await post({ ...base, terms_version: '1' })).status).toBe(400);
    expect(
      (
        await h
          .http()
          .post('/v1/consents')
          .send({ ...base, terms_version: '2' })
      ).status,
    ).toBe(401);
  });

  it('is append-only, and published terms cannot be edited', async () => {
    for (const sql of [
      `update consent.consent_record set action = 'x'`,
      `delete from consent.consent_record`,
      `update consent.terms_document set body = 'changed'`,
      `delete from consent.terms_document`,
    ]) {
      await expect(
        h.owner((client) => client.query(sql)),
        sql,
      ).rejects.toThrow(/append-only|immutable/);
    }
  });
});
