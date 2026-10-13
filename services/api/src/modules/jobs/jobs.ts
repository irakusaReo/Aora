import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  type CanActivate,
  Controller,
  type ExecutionContext,
  Get,
  Inject,
  Injectable,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { APP_CONFIG, type AppConfig } from '../../platform/config.js';
import { Database } from '../../platform/database.js';
import { AppError } from '../../platform/errors.js';
import { RateLimiter } from '../../platform/rate-limit.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { ReconciliationService } from '../payments/reconciliation.service.js';
import { SIM_SIGNATURE_HEADER, SimulatorProvider } from '../payments/simulator.js';

function bearerMatches(request: Request, secret: string | null): boolean {
  if (!secret) return false;
  const given = Buffer.from(request.header('authorization') ?? '');
  const wanted = Buffer.from(`Bearer ${secret}`);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

/** Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Nothing else may call a job. */
@Injectable()
export class CronGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    if (!bearerMatches(context.switchToHttp().getRequest<Request>(), this.config.cronSecret)) {
      throw new AppError('unauthenticated', 'Not authorised.');
    }
    return true;
  }
}

/** Guards the simulated SMS inbox. With no token configured the route does not exist. */
@Injectable()
export class InboxGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.config.smsInboxToken) throw new AppError('not_found', 'Resource not found.');
    if (!bearerMatches(context.switchToHttp().getRequest<Request>(), this.config.smsInboxToken)) {
      throw new AppError('unauthenticated', 'Not authorised.');
    }
    return true;
  }
}

/**
 * Background work as HTTP-triggered jobs (ADR 0013). Cron delivery is best
 * effort: a run can be missed, repeated or overlap the next. So every job
 * processes everything that is due, is safe to run twice, and stops before
 * its time budget ends.
 */
@Controller('v1/internal/cron')
@UseGuards(CronGuard)
export class CronController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(Database) private readonly db: Database,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(SimulatorProvider) private readonly simulator: SimulatorProvider,
    @Inject(ReconciliationService) private readonly reconciliation: ReconciliationService,
    @Inject(RateLimiter) private readonly rateLimiter: RateLimiter,
  ) {}

  @Get('outbox')
  async drainOutbox(): Promise<{ job: 'outbox'; handled: number; budget_exhausted: boolean }> {
    const deadline = Date.now() + this.config.jobs.budgetMs;
    let handled = 0;
    let more = true;
    // Claims use FOR UPDATE SKIP LOCKED, so overlapping runs never take the same event.
    while (Date.now() < deadline && (more = await this.outbox.runOnce())) handled += 1;
    await this.rateLimiter.prune();
    return { job: 'outbox', handled, budget_exhausted: more };
  }

  /** Sandbox only: plays the simulator provider's part by delivering its webhooks over HTTP. */
  @Get('sim-webhooks')
  async deliverSimulatorWebhooks(): Promise<{ job: 'sim-webhooks'; delivered: number }> {
    const delivered = await this.simulator.deliverDueWebhooks(async (rawBody, signature) => {
      const response = await fetch(`${this.config.publicApiUrl}/v1/webhooks/sandbox`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SIM_SIGNATURE_HEADER]: signature },
        body: rawBody,
        signal: AbortSignal.timeout(10_000),
      });
      return response.status;
    });
    return { job: 'sim-webhooks', delivered };
  }

  @Get('reconciliation')
  async reconcile(): Promise<
    | { job: 'reconciliation'; skipped: true; reason: 'already_running' }
    | ({ job: 'reconciliation' } & Awaited<ReturnType<ReconciliationService['run']>>)
  > {
    const holder = randomUUID();
    const lease = await this.db.asPlatform(
      (tx) => tx.$queryRaw<{ holder: string }[]>`
        insert into ops.job_lease as l (name, holder, expires_at)
        values ('reconciliation', ${holder}::uuid,
                now() + make_interval(secs => ${this.config.jobs.leaseSeconds}))
        on conflict (name) do update set holder = excluded.holder, expires_at = excluded.expires_at
          where l.expires_at < now()
        returning holder`,
    );
    if (lease.length === 0)
      return { job: 'reconciliation', skipped: true, reason: 'already_running' };
    try {
      const result = await this.reconciliation.run({ accountId: null, requestId: holder });
      return { job: 'reconciliation', ...result };
    } finally {
      await this.db.asPlatform(
        (tx) => tx.$executeRaw`
          delete from ops.job_lease where name = 'reconciliation' and holder = ${holder}::uuid`,
      );
    }
  }
}

/** Sandbox only: lets an operator read simulated one-time codes while no SMS provider is connected. */
@Controller('v1/internal/sandbox')
@UseGuards(InboxGuard)
export class SandboxInboxController {
  constructor(@Inject(Database) private readonly db: Database) {}

  @Get('sms')
  async list(
    @Query('phone') phone: string | undefined,
  ): Promise<{ data: { phone: string; body: string; sent_at: string }[] }> {
    const rows = await this.db.asPlatform((tx) =>
      tx.sim_sms.findMany({
        where: phone ? { phone_e164: phone } : {},
        orderBy: { created_at: 'desc' },
        take: 20,
      }),
    );
    return {
      data: rows.map((row) => ({
        phone: row.phone_e164,
        body: row.body,
        sent_at: row.created_at.toISOString(),
      })),
    };
  }
}
