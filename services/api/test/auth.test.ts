import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  OperatorGuard,
  SessionGuard,
  StepUpGuard,
  WorkspaceGuard,
} from '../src/modules/identity/guards.js';
import { Permit } from '../src/modules/tenancy/permissions.js';
import { loadConfig } from '../src/platform/config.js';
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
  @Permit('ledger.read')
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

describe('configuration', () => {
  it('refuses to load in any mode other than sandbox, without echoing values', () => {
    const env = {
      AORA_MODE: 'live',
      DATABASE_URL_APP: 'postgresql://u:supersecret@h/db',
      DATABASE_URL_PLATFORM: 'x',
      SANDBOX_SIM_WEBHOOK_SECRET: 'y'.repeat(32),
      PIN_PEPPER: 'p'.repeat(32),
    };
    expect(() => loadConfig(env)).toThrow(/AORA_MODE/);
    expect(() => loadConfig(env)).not.toThrow(/supersecret/);
  });
});

describe('request authentication', () => {
  it('rejects missing, malformed, forged and expired tokens', async () => {
    expect((await h.http().get('/v1/me')).status).toBe(401);
    expect((await h.http().get('/v1/me').set('Authorization', 'Bearer nope')).status).toBe(401);
    expect((await h.http().get('/v1/me').set('Authorization', 'Basic abc')).status).toBe(401);
    const good = await h.signIn('adminA');
    expect((await h.http().get('/v1/me').set('Authorization', `Bearer ${good}x`)).status).toBe(401);
    const expired = h.sandboxAuth.issue(h.seed.clerkIds.adminA, { expiresInSeconds: -5 });
    expect((await h.http().get('/v1/me').set('Authorization', `Bearer ${expired}`)).status).toBe(
      401,
    );
  });

  it('resolves a valid token to the AORA account and its memberships, labelled sandbox', async () => {
    const me = await h
      .http()
      .get('/v1/me')
      .set('Authorization', `Bearer ${await h.signIn('adminA')}`);
    expect(me.status).toBe(200);
    expect(me.headers['aora-mode']).toBe('sandbox');
    expect(me.body).toEqual({
      account_id: h.seed.accounts.adminA,
      is_platform_operator: false,
      memberships: [{ workspace_id: h.seed.tenantA, role: 'admin' }],
      mode: 'sandbox',
    });
  });

  it('never stores a request token', async () => {
    const token = await h.signIn('financeA');
    await h.http().get('/v1/me').set('Authorization', `Bearer ${token}`);
    const found = await h.owner((client) =>
      client.query(
        `select (select count(*) from identity.session) as sessions,
                (select count(*) from identity.step_up where session_ref = $1) as tokens_as_refs`,
        [token],
      ),
    );
    expect(found.rows[0]).toEqual({ sessions: '0', tokens_as_refs: '0' });
  });

  it('returns a stable error envelope', async () => {
    const response = await h.http().get('/v1/me');
    expect(response.body).toEqual({
      error: {
        code: 'unauthenticated',
        message: expect.any(String),
        request_id: response.headers['aora-request-id'],
      },
      mode: 'sandbox',
    });
  });
});

describe('step-up', () => {
  it('blocks a sensitive action until the PIN is confirmed, and expires', async () => {
    const token = await h.signIn('adminA');
    const auth = { Authorization: `Bearer ${token}` };
    const before = await h.http().post('/probe/sensitive').set(auth);
    expect(before.status).toBe(403);
    expect(before.body.error.code).toBe('step_up_required');

    await h.stepUp(token);
    expect((await h.http().post('/probe/sensitive').set(auth)).status).toBe(201);

    await h.owner((client) =>
      client.query(`update identity.step_up set until = now() - interval '1 second'`),
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
