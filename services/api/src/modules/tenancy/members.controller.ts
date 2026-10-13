import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { Database } from '../../platform/database.js';
import { AppError } from '../../platform/errors.js';
import { contextOf, parseBody, sessionOf, tenantOf } from '../../platform/http.js';
import { SessionGuard, StepUpGuard, WorkspaceGuard } from '../identity/guards.js';
import { Permit } from './permissions.js';
import { type MemberView, TenancyService } from './tenancy.service.js';

const role = z.enum(['admin', 'finance', 'cashier']);
const inviteBody = z.strictObject({ phone: z.string().regex(/^\+[1-9][0-9]{7,14}$/), role });
const updateBody = z
  .strictObject({ role: role.optional(), status: z.literal('removed').optional() })
  .refine((value) => (value.role === undefined) !== (value.status === undefined));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('v1/workspace/members')
@UseGuards(SessionGuard, WorkspaceGuard)
export class MembersController {
  constructor(@Inject(TenancyService) private readonly tenancy: TenancyService) {}

  @Get()
  @Permit('member.read')
  async list(@Req() request: Request): Promise<{ data: MemberView[] }> {
    return { data: await this.tenancy.listMembers(tenantOf(request).tenantId) };
  }

  /** Changing who has authority in a workspace is a sensitive action (brief §7.2). */
  @Post()
  @HttpCode(201)
  @Permit('member.manage')
  @UseGuards(StepUpGuard)
  invite(@Body() body: unknown, @Req() request: Request): Promise<MemberView> {
    const input = parseBody(inviteBody, body);
    return this.tenancy.inviteMember(this.actor(request), input.phone, input.role);
  }

  @Patch(':id')
  @Permit('member.manage')
  @UseGuards(StepUpGuard)
  update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: Request,
  ): Promise<MemberView> {
    const input = parseBody(updateBody, body);
    if (!UUID.test(id)) throw new AppError('not_found', 'Member not found.');
    return this.tenancy.updateMember(this.actor(request), id, {
      ...(input.role ? { role: input.role } : {}),
      ...(input.status ? { status: input.status } : {}),
    });
  }

  private actor(request: Request): { tenantId: string; accountId: string; requestId: string } {
    return {
      tenantId: tenantOf(request).tenantId,
      accountId: sessionOf(request).accountId,
      requestId: contextOf(request).requestId,
    };
  }
}

@Controller('v1/ledger')
@UseGuards(SessionGuard, WorkspaceGuard)
export class BalancesController {
  constructor(@Inject(Database) private readonly db: Database) {}

  /**
   * The workspace's ledger balances, read with the tenant role so row-level
   * security applies. Each account type is a distinct kind of balance and is
   * reported separately, never summed (CLAUDE.md rule 5).
   */
  @Get('balances')
  @Permit('ledger.read')
  async balances(
    @Req() request: Request,
  ): Promise<{ data: { account_type: string; currency: string; balance_minor: string }[] }> {
    const rows = await this.db.withTenant(tenantOf(request).tenantId, (tx) =>
      tx.account.findMany({ include: { account_balance: true }, orderBy: { type: 'asc' } }),
    );
    return {
      data: rows.map((row) => ({
        account_type: row.type,
        currency: row.asset_code,
        balance_minor: (row.account_balance?.balance ?? 0n).toString(),
      })),
    };
  }
}
