import { createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ClerkAuthProvider,
  isClerkTestIdentity,
} from '../src/modules/identity/clerk-auth-provider.js';
import { loadConfig } from '../src/platform/config.js';

// ClerkAuthProvider is exercised against the real @clerk/backend verifier, with
// a key pair made here standing in for the Clerk instance's signing key.

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
function token(claims: Record<string, unknown>, key = privateKey): string {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'RS256', typ: 'JWT', kid: 'test' })}.${b64({
    iss: 'https://sandbox.clerk.accounts.dev',
    sub: 'user_abc',
    sid: 'sess_123',
    azp: 'https://kony.aora.test',
    iat: now,
    nbf: now - 5,
    exp: now + 60,
    fva: [3, -1],
    ...claims,
  })}`;
  return `${body}.${createSign('RSA-SHA256').update(body).sign(key).toString('base64url')}`;
}

const env = {
  AORA_MODE: 'sandbox',
  DATABASE_URL_APP: 'postgresql://aora_app@127.0.0.1:54329/aora_dev',
  DATABASE_URL_PLATFORM: 'postgresql://aora_platform@127.0.0.1:54329/aora_dev',
  SANDBOX_SIM_WEBHOOK_SECRET: 'x'.repeat(32),
  PIN_PEPPER: 'p'.repeat(32),
  CLERK_SECRET_KEY: 'sk_test_' + 'a'.repeat(40),
  CLERK_PUBLISHABLE_KEY: 'pk_test_' + 'a'.repeat(40),
  CLERK_JWT_KEY: pem,
  CLERK_WEBHOOK_SIGNING_SECRET: 'whsec_' + Buffer.from('s'.repeat(24)).toString('base64'),
  CLERK_AUTHORIZED_PARTIES: 'https://kony.aora.test,https://chiwo.aora.test',
  RESEND_API_KEY: 're_test_placeholder',
  RESEND_WEBHOOK_SECRET: 'whsec_' + Buffer.from('r'.repeat(24)).toString('base64'),
};
const provider = () => new ClerkAuthProvider(loadConfig(env));

describe('ClerkAuthProvider', () => {
  it('accepts a valid session token and returns the user, session and factor age', async () => {
    expect(await provider().authenticate(token({}))).toEqual({
      subject: 'user_abc',
      sessionId: 'sess_123',
      firstFactorAgeMinutes: 3,
    });
  });

  it.each([
    ['signed by another key', () => token({}, other.privateKey)],
    [
      'expired',
      () =>
        token({
          exp: Math.floor(Date.now() / 1000) - 120,
          iat: Math.floor(Date.now() / 1000) - 300,
        }),
    ],
    ['not yet valid', () => token({ nbf: Math.floor(Date.now() / 1000) + 600 })],
    ['from an origin that is not ours', () => token({ azp: 'https://evil.example' })],
    ['without a session id', () => token({ sid: undefined })],
    [
      'with a tampered payload',
      () => {
        const [h, , s] = token({}).split('.');
        return `${h ?? ''}.${b64({ sub: 'user_someone_else', sid: 'sess_123', exp: 9_999_999_999 })}.${s ?? ''}`;
      },
    ],
    ['that is not a JWT', () => 'not-a-token'],
    [
      'with alg none',
      () =>
        `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'user_abc', sid: 's', exp: 9_999_999_999 })}.`,
    ],
  ])('rejects a token %s', async (_label, make) => {
    expect(await provider().authenticate(make())).toBeNull();
  });

  it("accepts a token with no origin claim: those come from native apps and Clerk's Backend API, never a browser", async () => {
    // A browser-issued token always carries azp, and it cannot be stripped without
    // breaking the signature. So absence is not a way round the origin allow-list.
    expect(await provider().authenticate(token({ azp: undefined }))).toMatchObject({
      subject: 'user_abc',
    });
    expect(await provider().authenticate(token({ azp: '' }))).toBeNull();
    expect(
      await provider().authenticate(token({ azp: 'https://kony.aora.test.evil.example' })),
    ).toBeNull();
  });

  it('treats a never-verified first factor as unknown age', async () => {
    const result = await provider().authenticate(token({ fva: [-1, -1] }));
    expect(result?.firstFactorAgeMinutes).toBeNull();
    expect(
      (await provider().authenticate(token({ fva: undefined })))?.firstFactorAgeMinutes,
    ).toBeNull();
  });
});

describe('Clerk configuration', () => {
  it('is the default provider and needs its keys', () => {
    expect(loadConfig(env).authProvider).toBe('clerk');
    const without: Record<string, string> = { ...env };
    delete without['CLERK_SECRET_KEY'];
    expect(() => loadConfig(without)).toThrow(/CLERK_SECRET_KEY/);
  });

  it.each([
    ['CLERK_SECRET_KEY', 'sk_live_' + 'a'.repeat(40)],
    ['CLERK_PUBLISHABLE_KEY', 'pk_live_' + 'a'.repeat(40)],
  ])('refuses a live %s without echoing it', (name, value) => {
    const attempt = () => loadConfig({ ...env, [name]: value });
    expect(attempt).toThrow(/live or production key/i);
    expect(attempt).not.toThrow(new RegExp(value));
  });

  it('requires an explicit list of authorised origins on a deployed environment', () => {
    const deployed: Record<string, string> = {
      ...env,
      VERCEL: '1',
      CRON_SECRET: 'c'.repeat(32),
      DATABASE_URL_APP: 'postgresql://aora_app:x@ep-a-pooler.eu-central-1.aws.neon.tech/neondb',
      DATABASE_URL_PLATFORM:
        'postgresql://aora_platform:x@ep-a-pooler.eu-central-1.aws.neon.tech/neondb',
    };
    expect(loadConfig(deployed).deployed).toBe(true);
    delete deployed['CLERK_AUTHORIZED_PARTIES'];
    expect(() => loadConfig(deployed)).toThrow(/CLERK_AUTHORIZED_PARTIES/);
  });
});

describe('Clerk test mode identities', () => {
  it('recognises +clerk_test addresses, however written', () => {
    for (const email of [
      'jane+clerk_test@example.com',
      'JANE+CLERK_TEST@EXAMPLE.COM',
      'a.b+x+clerk_test@d.co',
    ]) {
      expect(isClerkTestIdentity(email), email).toBe(true);
    }
    for (const email of [
      'jane@example.com',
      'clerk_test@example.com',
      'jane+other@example.com',
      null,
    ]) {
      expect(isClerkTestIdentity(email), String(email)).toBe(false);
    }
  });
});
