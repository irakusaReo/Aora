import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { Database, type Tx } from '../../platform/database.js';
import { AppError } from '../../platform/errors.js';
import { contextOf, parseBody, sessionOf } from '../../platform/http.js';
import { AuditService } from '../audit/audit.service.js';
import { OperatorGuard, SessionGuard, StepUpGuard } from '../identity/guards.js';

/** Every flag the code knows. A row for each is created by migration, off. */
export const FEATURE_FLAGS = ['kelo_credit'] as const;
export type FeatureFlag = (typeof FEATURE_FLAGS)[number];

export interface FeatureFlagView {
  readonly key: string;
  readonly enabled: boolean;
  readonly reason: string | null;
  readonly changed_at: string;
}

const switchBody = z.strictObject({
  enabled: z.boolean(),
  reason: z.string().trim().min(3).max(300),
});

/**
 * Feature flags as data (phase-8 P8-1): read on every use, so an operator's
 * switch takes effect at once on every instance, and never needs a Vercel change.
 */
@Injectable()
export class FeatureFlagsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async isEnabled(key: FeatureFlag, tx?: Tx): Promise<boolean> {
    const read = (client: Tx) =>
      client.$queryRaw<{ enabled: boolean }[]>`
        select enabled from ops.feature_flag where key = ${key}`;
    const rows = tx ? await read(tx) : await this.db.asPlatform(read);
    return rows[0]?.enabled === true;
  }

  /** Throws `not_found` while the flag is off: a switched-off route does not exist. */
  async require(key: FeatureFlag, tx?: Tx): Promise<void> {
    if (!(await this.isEnabled(key, tx))) throw new AppError('not_found', 'Not found.');
  }

  async list(): Promise<FeatureFlagView[]> {
    const rows = await this.db.asPlatform(
      (tx) => tx.$queryRaw<
        { key: string; enabled: boolean; reason: string | null; changed_at: Date }[]
      >`
        select key, enabled, reason, changed_at from ops.feature_flag order by key`,
    );
    return rows.map((row) => ({ ...row, changed_at: row.changed_at.toISOString() }));
  }

  async set(
    actor: { accountId: string; requestId: string },
    key: string,
    input: { enabled: boolean; reason: string },
  ): Promise<FeatureFlagView> {
    if (!(FEATURE_FLAGS as readonly string[]).includes(key)) {
      throw new AppError('not_found', 'Feature flag not found.');
    }
    return this.db.asPlatform(async (tx) => {
      const rows = await tx.$queryRaw<
        { key: string; enabled: boolean; reason: string | null; changed_at: Date }[]
      >`
        update ops.feature_flag
           set enabled = ${input.enabled}, reason = ${input.reason},
               changed_by = ${actor.accountId}::uuid, changed_at = now()
         where key = ${key}
        returning key, enabled, reason, changed_at`;
      const row = rows[0];
      if (!row) throw new AppError('not_found', 'Feature flag not found.');
      await this.audit.record(tx, {
        actorKind: 'user',
        actorAccountId: actor.accountId,
        action: 'ops.feature_flag.changed',
        subjectType: 'feature_flag',
        subjectId: key,
        outcome: 'success',
        requestId: actor.requestId,
        detail: { key, enabled: input.enabled, reason: input.reason },
      });
      return { ...row, changed_at: row.changed_at.toISOString() };
    });
  }
}

/** The operator switch (P8-1): platform operators only, with a step-up and a reason. */
@Controller('v1/ops/feature-flags')
@UseGuards(SessionGuard, OperatorGuard)
export class OpsFeatureFlagsController {
  constructor(@Inject(FeatureFlagsService) private readonly flags: FeatureFlagsService) {}

  @Get()
  async list(): Promise<{ data: FeatureFlagView[] }> {
    return { data: await this.flags.list() };
  }

  @Post(':key')
  @HttpCode(200)
  @UseGuards(StepUpGuard)
  set(
    @Param('key') key: string,
    @Body() body: unknown,
    @Req() request: Request,
  ): Promise<FeatureFlagView> {
    const input = parseBody(switchBody, body);
    return this.flags.set(
      { accountId: sessionOf(request).accountId, requestId: contextOf(request).requestId },
      key,
      input,
    );
  }
}
