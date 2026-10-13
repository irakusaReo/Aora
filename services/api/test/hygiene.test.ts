import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SIM_SIGNATURE_HEADER } from '../src/modules/payments/simulator.js';
import { SEED_PHONES } from '../src/seed-data.js';
import { type Harness, startHarness } from './support/harness.js';
import { createIntent } from './support/payments.js';

let h: Harness;
const tokens: string[] = [];

beforeAll(async () => {
  h = await startHarness({
    config: (config) => ({ ...config, outbox: { maxAttempts: 2, retryDelaySeconds: 0 } }),
  });
  // Exercise success, failure and error paths so that whatever gets logged, gets logged.
  const admin = await h.signIn('adminA');
  const operator = await h.signIn('operator');
  tokens.push(admin, operator);
  const caller = { token: admin, workspace: h.seed.tenantA };
  for (const scenario of [
    'success',
    'decline',
    'timeout_then_success',
    'late_webhook',
    'amount_mismatch',
  ]) {
    await createIntent(h, caller, {
      amount_minor: '1234',
      currency: 'KES',
      sandbox_scenario: scenario,
    });
  }
  await h.settle();
  await h.http().post('/v1/auth/sessions').send({ challenge_id: 'x', code: '654321' });
  await h
    .http()
    .post('/v1/webhooks/sandbox')
    .set(SIM_SIGNATURE_HEADER, 'sha256=bad')
    .send({ a: 1 });
  await h.http().get('/v1/me').set('Authorization', 'Bearer not-a-real-token');
  await h.db
    .asPlatform((tx) => tx.$queryRaw`select * from no_such_table where secret = 'leak-me'`)
    .catch(() => undefined);
  await h.db.asPlatform(
    (tx) =>
      tx.$executeRaw`insert into outbox.outbox_event (type, payload) values ('nobody.listens', '{"pin":"4321"}')`,
  );
  await h.settle();
  await h.http().post('/v1/ops/reconciliation-runs').set('Authorization', `Bearer ${operator}`);
});
afterAll(() => h.close());

describe('logs', () => {
  it('contain no tokens, codes, secrets, phone numbers, connection strings or payloads', () => {
    const output = h.logs.join('\n');
    expect(h.logs.length).toBeGreaterThan(0);
    const forbidden = [
      ...tokens,
      h.config.simWebhookSecret,
      h.config.databaseUrlApp,
      h.config.databaseUrlPlatform,
      ...Object.values(SEED_PHONES),
      '000000',
      '654321',
      'leak-me',
      '"pin"',
      'postgresql://',
    ];
    for (const value of forbidden) {
      expect(output.includes(value), `logs must not contain ${value.slice(0, 6)}…`).toBe(false);
    }
  });
});

describe('source tree', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (['node_modules', 'dist', 'generated'].includes(entry.name)) return [];
      const path = join(dir, entry.name);
      return entry.isDirectory() ? files(path) : [path];
    });

  it('contains nothing that looks like a private key, seed phrase or credential-bearing URL', () => {
    const patterns = [
      /0x[0-9a-fA-F]{64}\b/, // raw 32-byte key
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /\b(?:[a-z]+ ){11,23}[a-z]+\b(?=.*mnemonic)/i,
      /postgres(?:ql)?:\/\/[^:@/\s<]+:[^@/\s<]+@/, // user:password@
    ];
    const offenders = files(root)
      .filter((path) => /\.(ts|sql|json|yaml|yml|prisma|sh)$/.test(path))
      .filter((path) => !/(hygiene|auth|deployed-guard)\.test\.ts$/.test(path))
      .filter((path) => patterns.some((pattern) => pattern.test(readFileSync(path, 'utf8'))));
    expect(offenders).toEqual([]);
  });

  it('uses no floating-point parsing or arithmetic helpers in application code', () => {
    const offenders = files(join(root, 'src')).filter((path) =>
      /\b(parseFloat|toFixed|Math\.round|Number\.parseFloat)\b/.test(readFileSync(path, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
