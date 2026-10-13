import { describe, expect, it } from 'vitest';
import { SandboxAuthProvider } from '../src/modules/identity/auth-provider.js';
import { loadConfig } from '../src/platform/config.js';
import { fixedCodeAllowed } from '../src/platform/deployment.js';

// The fixed sign-in code must be impossible on any deployed environment. The
// rule is derived from where the process runs and what database it talks to,
// not from a flag that could be set wrongly.

const local = {
  AORA_MODE: 'sandbox',
  DATABASE_URL_APP: 'postgresql://aora_app@127.0.0.1:54329/aora_dev',
  DATABASE_URL_PLATFORM: 'postgresql://aora_platform@localhost:54329/aora_dev',
  SANDBOX_SIM_WEBHOOK_SECRET: 'x'.repeat(32),
  PIN_PEPPER: 'p'.repeat(32),
  AUTH_PROVIDER: 'fixed',
};

describe('fixed sign-in code', () => {
  it('is allowed on a developer machine with a local database', () => {
    expect(fixedCodeAllowed(local)).toBe(true);
    expect(() => new SandboxAuthProvider(loadConfig(local), local)).not.toThrow();
  });

  it.each([
    ['VERCEL', '1'],
    ['VERCEL_ENV', 'production'],
    ['VERCEL_ENV', 'preview'],
    ['VERCEL_URL', 'aora.vercel.app'],
  ])('is refused when %s is set', (name, value) => {
    const env = { ...local, [name]: value };
    expect(fixedCodeAllowed(env)).toBe(false);
    expect(() => loadConfig(env)).toThrow(/fixed sign-in code/i);
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
      expect(fixedCodeAllowed(env)).toBe(false);
      expect(() => loadConfig(env)).toThrow(/fixed sign-in code/i);
    }
  });

  it('cannot be constructed directly on a deployed environment, whatever the config says', () => {
    const config = loadConfig(local);
    expect(() => new SandboxAuthProvider(config, { ...local, VERCEL: '1' })).toThrow(/forbidden/i);
  });

  it('is not the default: with no AUTH_PROVIDER the one-time-code provider is used', () => {
    const rest: Record<string, string> = { ...local };
    delete rest['AUTH_PROVIDER'];
    expect(loadConfig(rest).authProvider).toBe('otp');
    expect(loadConfig({ ...rest, VERCEL: '1', CRON_SECRET: 'c'.repeat(32) }).authProvider).toBe(
      'otp',
    );
    // A deployed environment must also have a cron secret, or its jobs would be open.
    expect(() => loadConfig({ ...rest, VERCEL: '1' })).toThrow(/CRON_SECRET/);
  });
});
