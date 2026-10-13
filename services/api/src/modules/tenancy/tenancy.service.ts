import { Inject, Injectable } from '@nestjs/common';
import { Database, type Tx } from '../../platform/database.js';
import { AppError } from '../../platform/errors.js';
import type { Membership, Role } from '../../platform/http.js';
import { AuditService } from '../audit/audit.service.js';

export interface MemberView {
  readonly id: string;
  readonly account_id: string;
  readonly role: string;
  readonly status: string;
  readonly branch_id: string | null;
  /** Last three digits only: enough to recognise a colleague, not a phone number. Empty if none. */
  readonly phone_hint: string;
}

export interface BranchView {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly created_at: string;
}

/** What a workspace's tier currently allows, in minor units of one asset. */
export interface TierLimits {
  readonly tier: string;
  readonly perTransactionMax: bigint;
  readonly dailyCollectionMax: bigint;
  readonly dailyPayoutMax: bigint;
}

interface Actor {
  readonly tenantId: string;
  readonly accountId: string;
  readonly requestId: string;
}

/** Workspaces and memberships. The tenant is the workspace. */
@Injectable()
export class TenancyService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async createWorkspace(tx: Tx, businessId: string): Promise<string> {
    const workspace = await tx.workspace.create({
      data: { business_id: businessId, product: 'kony' },
    });
    return workspace.id;
  }

  async addMember(tx: Tx, tenantId: string, accountId: string, role: Role): Promise<void> {
    await tx.membership.create({ data: { tenant_id: tenantId, account_id: accountId, role } });
  }

  /** Active memberships only: a removed member loses access on their next request. */
  async membershipsOf(tx: Tx, accountId: string): Promise<Membership[]> {
    const rows = await tx.membership.findMany({
      where: { account_id: accountId, status: 'active' },
    });
    return rows.map((row) => ({
      tenantId: row.tenant_id,
      role: row.role as Role,
      branchId: row.branch_id,
    }));
  }

  /**
   * Removes a closed account from every workspace. A workspace's last admin is
   * left in place, because the database refuses to leave a workspace without
   * one; that workspace then needs an operator.
   */
  async removeAllMemberships(tx: Tx, accountId: string): Promise<void> {
    await tx.$executeRaw`
      update tenancy.membership m set status = 'removed'
      where m.account_id = ${accountId}::uuid and m.status = 'active'
        and (m.role <> 'admin' or exists (
          select from tenancy.membership o
          where o.tenant_id = m.tenant_id and o.id <> m.id and o.role = 'admin' and o.status = 'active'))`;
  }

  async listMembers(tenantId: string): Promise<MemberView[]> {
    return this.db.asPlatform(async (tx) => {
      const rows = await tx.membership.findMany({
        where: { tenant_id: tenantId },
        include: { user_account: { select: { phone_e164: true } } },
        orderBy: { created_at: 'asc' },
      });
      return rows.map(toView);
    });
  }

  /** Adds a person to the workspace by phone number, creating their account if they have none. */
  async inviteMember(actor: Actor, phoneE164: string, role: Role): Promise<MemberView> {
    return this.db.asPlatform(async (tx) => {
      let account = await tx.user_account.findUnique({ where: { phone_e164: phoneE164 } });
      if (!account) {
        const person = await tx.person.create({ data: {} });
        account = await tx.user_account.create({
          data: { person_id: person.id, phone_e164: phoneE164 },
        });
      }
      const existing = await tx.membership.findUnique({
        where: { tenant_id_account_id: { tenant_id: actor.tenantId, account_id: account.id } },
      });
      if (existing) {
        throw new AppError('conflict', 'This person is already a member of the workspace.');
      }
      const member = await tx.membership.create({
        data: { tenant_id: actor.tenantId, account_id: account.id, role },
        include: { user_account: { select: { phone_e164: true } } },
      });
      await this.audit.record(tx, {
        tenantId: actor.tenantId,
        actorKind: 'user',
        actorAccountId: actor.accountId,
        action: 'tenancy.member.added',
        subjectType: 'membership',
        subjectId: member.id,
        outcome: 'success',
        requestId: actor.requestId,
        detail: { role },
      });
      return toView(member);
    });
  }

  async updateMember(
    actor: Actor,
    membershipId: string,
    change: { role?: Role; status?: 'removed'; branch_id?: string | null },
  ): Promise<MemberView> {
    try {
      return await this.db.asPlatform(async (tx) => {
        // Scoped to the caller's workspace: another tenant's member is simply not found.
        const current = await tx.membership.findFirst({
          where: { id: membershipId, tenant_id: actor.tenantId },
        });
        if (!current) throw new AppError('not_found', 'Member not found.');
        if (change.branch_id) {
          const branch = await tx.branch.findFirst({
            where: { id: change.branch_id, tenant_id: actor.tenantId, status: 'active' },
          });
          if (!branch) throw new AppError('invalid_request', 'Invalid request: branch_id.');
        }
        const member = await tx.membership.update({
          where: { id: current.id },
          data: change,
          include: { user_account: { select: { phone_e164: true } } },
        });
        await this.audit.record(tx, {
          tenantId: actor.tenantId,
          actorKind: 'user',
          actorAccountId: actor.accountId,
          action: change.status
            ? 'tenancy.member.removed'
            : change.role
              ? 'tenancy.member.role_changed'
              : 'tenancy.member.branch_changed',
          subjectType: 'membership',
          subjectId: member.id,
          outcome: 'success',
          requestId: actor.requestId,
          detail: {
            from_role: current.role,
            to_role: member.role,
            status: member.status,
            branch_id: member.branch_id,
          },
        });
        return toView(member);
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      // The database refuses to leave a workspace without an active admin.
      if (String(error).includes('active admin')) {
        throw new AppError(
          'invalid_state_transition',
          'A workspace must keep at least one active admin.',
        );
      }
      throw error;
    }
  }

  // --- Branches ---

  async listBranches(tenantId: string): Promise<BranchView[]> {
    const rows = await this.db.withTenant(tenantId, (tx) =>
      tx.branch.findMany({ orderBy: { created_at: 'asc' } }),
    );
    return rows.map(toBranchView);
  }

  async createBranch(actor: Actor, name: string): Promise<BranchView> {
    return this.db.asPlatform(async (tx) => {
      // Checked first, so that a duplicate is a clean answer and not an aborted transaction.
      const existing = await tx.$queryRaw<{ id: string }[]>`
        select id from tenancy.branch
        where tenant_id = ${actor.tenantId}::uuid and lower(btrim(name)) = lower(btrim(${name}))`;
      if (existing.length > 0) {
        throw new AppError('conflict', 'A branch with this name already exists.');
      }
      const branch = await tx.branch.create({ data: { tenant_id: actor.tenantId, name } });
      await this.audit.record(tx, {
        tenantId: actor.tenantId,
        actorKind: 'user',
        actorAccountId: actor.accountId,
        action: 'tenancy.branch.created',
        subjectType: 'branch',
        subjectId: branch.id,
        outcome: 'success',
        requestId: actor.requestId,
      });
      return toBranchView(branch);
    });
  }

  async updateBranch(
    actor: Actor,
    branchId: string,
    change: { name?: string; status?: 'active' | 'closed' },
  ): Promise<BranchView> {
    return this.db.asPlatform(async (tx) => {
      // Scoped to the caller's workspace: another tenant's branch is simply not found.
      const current = await tx.branch.findFirst({
        where: { id: branchId, tenant_id: actor.tenantId },
      });
      if (!current) throw new AppError('not_found', 'Branch not found.');
      if (change.name) {
        const clash = await tx.$queryRaw<{ id: string }[]>`
          select id from tenancy.branch
          where tenant_id = ${actor.tenantId}::uuid and id <> ${branchId}::uuid
            and lower(btrim(name)) = lower(btrim(${change.name}))`;
        if (clash.length > 0) {
          throw new AppError('conflict', 'A branch with this name already exists.');
        }
      }
      const branch = await tx.branch.update({ where: { id: current.id }, data: change });
      await this.audit.record(tx, {
        tenantId: actor.tenantId,
        actorKind: 'user',
        actorAccountId: actor.accountId,
        action: 'tenancy.branch.updated',
        subjectType: 'branch',
        subjectId: branch.id,
        outcome: 'success',
        requestId: actor.requestId,
        detail: { from_status: current.status, to_status: branch.status },
      });
      return toBranchView(branch);
    });
  }

  /** True if the branch belongs to the workspace and is open. Runs with the tenant role. */
  async isActiveBranch(tx: Tx, tenantId: string, branchId: string): Promise<boolean> {
    const branch = await tx.branch.findFirst({
      where: { id: branchId, tenant_id: tenantId, status: 'active' },
      select: { id: true },
    });
    return branch !== null;
  }

  /**
   * The limits of the workspace's tier for one asset: the newest version in
   * effect. Limits are data (lessons §7); with none configured, nothing is allowed.
   */
  async limitsFor(tx: Tx, tenantId: string, assetCode: string): Promise<TierLimits | null> {
    const workspace = await tx.workspace.findUnique({ where: { id: tenantId } });
    if (!workspace) return null;
    const limit = await tx.tier_limit.findFirst({
      where: { tier: workspace.tier, asset_code: assetCode, effective_from: { lte: new Date() } },
      orderBy: { version: 'desc' },
    });
    if (!limit) return null;
    return {
      tier: workspace.tier,
      perTransactionMax: limit.per_transaction_max,
      dailyCollectionMax: limit.daily_collection_max,
      dailyPayoutMax: limit.daily_payout_max,
    };
  }
}

function toBranchView(row: {
  id: string;
  name: string;
  status: string;
  created_at: Date;
}): BranchView {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    created_at: row.created_at.toISOString(),
  };
}

function toView(row: {
  id: string;
  account_id: string;
  role: string;
  status: string;
  branch_id: string | null;
  user_account: { phone_e164: string | null };
}): MemberView {
  return {
    id: row.id,
    account_id: row.account_id,
    role: row.role,
    status: row.status,
    branch_id: row.branch_id,
    phone_hint: row.user_account.phone_e164 ? `…${row.user_account.phone_e164.slice(-3)}` : '',
  };
}
