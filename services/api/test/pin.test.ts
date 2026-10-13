import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SandboxAuthProvider } from '../src/modules/identity/auth-provider.js';
import { type Harness, startHarness } from './support/harness.js';

// PIN state machine (docs/plans/phase-2.md §5):
//   unset -> set (needs a fresh one-time code)
//   set + correct PIN -> step-up granted, attempts reset
//   set + wrong PIN   -> attempts + 1 -> locked at the limit
//   locked            -> refuses even the correct PIN until it expires or the PIN is reset

let h: Harness;
const CODE = SandboxAuthProvider.FIXED_CODE;
const PIN = '482915';

beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h.close());

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function setPin(token: string, pin: string, code = CODE) {
  const challenge = await h.http().post('/v1/auth/pin/challenges').set(auth(token));
  expect(challenge.status).toBe(201);
  return h
    .http()
    .put('/v1/auth/pin')
    .set(auth(token))
    .send({ pin, challenge_id: challenge.body.challenge_id, code });
}

const stepUp = (token: string, pin: string) =>
  h.http().post('/v1/auth/step-up').set(auth(token)).send({ pin });

describe('PIN', () => {
  it('cannot be used for step-up before it is set', async () => {
    const token = await h.signIn('adminB');
    const response = await stepUp(token, PIN);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('pin_not_set');
  });

  it('can be set only with a fresh one-time code', async () => {
    const token = await h.signIn('adminA');
    expect((await setPin(token, PIN, '111111')).status).toBe(401);
    expect((await stepUp(token, PIN)).status).toBe(409);

    const withoutChallenge = await h
      .http()
      .put('/v1/auth/pin')
      .set(auth(token))
      .send({ pin: PIN, challenge_id: 'f3b0c7a2-0000-4000-8000-000000000000', code: CODE });
    expect(withoutChallenge.status).toBe(401);

    const signInChallenge = await h
      .http()
      .post('/v1/auth/challenges')
      .send({ phone: '+99900000001' });
    const wrongPurpose = await h
      .http()
      .put('/v1/auth/pin')
      .set(auth(token))
      .send({ pin: PIN, challenge_id: signInChallenge.body.challenge_id, code: CODE });
    expect(wrongPurpose.status).toBe(401);

    expect((await setPin(token, PIN)).status).toBe(200);
  });

  it('refuses weak PINs', async () => {
    const token = await h.signIn('financeA');
    for (const weak of ['111111', '123456', '654321', '12345', '1234567', 'abcdef', '']) {
      const response = await setPin(token, weak);
      expect(response.status, weak).toBe(400);
    }
  });

  it('grants a step-up for the correct PIN and not for a wrong one', async () => {
    const token = await h.signIn('adminA');
    expect((await stepUp(token, '999000')).status).toBe(401);
    const ok = await stepUp(token, PIN);
    expect(ok.status).toBe(200);
    expect(new Date(ok.body.step_up_until).getTime()).toBeGreaterThan(Date.now());
  });

  it('grants the step-up to that session only', async () => {
    const first = await h.signIn('adminA');
    await h.signIn('adminA');
    await stepUp(first, PIN);
    const sessions = await h.owner((client) =>
      client.query(
        `select count(*) filter (where step_up_until > now()) as stepped, count(*) as total
         from identity.session where account_id = $1 and created_at > now() - interval '5 seconds'`,
        [h.seed.accounts.adminA],
      ),
    );
    expect(Number(sessions.rows[0]?.stepped)).toBeLessThan(Number(sessions.rows[0]?.total));
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

  it('can be reset with a one-time code while locked, which clears the lock', async () => {
    const token = await h.signIn('cashierA');
    for (let i = 0; i < h.config.auth.maxPinAttempts; i += 1) await stepUp(token, '900002');
    expect((await stepUp(token, PIN)).status).toBe(429);
    expect((await setPin(token, '739182')).status).toBe(200);
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

describe('sign-out', () => {
  it('revokes the session', async () => {
    const token = await h.signIn('adminB');
    expect((await h.http().delete('/v1/auth/session').set(auth(token))).status).toBe(204);
    expect((await h.http().get('/v1/me').set(auth(token))).status).toBe(401);
  });
});
