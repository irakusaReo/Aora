import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { APP_CONFIG, type AppConfig } from '../../platform/config.js';
import { Database, type Tx } from '../../platform/database.js';

export interface OutboxEvent {
  readonly id: string;
  readonly tenantId: string | null;
  readonly type: string;
  readonly payload: Prisma.JsonValue;
  readonly attempts: number;
}

export type OutboxHandler = (event: OutboxEvent) => Promise<void>;

interface ClaimedRow {
  id: string;
  tenant_id: string | null;
  type: string;
  payload: Prisma.JsonValue;
  attempts: number;
}

/**
 * Transactional outbox (ADR 0008).
 *
 * `enqueue` writes the event in the caller's transaction, so the event exists
 * if and only if the change it announces committed. The worker delivers each
 * event at least once; every handler must therefore be idempotent.
 */
@Injectable()
export class OutboxService {
  private readonly logger = new Logger('Outbox');
  private readonly handlers = new Map<string, OutboxHandler>();
  /** How long a claimed event may sit in `processing` before another worker takes it. */
  private readonly lockTimeoutSeconds = 60;

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  register(type: string, handler: OutboxHandler): void {
    if (this.handlers.has(type)) throw new Error(`Outbox handler already registered: ${type}`);
    this.handlers.set(type, handler);
  }

  async enqueue(
    tx: Tx,
    event: {
      tenantId: string | null;
      type: string;
      payload: Prisma.InputJsonObject;
      availableAt?: Date;
    },
  ): Promise<string> {
    // Plain INSERT without RETURNING: the tenant role may add events but not read them.
    const id = randomUUID();
    await tx.$executeRaw`
      insert into outbox.outbox_event (id, tenant_id, type, payload, available_at)
      values (${id}::uuid, ${event.tenantId}::uuid, ${event.type},
              ${JSON.stringify(event.payload)}::jsonb, ${event.availableAt ?? new Date()})`;
    return id;
  }

  /** Claims and handles one due event. Returns false when nothing is due. */
  async runOnce(): Promise<boolean> {
    const claimed = await this.db.asPlatform(async (tx) => {
      const rows = await tx.$queryRaw<ClaimedRow[]>`
        select id, tenant_id, type, payload, attempts
        from outbox.outbox_event
        where (status = 'pending' and available_at <= now())
           or (status = 'processing'
               and locked_at < now() - make_interval(secs => ${this.lockTimeoutSeconds}))
        order by available_at, created_at
        limit 1
        for update skip locked`;
      const row = rows[0];
      if (!row) return null;
      await tx.outbox_event.update({
        where: { id: row.id },
        data: { status: 'processing', locked_at: new Date(), attempts: { increment: 1 } },
      });
      return row;
    });
    if (!claimed) return false;

    const attempts = claimed.attempts + 1;
    try {
      const handler = this.handlers.get(claimed.type);
      if (!handler) throw new UnknownEventType();
      await handler({
        id: claimed.id,
        tenantId: claimed.tenant_id,
        type: claimed.type,
        payload: claimed.payload,
        attempts,
      });
      await this.db.asPlatform((tx) =>
        tx.outbox_event.update({
          where: { id: claimed.id },
          data: { status: 'done', processed_at: new Date(), locked_at: null, last_error: null },
        }),
      );
    } catch (error) {
      // Error messages can quote payloads or SQL. Keep only the error's class name.
      const reason = error instanceof Error ? error.constructor.name : 'UnknownError';
      const dead = attempts >= this.config.outbox.maxAttempts;
      const delayMs = this.config.outbox.retryDelaySeconds * 1000 * 2 ** (attempts - 1);
      await this.db.asPlatform((tx) =>
        tx.outbox_event.update({
          where: { id: claimed.id },
          data: {
            status: dead ? 'dead' : 'pending',
            locked_at: null,
            last_error: reason,
            available_at: new Date(Date.now() + delayMs),
          },
        }),
      );
      const fate = dead ? 'is dead and needs an operator' : 'will retry';
      this.logger.warn(`event ${claimed.id} (${claimed.type}) failed with ${reason}; ${fate}`);
    }
    return true;
  }

  /** Handles everything currently due. For tests and for draining on shutdown. */
  async runUntilIdle(limit = 1000): Promise<number> {
    let handled = 0;
    while (handled < limit && (await this.runOnce())) handled += 1;
    return handled;
  }
}

class UnknownEventType extends Error {}
