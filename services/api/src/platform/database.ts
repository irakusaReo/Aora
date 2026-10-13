import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { type Prisma, PrismaClient } from '../generated/prisma/client.js';
import { APP_CONFIG, type AppConfig } from './config.js';

export type Tx = Prisma.TransactionClient;

// The driver sends timestamps as UTC wall-clock text. The session time zone must
// be UTC too, or PostgreSQL shifts every `timestamptz` the application writes by
// the server's local offset and it disagrees with now().
function adapter(connectionString: string): PrismaPg {
  return new PrismaPg({ connectionString, options: '-c TimeZone=UTC' });
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
      await tx.$executeRaw`select set_config('app.tenant_id', ${tenantId}, true)`;
      return work(tx);
    });
  }

  asPlatform<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.platform.$transaction(work);
  }

  /** For isolation tests only: the tenant-scoped role with no tenant set. */
  withoutTenantForTest<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.app.$transaction(work);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.app.$disconnect(), this.platform.$disconnect()]);
  }
}
