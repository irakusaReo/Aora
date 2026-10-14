import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  type CallHandler,
  type CanActivate,
  Controller,
  type ExecutionContext,
  Get,
  Inject,
  Injectable,
  type NestInterceptor,
  UseGuards,
} from '@nestjs/common';
import { waitUntil } from '@vercel/functions';
import { finalize, type Observable } from 'rxjs';
import type { Request } from 'express';
import { APP_CONFIG, type AppConfig } from '../../platform/config.js';
import { Database } from '../../platform/database.js';
import { AppError } from '../../platform/errors.js';
import { RateLimiter } from '../../platform/rate-limit.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { ReconciliationService } from '../payments/reconciliation.service.js';
import { SettlementService } from '../payments/settlement.service.js';
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

/**
 * Drains the outbox in the background after a request that may have enqueued
 * work, so an event does not wait for the next scheduled run (ADR 0013).
 * `waitUntil` keeps the function alive after the response on Vercel; it is
 * bounded by the job time budget and by the function's maximum duration.
 * Scheduled runs remain the backstop: this is an optimisation, never the only path.
 */
@Injectable()
export class DrainAfterResponseInterceptor implements NestInterceptor {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const mayEnqueue =
      this.config.deployed && request.method !== 'GET' && !request.path.includes('/internal/');
    return mayEnqueue
      ? next.handle().pipe(
          finalize(() => {
            this.drain();
          }),
        )
      : next.handle();
  }

  private drain(): void {
    const deadline = Date.now() + Math.min(this.config.jobs.budgetMs, 20_000);
    const work = (async (): Promise<void> => {
      while (Date.now() < deadline && (await this.outbox.runOnce())) {
        // keep going until idle or out of time
      }
    })().catch(() => undefined);
    waitUntil(work);
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
    @Inject(SettlementService) private readonly settlement: SettlementService,
  ) {}

  /** Settles succeeded collections (ADR 0021). Idempotent; concurrent runs take different rows. */
  @Get('settlement')
  async settle(): Promise<{ job: 'settlement'; batches: number; collections: number }> {
    return { job: 'settlement', ...(await this.settlement.run()) };
  }

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
      // Typed structurally: the hosting platform's build resolves the global
      // `Response` type differently from a local build, and only `status` is needed.
      const response = (await fetch(`${this.config.publicApiUrl}/v1/webhooks/sandbox`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SIM_SIGNATURE_HEADER]: signature },
        body: rawBody,
        signal: AbortSignal.timeout(10_000),
      })) as unknown as { status: number };
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
