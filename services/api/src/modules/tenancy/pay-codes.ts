import { randomInt } from 'node:crypto';
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
import { Database } from '../../platform/database.js';
import { AppError } from '../../platform/errors.js';
import { contextOf, parseBody, sessionOf, tenantOf } from '../../platform/http.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionGuard, WorkspaceGuard } from '../identity/guards.js';
import { Permit } from './permissions.js';
import { TenancyService } from './tenancy.service.js';

/** No 0/O or 1/I: a code is read aloud and typed from a sign at the till. */
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const PAY_CODE = /^[2-9A-HJ-NP-Z]{8}$/;

export interface PayCodeView {
  readonly code: string;
  readonly branch_id: string | null;
  readonly status: 'active' | 'inactive';
  readonly created_at: string;
}

function newCode(): string {
  return Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
}

/**
 * Merchant pay codes (phase-7 P7-3): how a CHIWO consumer names the merchant
 * they pay. A code reveals the trading name only; it grants nothing.
 */
@Injectable()
export class PayCodesService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(TenancyService) private readonly tenancy: TenancyService,
  ) {}

  async create(
    actor: { tenantId: string; accountId: string; requestId: string },
    branchId: string | null,
  ): Promise<PayCodeView> {
    return this.db.asPlatform(async (tx) => {
      if (branchId && !(await this.tenancy.isActiveBranch(tx, actor.tenantId, branchId))) {
        throw new AppError('invalid_request', 'Invalid request: branch_id.');
      }
      // 32^8 codes: a clash is rare, and is simply drawn again.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const code = newCode();
        const inserted = await tx.$queryRaw<{ code: string }[]>`
          insert into tenancy.pay_code (code, tenant_id, branch_id, created_by)
          values (${code}, ${actor.tenantId}::uuid, ${branchId}::uuid, ${actor.accountId}::uuid)
          on conflict (code) do nothing
          returning code`;
        if (inserted[0]) {
          await this.audit.record(tx, {
            tenantId: actor.tenantId,
            actorKind: 'user',
            actorAccountId: actor.accountId,
            action: 'tenancy.pay_code.created',
            subjectType: 'pay_code',
            subjectId: code,
            outcome: 'success',
            requestId: actor.requestId,
          });
          return view(await tx.pay_code.findUniqueOrThrow({ where: { code } }));
        }
      }
      throw new AppError('conflict', 'Could not allocate a pay code. Try again.');
    });
  }

  async list(tenantId: string): Promise<PayCodeView[]> {
    const rows = await this.db.withTenant(tenantId, (tx) =>
      tx.pay_code.findMany({ where: { tenant_id: tenantId }, orderBy: { created_at: 'asc' } }),
    );
    return rows.map(view);
  }

  async deactivate(
    actor: { tenantId: string; accountId: string; requestId: string },
    code: string,
  ): Promise<PayCodeView> {
    return this.db.asPlatform(async (tx) => {
      const row = await tx.pay_code.findFirst({ where: { code, tenant_id: actor.tenantId } });
      if (!row) throw new AppError('not_found', 'Pay code not found.');
      if (row.status === 'active') {
        await tx.pay_code.update({ where: { code }, data: { status: 'inactive' } });
        await this.audit.record(tx, {
          tenantId: actor.tenantId,
          actorKind: 'user',
          actorAccountId: actor.accountId,
          action: 'tenancy.pay_code.deactivated',
          subjectType: 'pay_code',
          subjectId: code,
          outcome: 'success',
          requestId: actor.requestId,
        });
      }
      return view(await tx.pay_code.findUniqueOrThrow({ where: { code } }));
    });
  }
}

function view(row: {
  code: string;
  branch_id: string | null;
  status: string;
  created_at: Date;
}): PayCodeView {
  return {
    code: row.code,
    branch_id: row.branch_id,
    status: row.status as PayCodeView['status'],
    created_at: row.created_at.toISOString(),
  };
}

const createBody = z.strictObject({ branch_id: z.uuid().optional() });

@Controller('v1/pay-codes')
@UseGuards(SessionGuard, WorkspaceGuard)
export class PayCodesController {
  constructor(@Inject(PayCodesService) private readonly payCodes: PayCodesService) {}

  @Get()
  @Permit('pay_code.read')
  async list(@Req() request: Request): Promise<{ data: PayCodeView[] }> {
    return { data: await this.payCodes.list(tenantOf(request).tenantId) };
  }

  @Post()
  @Permit('pay_code.manage')
  create(@Body() body: unknown, @Req() request: Request): Promise<PayCodeView> {
    const input = parseBody(createBody, body ?? {});
    return this.payCodes.create(
      {
        tenantId: tenantOf(request).tenantId,
        accountId: sessionOf(request).accountId,
        requestId: contextOf(request).requestId,
      },
      input.branch_id ?? null,
    );
  }

  @Post(':code/deactivate')
  @HttpCode(200)
  @Permit('pay_code.manage')
  deactivate(@Param('code') code: string, @Req() request: Request): Promise<PayCodeView> {
    if (!PAY_CODE.test(code)) throw new AppError('not_found', 'Pay code not found.');
    return this.payCodes.deactivate(
      {
        tenantId: tenantOf(request).tenantId,
        accountId: sessionOf(request).accountId,
        requestId: contextOf(request).requestId,
      },
      code,
    );
  }
}
