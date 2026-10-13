import { Inject, Injectable } from '@nestjs/common';
import { Database, type Tx } from '../../platform/database.js';
import { AppError } from '../../platform/errors.js';
import type { Membership, Role } from '../../platform/http.js';
import { APP_CONFIG, type AppConfig } from '../../platform/config.js';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { maskEmail } from '../notifications/templates.js';

export interface MemberView {
  readonly id: string;
  readonly account_id: string;
  readonly role: string;
  readonly status: string;
  readonly branch_id: string | null;
  readonly display_name: string | null;
  /** First letter and domain only. Empty if none. */
  readonly email_masked: string;
  /** Last three digits only: enough to recognise a colleague, not a phone number. Empty if none. */
  readonly phone_hint: string;
}

export interface WorkspaceView {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly country: string;
  readonly tier: string;
  readonly limits: {
    currency: string;
    per_transaction_max_minor: string;
    daily_collection_max_minor: string;
    daily_payout_max_minor: string;
  }[];
}

export interface InvitationView {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly branch_id: string | null;
  readonly status: string;
  readonly expires_at: string;
  readonly created_at: string;
}

/** An invitation as the invited person sees it. */
export interface MyInvitationView {
  readonly id: string;
  readonly workspace_id: string;
  readonly workspace_name: string;
  readonly role: string;
  readonly expires_at: string;
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
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async createWorkspace(tx: Tx, businessId: string, tier = 'tier_0'): Promise<string> {
    const workspace = await tx.workspace.create({
      data: { business_id: businessId, product: 'kony', tier },
    });
    return workspace.id;
  }

  /** The workspace as its members see it: whose it is and what its tier allows. */
  async workspaceDetails(tenantId: string): Promise<WorkspaceView> {
    return this.db.asPlatform(async (tx) => {
      const workspace = await tx.workspace.findUniqueOrThrow({
        where: { id: tenantId },
        include: { business: { select: { name: true, kind: true, country: true } } },
      });
      const limits = await tx.tier_limit.findMany({
        where: { tier: workspace.tier, effective_from: { lte: new Date() } },
        orderBy: { version: 'desc' },
        distinct: ['asset_code'],
      });
      return {
        id: workspace.id,
        name: workspace.business.name,
        kind: workspace.business.kind,
        country: workspace.business.country,
        tier: workspace.tier,
        limits: limits.map((row) => ({
          currency: row.asset_code,
          per_transaction_max_minor: row.per_transaction_max.toString(),
          daily_collection_max_minor: row.daily_collection_max.toString(),
          daily_payout_max_minor: row.daily_payout_max.toString(),
        })),
      };
    });
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
        include: { user_account: { select: MEMBER_CONTACT } },
        orderBy: { created_at: 'asc' },
      });
      return rows.map(toView);
    });
  }

  // --- Invitations (ADR 0019: people are identified by their sign-in email) ---

  async listInvitations(tenantId: string): Promise<InvitationView[]> {
    const rows = await this.db.withTenant(tenantId, (tx) =>
      tx.invitation.findMany({ orderBy: { created_at: 'desc' }, take: 200 }),
    );
    return rows.map(toInvitationView);
  }

  /**
   * Invites an email address to the workspace. Nothing is granted until the
   * person signs in with that address and accepts.
   */
  async invite(
    actor: Actor,
    input: { email: string; role: Role; branchId: string | null },
  ): Promise<InvitationView> {
    const email = input.email.trim().toLowerCase();
    return this.db.asPlatform(async (tx) => {
      if (input.branchId) {
        const branch = await tx.branch.findFirst({
          where: { id: input.branchId, tenant_id: actor.tenantId, status: 'active' },
        });
        if (!branch) throw new AppError('invalid_request', 'Invalid request: branch_id.');
      }
      const account = (
        await tx.$queryRaw<{ id: string }[]>`
          select id from identity.user_account where lower(email) = ${email} and status = 'active'`
      )[0];
      if (account) {
        const member = await tx.membership.findFirst({
          where: { tenant_id: actor.tenantId, account_id: account.id, status: 'active' },
        });
        if (member) {
          throw new AppError('conflict', 'This person is already a member of the workspace.');
        }
      }
      const open = await tx.invitation.findFirst({
        where: { tenant_id: actor.tenantId, email_lower: email, status: 'pending' },
      });
      if (open && open.expires_at > new Date()) {
        throw new AppError('conflict', 'This address already has an open invitation.');
      }
      // An expired invitation is closed so that a fresh one can replace it.
      if (open) await tx.invitation.update({ where: { id: open.id }, data: { status: 'revoked' } });

      const invitation = await tx.invitation.create({
        data: {
          tenant_id: actor.tenantId,
          email_lower: email,
          role: input.role,
          branch_id: input.branchId,
          invited_by: actor.accountId,
          expires_at: new Date(Date.now() + this.config.invitations.ttlHours * 3_600_000),
        },
      });
      await this.audit.record(tx, {
        tenantId: actor.tenantId,
        actorKind: 'user',
        actorAccountId: actor.accountId,
        action: 'tenancy.invitation.created',
        subjectType: 'invitation',
        subjectId: invitation.id,
        outcome: 'success',
        requestId: actor.requestId,
        detail: { role: input.role },
      });
      if (account) {
        const workspace = await tx.workspace.findUniqueOrThrow({
          where: { id: actor.tenantId },
          include: { business: { select: { name: true } } },
        });
        await this.notifications.notify(tx, {
          dedupeKey: `workspace.invitation:${invitation.id}`,
          accountId: account.id,
          tenantId: actor.tenantId,
          type: 'workspace.invitation',
          params: { workspace_name: workspace.business.name, role: input.role },
        });
      }
      return toInvitationView(invitation);
    });
  }

  async revokeInvitation(actor: Actor, invitationId: string): Promise<InvitationView> {
    return this.db.asPlatform(async (tx) => {
      const current = await tx.invitation.findFirst({
        where: { id: invitationId, tenant_id: actor.tenantId, status: 'pending' },
      });
      if (!current) throw new AppError('not_found', 'Invitation not found.');
      const invitation = await tx.invitation.update({
        where: { id: current.id },
        data: { status: 'revoked' },
      });
      await this.audit.record(tx, {
        tenantId: actor.tenantId,
        actorKind: 'user',
        actorAccountId: actor.accountId,
        action: 'tenancy.invitation.revoked',
        subjectType: 'invitation',
        subjectId: invitation.id,
        outcome: 'success',
        requestId: actor.requestId,
      });
      return toInvitationView(invitation);
    });
  }

  /** Open invitations addressed to the account's own sign-in email. */
  async invitationsFor(accountId: string): Promise<MyInvitationView[]> {
    return this.db.asPlatform(async (tx) => {
      const rows = await tx.$queryRaw<
        { id: string; tenant_id: string; name: string; role: string; expires_at: Date }[]
      >`
        select i.id, i.tenant_id, b.name, i.role, i.expires_at
        from tenancy.invitation i
        join tenancy.workspace w on w.id = i.tenant_id
        join business.business b on b.id = w.business_id
        join identity.user_account a on lower(a.email) = i.email_lower
        where a.id = ${accountId}::uuid and a.status = 'active'
          and i.status = 'pending' and i.expires_at > now()
        order by i.created_at`;
      return rows.map((row) => ({
        id: row.id,
        workspace_id: row.tenant_id,
        workspace_name: row.name,
        role: row.role,
        expires_at: row.expires_at.toISOString(),
      }));
    });
  }

  /**
   * Accepts an invitation as the signed-in account. Only the invited address
   * can accept; accepting twice gives the same membership. Anything else looks
   * like an invitation that does not exist.
   */
  async acceptInvitation(
    accountId: string,
    invitationId: string,
    requestId: string,
  ): Promise<{ workspace_id: string; role: string }> {
    return this.db.asPlatform(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        select i.id from tenancy.invitation i
        join identity.user_account a on lower(a.email) = i.email_lower
        where i.id = ${invitationId}::uuid and a.id = ${accountId}::uuid and a.status = 'active'
        for update of i`;
      const invitation = rows[0]
        ? await tx.invitation.findUniqueOrThrow({ where: { id: rows[0].id } })
        : null;
      if (invitation?.status === 'accepted' && invitation.accepted_by === accountId) {
        return { workspace_id: invitation.tenant_id, role: invitation.role };
      }
      if (invitation?.status !== 'pending' || invitation.expires_at <= new Date()) {
        throw new AppError('not_found', 'Invitation not found.');
      }
      // A person who was removed earlier is brought back, not duplicated.
      await tx.$executeRaw`
        insert into tenancy.membership (tenant_id, account_id, role, branch_id)
        values (${invitation.tenant_id}::uuid, ${accountId}::uuid, ${invitation.role},
                ${invitation.branch_id}::uuid)
        on conflict (tenant_id, account_id) do update
          set role = excluded.role, branch_id = excluded.branch_id, status = 'active'`;
      await tx.invitation.update({
        where: { id: invitation.id },
        data: { status: 'accepted', accepted_by: accountId },
      });
      await this.audit.record(tx, {
        tenantId: invitation.tenant_id,
        actorKind: 'user',
        actorAccountId: accountId,
        action: 'tenancy.invitation.accepted',
        subjectType: 'invitation',
        subjectId: invitation.id,
        outcome: 'success',
        requestId,
        detail: { role: invitation.role },
      });
      return { workspace_id: invitation.tenant_id, role: invitation.role };
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
          include: { user_account: { select: MEMBER_CONTACT } },
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

const MEMBER_CONTACT = { phone_e164: true, email: true, display_name: true } as const;

function toInvitationView(row: {
  id: string;
  email_lower: string;
  role: string;
  branch_id: string | null;
  status: string;
  expires_at: Date;
  created_at: Date;
}): InvitationView {
  return {
    id: row.id,
    email: row.email_lower,
    role: row.role,
    branch_id: row.branch_id,
    // An invitation past its date is shown as expired; the row itself stays pending.
    status: row.status === 'pending' && row.expires_at <= new Date() ? 'expired' : row.status,
    expires_at: row.expires_at.toISOString(),
    created_at: row.created_at.toISOString(),
  };
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
  user_account: { phone_e164: string | null; email: string | null; display_name: string | null };
}): MemberView {
  return {
    id: row.id,
    account_id: row.account_id,
    role: row.role,
    status: row.status,
    branch_id: row.branch_id,
    display_name: row.user_account.display_name,
    email_masked: row.user_account.email ? maskEmail(row.user_account.email) : '',
    phone_hint: row.user_account.phone_e164 ? `…${row.user_account.phone_e164.slice(-3)}` : '',
  };
}
