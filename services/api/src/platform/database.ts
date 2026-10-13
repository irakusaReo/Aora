import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { type Prisma, PrismaClient } from '../generated/prisma/client.js';
import { APP_CONFIG, type AppConfig } from './config.js';

export type Tx = Prisma.TransactionClient;

/**
 * Limits for one transaction. The API sits next to the database (ADR 0013), so
 * a transaction normally takes milliseconds; these bounds stop one from holding
 * locks for long if something stalls. They are wider than the driver's 5 s
 * default so that work run from a distant machine (seeding, migration checks)
 * is not cut off by network latency alone.
 */
const TRANSACTION = { maxWait: 10_000, timeout: 20_000 };

function adapter(connectionString: string): PrismaPg {
  return new PrismaPg({ connectionString });
}

/**
 * The only way to reach PostgreSQL.
 *
 * - `withTenant` uses the `aora_app` role. Row-level security limits it to the
 *   tenant set for the transaction; with no tenant set it sees nothing.
 * - `asPlatform` uses the `aora_platform` role, for sign-in, workers,
 *   reconciliation and operator endpoints.
 *
 * Both run inside a transaction, so a state change, its journal entry and its
 * outbox event commit together or not at all.
 *
 * No session state is ever set. The runtime connection is a transaction-mode
 * pooler (ADR 0013), where the next transaction may belong to anyone. The
 * tenant and the time zone are therefore set with transaction scope, as the
 * first statement of every transaction. (The driver sends timestamps as UTC
 * wall-clock text, so the time zone must be UTC or PostgreSQL shifts them.)
 */
@Injectable()
export class Database implements OnModuleDestroy {
  private readonly app: PrismaClient;
  private readonly platform: PrismaClient;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.app = new PrismaClient({ adapter: adapter(config.databaseUrlApp) });
    this.platform = new PrismaClient({ adapter: adapter(config.databaseUrlPlatform) });
  }

  withTenant<T>(tenantId: string, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.app.$transaction(async (tx) => {
      await tx.$queryRaw`
        select set_config('TimeZone', 'UTC', true), set_config('app.tenant_id', ${tenantId}, true)`;
      return work(tx);
    }, TRANSACTION);
  }

  asPlatform<T>(work: (tx: Tx) => Promise<T>, options: { timeoutMs?: number } = {}): Promise<T> {
    return this.platform.$transaction(
      async (tx) => {
        await tx.$queryRaw`select set_config('TimeZone', 'UTC', true)`;
        return work(tx);
      },
      { ...TRANSACTION, ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}) },
    );
  }

  /** For isolation tests only: the tenant-scoped role with no tenant set. */
  withoutTenantForTest<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.app.$transaction(async (tx) => {
      await tx.$queryRaw`select set_config('TimeZone', 'UTC', true)`;
      return work(tx);
    }, TRANSACTION);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.app.$disconnect(), this.platform.$disconnect()]);
  }
}
