import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import type { Tx } from '../../platform/database.js';

export interface AuditEntry {
  readonly tenantId?: string | null;
  readonly actorKind: 'user' | 'system' | 'provider';
  readonly actorAccountId?: string | null;
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly outcome: 'success' | 'denied' | 'failure';
  readonly requestId?: string | null;
  /** Never put secrets, codes, tokens or personal data here. */
  readonly detail?: Prisma.InputJsonObject;
}

/** Append-only audit trail. Written in the same transaction as the action it records. */
@Injectable()
export class AuditService {
  async record(tx: Tx, entry: AuditEntry): Promise<void> {
    await tx.audit_event.create({
      data: {
        tenant_id: entry.tenantId ?? null,
        actor_kind: entry.actorKind,
        actor_account_id: entry.actorAccountId ?? null,
        action: entry.action,
        subject_type: entry.subjectType,
        subject_id: entry.subjectId,
        outcome: entry.outcome,
        request_id: entry.requestId ?? null,
        detail: entry.detail ?? {},
      },
    });
  }
}
