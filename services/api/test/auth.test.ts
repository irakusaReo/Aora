import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SandboxAuthProvider } from '../src/modules/identity/auth-provider.js';
import {
  AllowRoles,
  OperatorGuard,
  SessionGuard,
  StepUpGuard,
  WorkspaceGuard,
} from '../src/modules/identity/guards.js';
import { loadConfig } from '../src/platform/config.js';
import { SEED_PHONES } from '../src/seed-data.js';
import { type Harness, startHarness } from './support/harness.js';

// Probe routes that exist only in this test, to exercise the guards in isolation.
@Controller('probe')
class ProbeController {
  @Post('sensitive')
  @UseGuards(SessionGuard, StepUpGuard)
  sensitive(): { ok: true } {
    return { ok: true };
  }

  @Get('finance-only')
  @UseGuards(SessionGuard, WorkspaceGuard)
  @AllowRoles('admin', 'finance')
  financeOnly(): { ok: true } {
    return { ok: true };
  }

  @Get('no-roles-declared')
  @UseGuards(SessionGuard, WorkspaceGuard)
  noRoles(): { ok: true } {
    return { ok: true };
  }

  @Get('operator')
  @UseGuards(SessionGuard, OperatorGuard)
  operator(): { ok: true } {
    return { ok: true };
  }
}

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ controllers: [ProbeController] });
});
afterAll(() => h.close());

const CODE = SandboxAuthProvider.FIXED_CODE;

async function challenge(phone: string): Promise<string> {
  const response = await h.http().post('/v1/auth/challenges').send({ phone });
  expect(response.status).toBe(201);
  return response.body.challenge_id as string;
}

describe('configuration', () => {
  it('refuses to load in any mode other than sandbox, without echoing values', () => {
    const env = {
      AORA_MODE: 'live',
      DATABASE_URL_APP: 'postgresql://u:supersecret@h/db',
      DATABASE_URL_PLATFORM: 'x',
      SANDBOX_SIM_WEBHOOK_SECRET: 'y'.repeat(32),
    };
    expect(() => loadConfig(env)).toThrow(/AORA_MODE/);
    expect(() => loadConfig(env)).not.toThrow(/supersecret/);
  });
});

describe('sign-in', () => {
  it('creates a session and labels the response sandbox', async () => {
    const id = await challenge(SEED_PHONES.adminA);
    const response = await h
      .http()
      .post('/v1/auth/sessions')
      .send({ challenge_id: id, code: CODE });
    expect(response.status).toBe(201);
    expect(response.body.mode).toBe('sandbox');
    expect(response.headers['aora-mode']).toBe('sandbox');
    expect(response.body.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    const me = await h.http().get('/v1/me').set('Authorization', `Bearer ${response.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.memberships).toEqual([{ workspace_id: h.seed.tenantA, role: 'admin' }]);
  });

  it('stores only a hash of the session token and of the code', async () => {
    const token = await h.signIn('financeA');
    const found = await h.owner((client) =>
      client.query(
        `select (select count(*) from identity.session where token_hash = $1) as raw_tokens,
                (select count(*) from identity.auth_challenge where code_hash like '%' || $2 || '%') as raw_codes`,
        [token, CODE],
      ),
    );
    expect(found.rows[0]).toEqual({ raw_tokens: '0', raw_codes: '0' });
  });

  it('rejects a wrong code, and a code that was already used', async () => {
    const id = await challenge(SEED_PHONES.adminA);
    const wrong = await h
      .http()
      .post('/v1/auth/sessions')
      .send({ challenge_id: id, code: '111111' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('unauthenticated');

    const first = await h.http().post('/v1/auth/sessions').send({ challenge_id: id, code: CODE });
    expect(first.status).toBe(201);
    const second = await h.http().post('/v1/auth/sessions').send({ challenge_id: id, code: CODE });
    expect(second.status).toBe(401);
  });

  it('locks a challenge after too many wrong codes, even for the right code', async () => {
    const id = await challenge(SEED_PHONES.adminA);
    for (let i = 0; i < h.config.auth.maxChallengeAttempts; i += 1) {
      await h.http().post('/v1/auth/sessions').send({ challenge_id: id, code: '999999' });
    }
    const locked = await h.http().post('/v1/auth/sessions').send({ challenge_id: id, code: CODE });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('too_many_attempts');
  });

  it('rejects an expired challenge', async () => {
    const id = await challenge(SEED_PHONES.adminA);
    await h.owner((client) =>
      client.query(
        `update identity.auth_challenge set expires_at = now() - interval '1 second' where id = $1`,
        [id],
      ),
    );
    const response = await h
      .http()
      .post('/v1/auth/sessions')
      .send({ challenge_id: id, code: CODE });
    expect(response.status).toBe(401);
  });

  it('does not reveal whether a phone number is registered', async () => {
    const known = await h.http().post('/v1/auth/challenges').send({ phone: SEED_PHONES.adminA });
    const unknown = await h.http().post('/v1/auth/challenges').send({ phone: '+99912345678' });
    expect(unknown.status).toBe(known.status);
    expect(Object.keys(unknown.body).sort()).toEqual(Object.keys(known.body).sort());
    const attempt = await h
      .http()
      .post('/v1/auth/sessions')
      .send({ challenge_id: unknown.body.challenge_id, code: CODE });
    expect(attempt.status).toBe(401);
  });

  it('rejects malformed input with a stable error envelope', async () => {
    const response = await h.http().post('/v1/auth/challenges').send({ phone: '0712345678' });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: 'invalid_request',
        message: expect.any(String),
        request_id: response.headers['aora-request-id'],
      },
      mode: 'sandbox',
    });
  });
});

describe('sessions', () => {
  it('rejects missing, unknown, expired and revoked tokens', async () => {
    expect((await h.http().get('/v1/me')).status).toBe(401);
    expect((await h.http().get('/v1/me').set('Authorization', 'Bearer nope')).status).toBe(401);

    const expired = await h.signIn('adminA');
    const revoked = await h.signIn('adminA');
    await h.owner(async (client) => {
      const sessions = await client.query<{ id: string }>(
        `select id from identity.session order by created_at desc limit 2`,
      );
      await client.query(`update identity.session set revoked_at = now() where id = $1`, [
        sessions.rows[0]?.id,
      ]);
      await client.query(
        `update identity.session set expires_at = now() - interval '1 second' where id = $1`,
        [sessions.rows[1]?.id],
      );
    });
    expect((await h.http().get('/v1/me').set('Authorization', `Bearer ${expired}`)).status).toBe(
      401,
    );
    expect((await h.http().get('/v1/me').set('Authorization', `Bearer ${revoked}`)).status).toBe(
      401,
    );
  });
});

describe('step-up', () => {
  it('blocks a sensitive action until a second factor is confirmed', async () => {
    const auth = { Authorization: `Bearer ${await h.signIn('adminA')}` };
    const before = await h.http().post('/probe/sensitive').set(auth);
    expect(before.status).toBe(403);
    expect(before.body.error.code).toBe('step_up_required');

    const started = await h.http().post('/v1/auth/step-up/challenges').set(auth);
    const wrong = await h
      .http()
      .post('/v1/auth/step-up')
      .set(auth)
      .send({ challenge_id: started.body.challenge_id, code: '123123' });
    expect(wrong.status).toBe(401);
    expect((await h.http().post('/probe/sensitive').set(auth)).status).toBe(403);

    const done = await h
      .http()
      .post('/v1/auth/step-up')
      .set(auth)
      .send({ challenge_id: started.body.challenge_id, code: CODE });
    expect(done.status).toBe(200);
    expect((await h.http().post('/probe/sensitive').set(auth)).status).toBe(201);
  });

  it("does not accept another account's step-up challenge, or a sign-in challenge", async () => {
    const authA = { Authorization: `Bearer ${await h.signIn('financeA')}` };
    const authB = { Authorization: `Bearer ${await h.signIn('adminB')}` };
    const forB = await h.http().post('/v1/auth/step-up/challenges').set(authB);
    const stolen = await h
      .http()
      .post('/v1/auth/step-up')
      .set(authA)
      .send({ challenge_id: forB.body.challenge_id, code: CODE });
    expect(stolen.status).toBe(401);

    const signInChallenge = await challenge(SEED_PHONES.financeA);
    const misuse = await h
      .http()
      .post('/v1/auth/step-up')
      .set(authA)
      .send({ challenge_id: signInChallenge, code: CODE });
    expect(misuse.status).toBe(401);
  });

  it('expires', async () => {
    const auth = { Authorization: `Bearer ${await h.signIn('cashierA')}` };
    const started = await h.http().post('/v1/auth/step-up/challenges').set(auth);
    await h
      .http()
      .post('/v1/auth/step-up')
      .set(auth)
      .send({ challenge_id: started.body.challenge_id, code: CODE });
    await h.owner((client) =>
      client.query(`update identity.session set step_up_until = now() - interval '1 second'`),
    );
    expect((await h.http().post('/probe/sensitive').set(auth)).status).toBe(403);
  });
});

describe('roles and workspaces', () => {
  const get = (path: string, token: string, workspace?: string) => {
    const call = h.http().get(path).set('Authorization', `Bearer ${token}`);
    return workspace ? call.set('Aora-Workspace-Id', workspace) : call;
  };

  it('allows only the listed roles, in the caller’s own workspace', async () => {
    const admin = await h.signIn('adminA');
    const finance = await h.signIn('financeA');
    const cashier = await h.signIn('cashierA');
    const otherAdmin = await h.signIn('adminB');

    expect((await get('/probe/finance-only', admin, h.seed.tenantA)).status).toBe(200);
    expect((await get('/probe/finance-only', finance, h.seed.tenantA)).status).toBe(200);
    expect((await get('/probe/finance-only', cashier, h.seed.tenantA)).status).toBe(403);
    expect((await get('/probe/finance-only', otherAdmin, h.seed.tenantA)).status).toBe(403);
    expect((await get('/probe/finance-only', admin, h.seed.tenantB)).status).toBe(403);
    expect((await get('/probe/finance-only', admin)).status).toBe(403);
    expect((await get('/probe/finance-only', admin, 'not-a-uuid')).status).toBe(403);
  });

  it('denies everyone when a route declares no roles', async () => {
    const admin = await h.signIn('adminA');
    expect((await get('/probe/no-roles-declared', admin, h.seed.tenantA)).status).toBe(403);
  });

  it('keeps operator routes for operators', async () => {
    expect((await get('/probe/operator', await h.signIn('adminA'))).status).toBe(403);
    expect((await get('/probe/operator', await h.signIn('operator'))).status).toBe(200);
  });
});
