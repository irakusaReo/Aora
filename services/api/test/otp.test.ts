import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SandboxAuthProvider } from '../src/modules/identity/auth-provider.js';
import { SEED_PHONES } from '../src/seed-data.js';
import { type Harness, startHarness } from './support/harness.js';

let h: Harness;
const TOKEN = 'i'.repeat(40);

beforeAll(async () => {
  h = await startHarness({
    authProvider: 'otp',
    config: (config) => ({ ...config, smsInboxToken: TOKEN }),
  });
});
afterAll(() => h.close());

async function challenge(phone: string): Promise<string> {
  const response = await h.http().post('/v1/auth/challenges').send({ phone });
  expect(response.status).toBe(201);
  return response.body.challenge_id as string;
}

describe('one-time-code sign-in', () => {
  it('sends a random six-digit code and signs in with it, once', async () => {
    const id = await challenge(SEED_PHONES.adminA);
    const code = await h.lastSmsCode(SEED_PHONES.adminA);
    expect(code).toMatch(/^\d{6}$/);
    const first = await h.http().post('/v1/auth/sessions').send({ challenge_id: id, code });
    expect(first.status).toBe(201);
    const again = await h.http().post('/v1/auth/sessions').send({ challenge_id: id, code });
    expect(again.status).toBe(401);
  });

  it('never accepts the fixed development code', async () => {
    for (let i = 0; i < 3; i += 1) {
      const id = await challenge(SEED_PHONES.financeA);
      if ((await h.lastSmsCode(SEED_PHONES.financeA)) === SandboxAuthProvider.FIXED_CODE) continue;
      const response = await h
        .http()
        .post('/v1/auth/sessions')
        .send({ challenge_id: id, code: SandboxAuthProvider.FIXED_CODE });
      expect(response.status).toBe(401);
    }
  });

  it('issues a different code for each challenge and binds the code to its challenge', async () => {
    const codes = new Set<string>();
    let firstId = '';
    for (let i = 0; i < 6; i += 1) {
      const id = await challenge(SEED_PHONES.cashierA);
      if (i === 0) firstId = id;
      codes.add((await h.lastSmsCode(SEED_PHONES.cashierA)) ?? '');
    }
    expect(codes.size).toBeGreaterThan(1);
    const latest = (await h.lastSmsCode(SEED_PHONES.cashierA)) ?? '';
    const mismatched = await h
      .http()
      .post('/v1/auth/sessions')
      .send({ challenge_id: firstId, code: latest });
    // Only passes if two random codes happened to be equal.
    if (mismatched.status === 201) expect(codes.size).toBeLessThan(6);
  });

  it('sends nothing to a number with no account', async () => {
    await challenge('+99955500000');
    expect(await h.lastSmsCode('+99955500000')).toBeNull();
  });

  it('stores the code only as a salted digest', async () => {
    await challenge(SEED_PHONES.adminB);
    const code = (await h.lastSmsCode(SEED_PHONES.adminB)) ?? 'x';
    const found = await h.owner((client) =>
      client.query(
        `select count(*) as n from identity.auth_challenge where code_hash like '%' || $1 || '%'`,
        [code],
      ),
    );
    expect(found.rows[0]?.n).toBe('0');
  });
});

describe('simulated SMS inbox', () => {
  const inbox = (token?: string) => {
    const call = h.http().get('/v1/internal/sandbox/sms').query({ phone: SEED_PHONES.adminA });
    return token ? call.set('Authorization', `Bearer ${token}`) : call;
  };

  it('needs its secret', async () => {
    await challenge(SEED_PHONES.adminA);
    expect((await inbox()).status).toBe(401);
    expect((await inbox('w'.repeat(40))).status).toBe(401);
    const ok = await inbox(TOKEN);
    expect(ok.status).toBe(200);
    expect(ok.body.data[0].body).toMatch(/SANDBOX/);
  });

  it('does not exist when no inbox secret is configured', async () => {
    const other = await startHarness({ authProvider: 'otp', shareDatabaseOf: h });
    const response = await other
      .http()
      .get('/v1/internal/sandbox/sms')
      .query({ phone: SEED_PHONES.adminA })
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(response.status).toBe(404);
    await other.close();
  });
});
