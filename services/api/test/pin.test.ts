import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './support/harness.js';

// PIN state machine (ADR 0019):
//   unset -> set            needs a FRESH sign-in factor on the session (Clerk's fva claim)
//   set + correct PIN       -> that session is stepped-up; attempts reset
//   set + wrong PIN         -> attempts + 1 -> locked at the limit
//   locked                  -> refuses even the correct PIN until it expires or the PIN is reset

let h: Harness;
const PIN = '482915';

beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h.close());

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const setPin = (token: string, pin: string) =>
  h.http().put('/v1/auth/pin').set(auth(token)).send({ pin });
const stepUp = (token: string, pin: string) =>
  h.http().post('/v1/auth/step-up').set(auth(token)).send({ pin });
const addMember = (token: string, phone: string) =>
  h
    .http()
    .post('/v1/workspace/members')
    .set(auth(token))
    .set('Aora-Workspace-Id', h.seed.tenantA)
    .send({ phone, role: 'cashier' });

describe('PIN', () => {
  it('cannot be used for step-up before it is set', async () => {
    const response = await stepUp(await h.signIn('adminB'), PIN);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('pin_not_set');
  });

  it('can be set only on a session whose sign-in factor was verified recently', async () => {
    const stale = await h.signIn('adminA', { firstFactorAgeMinutes: 45 });
    const refused = await setPin(stale, PIN);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('reverification_required');

    const unknown = await h.signIn('adminA', { firstFactorAgeMinutes: null });
    expect((await setPin(unknown, PIN)).status).toBe(403);
    expect((await stepUp(stale, PIN)).status).toBe(409);

    const fresh = await h.signIn('adminA', { firstFactorAgeMinutes: 1 });
    expect((await setPin(fresh, PIN)).status).toBe(200);
  });

  it('refuses weak PINs', async () => {
    const token = await h.signIn('financeA');
    for (const weak of ['111111', '123456', '654321', '12345', '1234567', 'abcdef', '']) {
      expect((await setPin(token, weak)).status, weak).toBe(400);
    }
  });

  it('grants a step-up for the correct PIN and not for a wrong one', async () => {
    const token = await h.signIn('adminA');
    expect((await stepUp(token, '999000')).status).toBe(401);
    const ok = await stepUp(token, PIN);
    expect(ok.status).toBe(200);
    expect(new Date(ok.body.step_up_until).getTime()).toBeGreaterThan(Date.now());
  });

  it('binds the step-up to the session that entered the PIN', async () => {
    const first = await h.signIn('adminA');
    const second = await h.signIn('adminA');
    await stepUp(first, PIN);
    expect((await addMember(first, '+99900000071')).status).toBe(201);
    const other = await addMember(second, '+99900000072');
    expect(other.status).toBe(403);
    expect(other.body.error.code).toBe('step_up_required');
  });

  it('survives the session token being refreshed, because it is bound to the session id', async () => {
    const session = `sess_refresh_${String(Date.now())}`;
    const before = await h.signIn('adminA', { sessionId: session });
    await stepUp(before, PIN);
    const refreshed = await h.signIn('adminA', { sessionId: session, firstFactorAgeMinutes: 20 });
    expect(refreshed).not.toBe(before);
    expect((await addMember(refreshed, '+99900000073')).status).toBe(201);
  });

  it('locks after the attempt limit and then refuses even the correct PIN', async () => {
    const token = await h.signIn('cashierA');
    expect((await setPin(token, PIN)).status).toBe(200);
    for (let i = 0; i < h.config.auth.maxPinAttempts; i += 1) {
      expect((await stepUp(token, '900001')).status).toBe(401);
    }
    const locked = await stepUp(token, PIN);
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('too_many_attempts');
  });

  it('unlocks when the lock expires, and resets the attempt count on success', async () => {
    const token = await h.signIn('cashierA');
    await h.owner((client) =>
      client.query(
        `update identity.user_account set pin_locked_until = now() - interval '1 second' where id = $1`,
        [h.seed.accounts.cashierA],
      ),
    );
    expect((await stepUp(token, PIN)).status).toBe(200);
    const row = await h.owner((client) =>
      client.query(`select pin_failed_attempts from identity.user_account where id = $1`, [
        h.seed.accounts.cashierA,
      ]),
    );
    expect(row.rows[0]?.pin_failed_attempts).toBe(0);
  });

  it('can be reset with a fresh sign-in factor while locked, which clears the lock and old step-ups', async () => {
    const token = await h.signIn('cashierA');
    for (let i = 0; i < h.config.auth.maxPinAttempts; i += 1) await stepUp(token, '900002');
    expect((await stepUp(token, PIN)).status).toBe(429);
    expect((await setPin(token, '739182')).status).toBe(200);
    const stepUps = await h.owner((client) =>
      client.query(`select count(*) as n from identity.step_up where account_id = $1`, [
        h.seed.accounts.cashierA,
      ]),
    );
    expect(stepUps.rows[0]?.n).toBe('0');
    expect((await stepUp(token, PIN)).status).toBe(401);
    expect((await stepUp(token, '739182')).status).toBe(200);
  });

  it('is never stored, audited or logged in clear', async () => {
    const stored = await h.owner((client) =>
      client.query(
        `select
           (select count(*) from identity.user_account where pin_hash like '%' || $1 || '%' or pin_hash like '%739182%') as in_hash,
           (select count(*) from audit.audit_event where audit_event::text like '%' || $1 || '%' or audit_event::text like '%739182%') as in_audit,
           (select count(*) from identity.user_account where pin_hash is not null and length(pin_hash) < 60) as short_hashes`,
        [PIN],
      ),
    );
    expect(stored.rows[0]).toEqual({ in_hash: '0', in_audit: '0', short_hashes: '0' });
    const logs = h.logs.join('\n');
    expect(logs.includes(PIN) || logs.includes('739182')).toBe(false);
  });

  it('audits set, success, failure and lock', async () => {
    const actions = await h.owner((client) =>
      client.query<{ action: string }>(
        `select distinct action from audit.audit_event where action like 'identity.pin.%' order by action`,
      ),
    );
    expect(actions.rows.map((row) => row.action)).toEqual([
      'identity.pin.locked',
      'identity.pin.rejected',
      'identity.pin.set',
      'identity.pin.verified',
    ]);
  });
});
