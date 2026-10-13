import { Controller, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import { Database } from '../../platform/database.js';
import { AppError } from '../../platform/errors.js';
import { contextOf, parseBody, sessionOf } from '../../platform/http.js';
import { AuditService } from '../audit/audit.service.js';
import { OperatorGuard, SessionGuard } from '../identity/guards.js';

const accountQuery = z
  .strictObject({
    id: z.uuid().optional(),
    email: z.email().max(254).optional(),
    phone: z
      .string()
      .regex(/^\+[1-9][0-9]{7,14}$/)
      .optional(),
  })
  .refine((value) => Object.values(value).filter((entry) => entry !== undefined).length === 1);
const workspaceQuery = z
  .strictObject({ id: z.uuid().optional(), name: z.string().trim().min(2).max(120).optional() })
  .refine((value) => (value.id === undefined) !== (value.name === undefined));
const auditQuery = z.strictObject({
  workspace_id: z.uuid().optional(),
  subject_id: z.string().min(1).max(200).optional(),
  action: z.string().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const maskEmail = (email: string | null): string => {
  if (!email) return '';
  const at = email.lastIndexOf('@');
  return at < 1 ? '•••' : `${email.charAt(0)}•••${email.slice(at)}`;
};

interface AccountView {
  id: string;
  status: string;
  display_name: string | null;
  email_masked: string;
  phone_hint: string;
  is_platform_operator: boolean;
  created_at: string;
  memberships: { workspace_id: string; role: string; status: string }[];
}

interface WorkspaceRow {
  id: string;
  business_id: string;
  business_name: string;
  kind: string;
  country: string;
  tier: string;
  active_members: number;
  created_at: Date;
}

/**
 * Operator lookups (journey J5): find a user or a merchant, and read the audit
 * trail. Read-only. Contact details are always masked, and looking up a person
 * is itself recorded.
 */
@Controller('v1/ops')
@UseGuards(SessionGuard, OperatorGuard)
export class OpsLookupController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get('accounts')
  async accounts(
    @Query() query: unknown,
    @Req() request: Request,
  ): Promise<{ data: AccountView[] }> {
    const input = parseBody(accountQuery, query);
    const by = input.id ? 'id' : input.email ? 'email' : 'phone';
    return this.db.asPlatform(async (tx) => {
      const ids = await tx.$queryRaw<{ id: string }[]>`
        select id from identity.user_account
        where (${input.id ?? null}::uuid is not null and id = ${input.id ?? null}::uuid)
           or (${input.email ?? null}::text is not null and lower(email) = lower(${input.email ?? null}))
           or (${input.phone ?? null}::text is not null and phone_e164 = ${input.phone ?? null})
        limit 5`;
      const rows = await tx.user_account.findMany({
        where: { id: { in: ids.map((row) => row.id) } },
        include: { membership: { orderBy: { created_at: 'asc' } } },
      });
      await this.audit.record(tx, {
        actorKind: 'user',
        actorAccountId: sessionOf(request).accountId,
        action: 'ops.account.lookup',
        subjectType: 'user_account',
        subjectId: rows[0]?.id ?? 'none',
        outcome: 'success',
        requestId: contextOf(request).requestId,
        // How the search was made, never what was searched for.
        detail: { by, found: rows.length },
      });
      return {
        data: rows.map((row) => ({
          id: row.id,
          status: row.status,
          display_name: row.display_name,
          email_masked: maskEmail(row.email),
          phone_hint: row.phone_e164 ? `•••${row.phone_e164.slice(-3)}` : '',
          is_platform_operator: row.is_platform_operator,
          created_at: row.created_at.toISOString(),
          memberships: row.membership.map((entry) => ({
            workspace_id: entry.tenant_id,
            role: entry.role,
            status: entry.status,
          })),
        })),
      };
    });
  }

  @Get('workspaces')
  async workspaces(
    @Query() query: unknown,
  ): Promise<{ data: (Omit<WorkspaceRow, 'created_at'> & { created_at: string })[] }> {
    const input = parseBody(workspaceQuery, query);
    const pattern = input.name ? `%${input.name.replace(/[\\%_]/g, '\\$&')}%` : null;
    const rows = await this.db.asPlatform(
      (tx) => tx.$queryRaw<WorkspaceRow[]>`
        select w.id, b.id as business_id, b.name as business_name, b.kind, b.country, w.tier,
               (select count(*)::int from tenancy.membership m
                where m.tenant_id = w.id and m.status = 'active') as active_members,
               w.created_at
        from tenancy.workspace w join business.business b on b.id = w.business_id
        where (${input.id ?? null}::uuid is not null and w.id = ${input.id ?? null}::uuid)
           or (${pattern}::text is not null and b.name ilike ${pattern})
        order by w.created_at
        limit 50`,
    );
    return { data: rows.map((row) => ({ ...row, created_at: row.created_at.toISOString() })) };
  }

  @Get('audit-events')
  async auditEvents(@Query() query: unknown): Promise<{
    data: {
      id: string;
      occurred_at: string;
      workspace_id: string | null;
      actor_kind: string;
      actor_account_id: string | null;
      action: string;
      subject_type: string;
      subject_id: string;
      outcome: string;
      request_id: string | null;
      detail: Prisma.JsonValue;
    }[];
  }> {
    const input = parseBody(auditQuery, query);
    if (input.action && !/^[a-z0-9_.]+$/.test(input.action)) {
      throw new AppError('invalid_request', 'Invalid request: action.');
    }
    const rows = await this.db.asPlatform((tx) =>
      tx.audit_event.findMany({
        where: {
          ...(input.workspace_id ? { tenant_id: input.workspace_id } : {}),
          ...(input.subject_id ? { subject_id: input.subject_id } : {}),
          ...(input.action ? { action: input.action } : {}),
        },
        orderBy: [{ occurred_at: 'desc' }, { id: 'desc' }],
        take: input.limit,
      }),
    );
    return {
      data: rows.map((row) => ({
        id: row.id,
        occurred_at: row.occurred_at.toISOString(),
        workspace_id: row.tenant_id,
        actor_kind: row.actor_kind,
        actor_account_id: row.actor_account_id,
        action: row.action,
        subject_type: row.subject_type,
        subject_id: row.subject_id,
        outcome: row.outcome,
        request_id: row.request_id,
        detail: row.detail,
      })),
    };
  }
}
