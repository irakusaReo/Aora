import type { Prisma } from '../../generated/prisma/client.js';
import type { Tx } from '../../platform/database.js';
import { AppError } from '../../platform/errors.js';
import type { AuditService } from '../audit/audit.service.js';

// Payouts and refunds share one state machine (phase-3 plan §3). Like a
// payment intent: `submitting` is committed before the provider is called, so
// a crash mid-call never leads to a second call; `status_unknown` is never
// resubmitted; `reconciliation_required` has no automatic exit.

export type OperationStatus =
  | 'created'
  | 'submitting'
  | 'pending_provider'
  | 'succeeded'
  | 'failed'
  | 'status_unknown'
  | 'reconciliation_required';

export type OperationSource = 'api' | 'adapter' | 'webhook' | 'inquiry';

export const OPERATION_TRANSITIONS: Readonly<Record<OperationStatus, readonly OperationStatus[]>> =
  {
    created: ['submitting', 'failed', 'reconciliation_required'],
    submitting: [
      'pending_provider',
      'succeeded',
      'failed',
      'status_unknown',
      'reconciliation_required',
    ],
    pending_provider: ['succeeded', 'failed', 'reconciliation_required'],
    status_unknown: ['succeeded', 'failed', 'reconciliation_required'],
    succeeded: ['reconciliation_required'],
    failed: ['reconciliation_required'],
    reconciliation_required: [],
  };

export type OperationKind = 'payout' | 'refund';

interface Row {
  readonly id: string;
  readonly tenant_id: string;
  readonly status: string;
}

/** The one place a payout's or refund's status changes. */
export async function transitionOperation(
  tx: Tx,
  audit: AuditService,
  kind: OperationKind,
  row: Row,
  to: OperationStatus,
  source: OperationSource,
  reason: string | null,
  data: Prisma.InputJsonObject = {},
): Promise<void> {
  const from = row.status as OperationStatus;
  if (!OPERATION_TRANSITIONS[from].includes(to)) {
    throw new AppError('invalid_state_transition', `Cannot move a ${kind} from ${from} to ${to}.`);
  }
  const updated =
    kind === 'payout'
      ? await tx.payout.updateMany({
          where: { id: row.id, status: from },
          data: { status: to, ...data },
        })
      : await tx.refund.updateMany({
          where: { id: row.id, status: from },
          data: { status: to, ...data },
        });
  if (updated.count !== 1) {
    throw new AppError('invalid_state_transition', `The ${kind} changed concurrently.`);
  }
  await tx.operation_transition.create({
    data: {
      operation_type: kind,
      operation_id: row.id,
      tenant_id: row.tenant_id,
      from_status: from,
      to_status: to,
      source,
      reason,
    },
  });
  await audit.record(tx, {
    tenantId: row.tenant_id,
    actorKind: source === 'webhook' || source === 'inquiry' ? 'provider' : 'system',
    action: `payments.${kind}.${to}`,
    subjectType: kind,
    subjectId: row.id,
    outcome: 'success',
    detail: { from, to, ...(reason ? { reason } : {}) },
  });
}

/** `"150.00"`, 2 → 15000n, exactly. Null if the text is not a decimal or has more precision than the asset. */
export function decimalTextToMinor(text: string | null, exponent: number): bigint | null {
  if (text === null) return null;
  const match = /^([0-9]+)(?:\.([0-9]+))?$/.exec(text);
  if (!match) return null;
  const fraction = (match[2] ?? '').replace(/0+$/, '');
  if (fraction.length > exponent) return null;
  return BigInt((match[1] ?? '0') + fraction.padEnd(exponent, '0'));
}
