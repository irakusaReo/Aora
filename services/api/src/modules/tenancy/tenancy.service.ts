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
  /** Last three digits only: enough to recognise a colleague, not a phone number. Empty if none. */
  readonly phone_hint: string;
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
    return rows.map((row) => ({ tenantId: row.tenant_id, role: row.role as Role }));
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
    change: { role?: Role; status?: 'removed' },
  ): Promise<MemberView> {
    try {
      return await this.db.asPlatform(async (tx) => {
        // Scoped to the caller's workspace: another tenant's member is simply not found.
        const current = await tx.membership.findFirst({
          where: { id: membershipId, tenant_id: actor.tenantId },
        });
        if (!current) throw new AppError('not_found', 'Member not found.');
        const member = await tx.membership.update({
          where: { id: current.id },
          data: change,
          include: { user_account: { select: { phone_e164: true } } },
        });
        await this.audit.record(tx, {
          tenantId: actor.tenantId,
          actorKind: 'user',
          actorAccountId: actor.accountId,
          action: change.status ? 'tenancy.member.removed' : 'tenancy.member.role_changed',
          subjectType: 'membership',
          subjectId: member.id,
          outcome: 'success',
          requestId: actor.requestId,
          detail: { from_role: current.role, to_role: member.role, status: member.status },
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
}

function toView(row: {
  id: string;
  account_id: string;
  role: string;
  status: string;
  user_account: { phone_e164: string | null };
}): MemberView {
  return {
    id: row.id,
    account_id: row.account_id,
    role: row.role,
    status: row.status,
    phone_hint: row.user_account.phone_e164 ? `…${row.user_account.phone_e164.slice(-3)}` : '',
  };
}
