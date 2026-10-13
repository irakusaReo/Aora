import {
  Body,
  Controller,
  Delete,
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
import {
  type BranchView,
  type InvitationView,
  type MemberView,
  type MyInvitationView,
  TenancyService,
  type WorkspaceView,
} from './tenancy.service.js';

const role = z.enum(['admin', 'finance', 'cashier']);
const inviteBody = z.strictObject({
  email: z.email().max(254),
  role,
  branch_id: z.uuid().optional(),
});
// Exactly one change per request: a role, a removal, or a branch assignment (null clears it).
const updateBody = z
  .strictObject({
    role: role.optional(),
    status: z.literal('removed').optional(),
    branch_id: z.uuid().nullable().optional(),
  })
  .refine((value) => Object.values(value).filter((entry) => entry !== undefined).length === 1);
const branchName = z.string().trim().min(1).max(80);
const createBranchBody = z.strictObject({ name: branchName });
const updateBranchBody = z
  .strictObject({ name: branchName.optional(), status: z.enum(['active', 'closed']).optional() })
  .refine((value) => value.name !== undefined || value.status !== undefined);
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
    return this.tenancy.updateMember(actorOf(request), id, {
      ...(input.role ? { role: input.role } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.branch_id !== undefined ? { branch_id: input.branch_id } : {}),
    });
  }
}

@Controller('v1/workspace/invitations')
@UseGuards(SessionGuard, WorkspaceGuard)
export class InvitationsController {
  constructor(@Inject(TenancyService) private readonly tenancy: TenancyService) {}

  @Get()
  @Permit('member.read')
  async list(@Req() request: Request): Promise<{ data: InvitationView[] }> {
    return { data: await this.tenancy.listInvitations(tenantOf(request).tenantId) };
  }

  /** Inviting someone is the first step of giving them authority: a sensitive action. */
  @Post()
  @HttpCode(201)
  @Permit('member.manage')
  @UseGuards(StepUpGuard)
  create(@Body() body: unknown, @Req() request: Request): Promise<InvitationView> {
    const input = parseBody(inviteBody, body);
    return this.tenancy.invite(actorOf(request), {
      email: input.email,
      role: input.role,
      branchId: input.branch_id ?? null,
    });
  }

  @Delete(':id')
  @Permit('member.manage')
  @UseGuards(StepUpGuard)
  revoke(@Param('id') id: string, @Req() request: Request): Promise<InvitationView> {
    if (!UUID.test(id)) throw new AppError('not_found', 'Invitation not found.');
    return this.tenancy.revokeInvitation(actorOf(request), id);
  }
}

/** Invitations as the invited person sees them: no workspace is selected yet. */
@Controller('v1/me/invitations')
@UseGuards(SessionGuard)
export class MyInvitationsController {
  constructor(@Inject(TenancyService) private readonly tenancy: TenancyService) {}

  @Get()
  async list(@Req() request: Request): Promise<{ data: MyInvitationView[] }> {
    return { data: await this.tenancy.invitationsFor(sessionOf(request).accountId) };
  }

  @Post(':id/accept')
  @HttpCode(200)
  accept(
    @Param('id') id: string,
    @Req() request: Request,
  ): Promise<{ workspace_id: string; role: string }> {
    if (!UUID.test(id)) throw new AppError('not_found', 'Invitation not found.');
    return this.tenancy.acceptInvitation(
      sessionOf(request).accountId,
      id,
      contextOf(request).requestId,
    );
  }
}

@Controller('v1/workspace')
@UseGuards(SessionGuard, WorkspaceGuard)
export class WorkspaceController {
  constructor(@Inject(TenancyService) private readonly tenancy: TenancyService) {}

  @Get()
  @Permit('workspace.read')
  get(@Req() request: Request): Promise<WorkspaceView> {
    return this.tenancy.workspaceDetails(tenantOf(request).tenantId);
  }
}

@Controller('v1/workspace/branches')
@UseGuards(SessionGuard, WorkspaceGuard)
export class BranchesController {
  constructor(@Inject(TenancyService) private readonly tenancy: TenancyService) {}

  @Get()
  @Permit('branch.read')
  async list(@Req() request: Request): Promise<{ data: BranchView[] }> {
    return { data: await this.tenancy.listBranches(tenantOf(request).tenantId) };
  }

  @Post()
  @HttpCode(201)
  @Permit('branch.manage')
  create(@Body() body: unknown, @Req() request: Request): Promise<BranchView> {
    const input = parseBody(createBranchBody, body);
    return this.tenancy.createBranch(actorOf(request), input.name);
  }

  @Patch(':id')
  @Permit('branch.manage')
  update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: Request,
  ): Promise<BranchView> {
    const input = parseBody(updateBranchBody, body);
    if (!UUID.test(id)) throw new AppError('not_found', 'Branch not found.');
    return this.tenancy.updateBranch(actorOf(request), id, {
      ...(input.name ? { name: input.name } : {}),
      ...(input.status ? { status: input.status } : {}),
    });
  }
}

function actorOf(request: Request): { tenantId: string; accountId: string; requestId: string } {
  return {
    tenantId: tenantOf(request).tenantId,
    accountId: sessionOf(request).accountId,
    requestId: contextOf(request).requestId,
  };
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
