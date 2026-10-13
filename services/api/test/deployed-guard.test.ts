import { describe, expect, it } from 'vitest';
import { SandboxAuthProvider } from '../src/modules/identity/auth-provider.js';
import { loadConfig } from '../src/platform/config.js';
import { sandboxAuthAllowed } from '../src/platform/deployment.js';

// The sandbox authenticator mints its own tokens, so it must be impossible on
// any deployed environment. The rule is derived from where the process runs and
// what database it talks to, not from a flag that could be set wrongly.

const local = {
  AORA_MODE: 'sandbox',
  DATABASE_URL_APP: 'postgresql://aora_app@127.0.0.1:54329/aora_dev',
  DATABASE_URL_PLATFORM: 'postgresql://aora_platform@localhost:54329/aora_dev',
  SANDBOX_SIM_WEBHOOK_SECRET: 'x'.repeat(32),
  PIN_PEPPER: 'p'.repeat(32),
  AUTH_PROVIDER: 'sandbox',
};

describe('sandbox authenticator', () => {
  it('is allowed on a developer machine with a local database', () => {
    expect(sandboxAuthAllowed(local)).toBe(true);
    expect(() => new SandboxAuthProvider(loadConfig(local), local)).not.toThrow();
  });

  it.each([
    ['VERCEL', '1'],
    ['VERCEL_ENV', 'production'],
    ['VERCEL_ENV', 'preview'],
    ['VERCEL_URL', 'aora.vercel.app'],
  ])('is refused when %s is set', (name, value) => {
    const env = { ...local, [name]: value };
    expect(sandboxAuthAllowed(env)).toBe(false);
    expect(() => loadConfig(env)).toThrow(/sandbox authenticator is forbidden/i);
  });

  it.each([
    'postgresql://aora_app:pw@ep-cool-name-pooler.eu-central-1.aws.neon.tech/aora',
    'postgresql://aora_app@10.0.0.5:5432/aora',
    'postgresql://aora_app@db.internal/aora',
    'postgresql://aora_app@localhost.evil.example/aora',
    'postgresql://aora_app@127.0.0.1.nip.io/aora',
    'not a url',
  ])('is refused when a database is not on this machine: %s', (url) => {
    for (const key of ['DATABASE_URL_APP', 'DATABASE_URL_PLATFORM'] as const) {
      const env = { ...local, [key]: url };
      expect(sandboxAuthAllowed(env)).toBe(false);
      expect(() => loadConfig(env)).toThrow(/sandbox authenticator is forbidden/i);
    }
  });

  it('cannot be constructed directly on a deployed environment, whatever the config says', () => {
    const config = loadConfig(local);
    expect(() => new SandboxAuthProvider(config, { ...local, VERCEL: '1' })).toThrow(/forbidden/i);
  });

  it('is not the default: with no AUTH_PROVIDER, Clerk is used and its keys are required', () => {
    const rest: Record<string, string> = { ...local };
    delete rest['AUTH_PROVIDER'];
    expect(() => loadConfig(rest)).toThrow(/CLERK_SECRET_KEY/);
  });

  it('cannot mint a token that another instance would accept', async () => {
    const a = new SandboxAuthProvider(loadConfig(local), local);
    const b = new SandboxAuthProvider(loadConfig(local), local);
    const token = a.issue('user_x');
    expect(await a.authenticate(token)).toMatchObject({ subject: 'user_x' });
    expect(await b.authenticate(token)).toBeNull();
    expect(await a.authenticate(a.issue('user_x', { expiresInSeconds: -1 }))).toBeNull();
    expect(await a.authenticate(`${token}x`)).toBeNull();
  });
});
