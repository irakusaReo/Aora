import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import type { INestApplication, LoggerService, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type pg from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { AUTH_PROVIDER, SandboxAuthProvider } from '../../src/modules/identity/auth-provider.js';
import { OutboxService } from '../../src/modules/outbox/outbox.service.js';
import { SIM_SIGNATURE_HEADER, SimulatorProvider } from '../../src/modules/payments/simulator.js';
import { type AppConfig, loadConfig } from '../../src/platform/config.js';
import { Database } from '../../src/platform/database.js';
import { SEED_PHONES, type SeedResult, seedSandbox } from '../../src/seed-data.js';
import { pooledUrl, TEMPLATE, url, withClient } from './pg.js';

export interface Harness {
  readonly app: INestApplication;
  readonly config: AppConfig;
  readonly db: Database;
  readonly seed: SeedResult;
  readonly databaseName: string;
  http(): ReturnType<typeof request>;
  /** A request token for a seeded account, minted by the test-only sandbox authenticator. */
  signIn(
    who: keyof typeof SEED_PHONES,
    options?: { sessionId?: string; firstFactorAgeMinutes?: number | null },
  ): Promise<string>;
  /** Sets a PIN for a signed-in account and completes a step-up with it. */
  stepUp(token: string, pin?: string): Promise<void>;
  /** The sandbox authenticator, for minting tokens for users AORA has not seen. */
  readonly sandboxAuth: SandboxAuthProvider;
  /** Runs SQL as the cluster superuser (bypasses row-level security), for assertions only. */
  owner<T>(work: (client: pg.Client) => Promise<T>): Promise<T>;
  /** Everything the application logged, for checking that nothing sensitive is written. */
  readonly logs: string[];
  /** Runs the worker's job until nothing is due: outbox events and simulator webhooks. */
  settle(): Promise<void>;
  /** Makes delayed outbox events (such as status inquiries) due now. */
  makeDelayedEventsDue(): Promise<void>;
  close(): Promise<void>;
}

export async function startHarness(
  options: {
    controllers?: Type[];
    config?: (config: AppConfig) => AppConfig;
    /** Connect the application through PgBouncer in transaction mode. */
    pooled?: boolean;
    /** Start a second application instance on another harness's database (no new seed). */
    shareDatabaseOf?: Harness;
    /** Keep the production rate limits instead of the relaxed test ones. */
    realRateLimits?: boolean;
  } = {},
): Promise<Harness> {
  const shared = options.shareDatabaseOf;
  const databaseName = shared?.databaseName ?? `aora_test_${randomBytes(6).toString('hex')}`;
  if (!shared) {
    await withClient('postgres', 'postgres', (client) =>
      client.query(`create database "${databaseName}" template "${TEMPLATE}" owner aora_owner`),
    );
  }

  const base = loadConfig({
    AORA_MODE: 'sandbox',
    DATABASE_URL_APP: (options.pooled ? pooledUrl : url)('aora_app', databaseName),
    DATABASE_URL_PLATFORM: (options.pooled ? pooledUrl : url)('aora_platform', databaseName),
    SANDBOX_SIM_WEBHOOK_SECRET: randomBytes(24).toString('hex'),
    PIN_PEPPER: randomBytes(32).toString('hex'),
    CRON_SECRET: randomBytes(32).toString('hex'),
    // Tests use the sandbox authenticator; this is legal only because the
    // database is on this machine (see deployed-guard.test.ts).
    AUTH_PROVIDER: 'sandbox',
    // Webhook signatures are real Svix signatures made with these throwaway secrets.
    CLERK_WEBHOOK_SIGNING_SECRET: `whsec_${randomBytes(24).toString('base64')}`,
    RESEND_WEBHOOK_SECRET: `whsec_${randomBytes(24).toString('base64')}`,
  });
  // Tests sign the same few accounts in hundreds of times; only rate-limit tests keep real limits.
  const relaxed: AppConfig = options.realRateLimits
    ? base
    : {
        ...base,
        rateLimits: Object.fromEntries(
          Object.entries(base.rateLimits).map(([name, rule]) => [
            name,
            { ...rule, limit: 100_000 },
          ]),
        ) as AppConfig['rateLimits'],
      };
  const config = options.config ? options.config(relaxed) : relaxed;

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.register(config)],
    controllers: options.controllers ?? [],
  }).compile();
  const logs: string[] = [];
  const capture = (...parts: unknown[]): void => {
    logs.push(
      parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '),
    );
  };
  const logger: LoggerService = { log: capture, error: capture, warn: capture, debug: capture };
  const app = moduleRef.createNestApplication({ rawBody: true, logger });
  // Listen on a real port: cron jobs deliver simulator webhooks to the API over HTTP.
  await app.listen(0, '127.0.0.1');
  const address = (app.getHttpServer() as import('node:http').Server).address();
  if (address && typeof address === 'object') {
    Object.assign(config, { publicApiUrl: `http://127.0.0.1:${String(address.port)}` });
  }

  const db = app.get(Database);
  const seed = shared?.seed ?? (await seedSandbox(db, AppModule.workspaceHook()));
  const http = (): ReturnType<typeof request> => request(app.getHttpServer());
  const sandboxAuth = app.get<SandboxAuthProvider>(AUTH_PROVIDER);

  return {
    app,
    config,
    db,
    seed,
    databaseName,
    http,
    signIn(who, options = {}) {
      return Promise.resolve(sandboxAuth.issue(seed.clerkIds[who], options));
    },
    owner: (work) => withClient('postgres', databaseName, work),
    async stepUp(token, pin = '482915') {
      const auth = { Authorization: `Bearer ${token}` };
      const set = await http().put('/v1/auth/pin').set(auth).send({ pin });
      if (set.status !== 200) throw new Error(`setting PIN failed: ${String(set.status)}`);
      const done = await http().post('/v1/auth/step-up').set(auth).send({ pin });
      if (done.status !== 200) throw new Error(`step-up failed: ${String(done.status)}`);
    },
    sandboxAuth,
    logs,
    async settle() {
      const outbox = app.get(OutboxService);
      const simulator = app.get(SimulatorProvider);
      for (let round = 0; round < 50; round += 1) {
        const handled = await outbox.runUntilIdle();
        const delivered = await simulator.deliverDueWebhooks(async (body, signature) => {
          const response = await http()
            .post('/v1/webhooks/sandbox')
            .set('Content-Type', 'application/json')
            .set(SIM_SIGNATURE_HEADER, signature)
            .send(body);
          return response.status;
        });
        if (handled + delivered === 0) return;
      }
      throw new Error('worker did not become idle');
    },
    async makeDelayedEventsDue() {
      await withClient('postgres', databaseName, (client) =>
        client.query(
          `update outbox.outbox_event set available_at = now() where status = 'pending'`,
        ),
      );
    },
    async close() {
      await app.close();
      if (shared) return;
      await withClient('postgres', 'postgres', (client) =>
        client.query(`drop database if exists "${databaseName}" with (force)`),
      );
    },
  };
}
