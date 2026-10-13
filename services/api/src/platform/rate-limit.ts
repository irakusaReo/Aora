import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig, type RateLimitName } from './config.js';
import { Database } from './database.js';
import { AppError } from './errors.js';

/**
 * Fixed-window rate limiting in PostgreSQL, so every serverless instance
 * counts against the same store (ADR 0013). One atomic upsert per check.
 * The key (a phone number, an address, an account) is stored only as a digest.
 */
@Injectable()
export class RateLimiter {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Counts one attempt and throws `too_many_attempts` when the window is full. */
  async consume(name: RateLimitName, key: string): Promise<void> {
    const rule = this.config.rateLimits[name];
    const bucket = createHash('sha256').update(`${name}\n${key}`).digest('hex');
    const rows = await this.db.asPlatform(
      (tx) => tx.$queryRaw<{ count: number }[]>`
        insert into ops.rate_limit as r (bucket, window_start, count)
        values (${bucket},
                to_timestamp(floor(extract(epoch from now()) / ${rule.windowSeconds}) * ${rule.windowSeconds}),
                1)
        on conflict (bucket, window_start) do update set count = r.count + 1
        returning count`,
    );
    if ((rows[0]?.count ?? Number.MAX_SAFE_INTEGER) > rule.limit) {
      throw new AppError('too_many_attempts', 'Too many attempts. Try again later.');
    }
  }

  /** Removes windows that can no longer matter. Called from a cron job. */
  async prune(): Promise<void> {
    await this.db.asPlatform(
      (tx) =>
        tx.$executeRaw`delete from ops.rate_limit where window_start < now() - interval '1 day'`,
    );
  }
}
