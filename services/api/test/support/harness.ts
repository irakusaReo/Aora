import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import type { INestApplication, LoggerService, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type pg from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { SandboxAuthProvider } from '../../src/modules/identity/auth-provider.js';
import { OutboxService } from '../../src/modules/outbox/outbox.service.js';
import { SIM_SIGNATURE_HEADER, SimulatorProvider } from '../../src/modules/payments/simulator.js';
import { type AppConfig, loadConfig } from '../../src/platform/config.js';
import { Database } from '../../src/platform/database.js';
import { SEED_PHONES, type SeedResult, seedSandbox } from '../../src/seed-data.js';
import { TEMPLATE, url, withClient } from './pg.js';

export interface Harness {
  readonly app: INestApplication;
  readonly config: AppConfig;
  readonly db: Database;
  readonly seed: SeedResult;
  readonly databaseName: string;
  http(): ReturnType<typeof request>;
  signIn(who: keyof typeof SEED_PHONES): Promise<string>;
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
  options: { controllers?: Type[]; config?: (config: AppConfig) => AppConfig } = {},
): Promise<Harness> {
  const databaseName = `aora_test_${randomBytes(6).toString('hex')}`;
  await withClient('aora_owner', 'postgres', (client) =>
    client.query(`create database "${databaseName}" template "${TEMPLATE}"`),
  );

  const base = loadConfig({
    AORA_MODE: 'sandbox',
    DATABASE_URL_APP: url('aora_app', databaseName),
    DATABASE_URL_PLATFORM: url('aora_platform', databaseName),
    SANDBOX_SIM_WEBHOOK_SECRET: randomBytes(24).toString('hex'),
  });
  const config = options.config ? options.config(base) : base;

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
  await app.init();

  const db = app.get(Database);
  const seed = await seedSandbox(db, AppModule.workspaceHook());
  const http = (): ReturnType<typeof request> => request(app.getHttpServer());

  return {
    app,
    config,
    db,
    seed,
    databaseName,
    http,
    async signIn(who) {
      const challenge = await http().post('/v1/auth/challenges').send({ phone: SEED_PHONES[who] });
      const session = await http()
        .post('/v1/auth/sessions')
        .send({ challenge_id: challenge.body.challenge_id, code: SandboxAuthProvider.FIXED_CODE });
      if (session.status !== 201) throw new Error(`sign-in failed for ${who}`);
      return session.body.token as string;
    },
    owner: (work) => withClient('postgres', databaseName, work),
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
      await withClient('aora_owner', 'postgres', (client) =>
        client.query(`drop database if exists "${databaseName}" with (force)`),
      );
    },
  };
}
