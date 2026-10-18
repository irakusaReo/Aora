import type { Prisma } from '../../generated/prisma/client.js';
import type { Tx } from '../../platform/database.js';
import { AppError } from '../../platform/errors.js';

// Chain operation state machine (brief §3.4, ADR 0004, phase-5 plan §3).
// `submitted` is committed, with the signed transaction, its hash and nonce,
// before the RPC is called, so a crash is always recoverable by query.
// `status_unknown` is never sent again: only a query by hash or by the sender's
// nonce moves it on. `reconciliation_required` has no automatic exit.

export type ChainOperationStatus =
  | 'prepared'
  | 'authorization_pending'
  | 'submitted'
  | 'pending_confirmation'
  | 'confirmed'
  | 'failed'
  | 'reverted'
  | 'status_unknown'
  | 'reconciliation_required';

export type ChainTransitionSource = 'api' | 'submitter' | 'monitor' | 'operator';

export const CHAIN_TRANSITIONS: Readonly<
  Record<ChainOperationStatus, readonly ChainOperationStatus[]>
> = {
  prepared: ['authorization_pending', 'submitted', 'failed', 'reconciliation_required'],
  authorization_pending: ['submitted', 'failed', 'reconciliation_required'],
  submitted: [
    'pending_confirmation',
    'confirmed',
    'reverted',
    'failed',
    'status_unknown',
    'reconciliation_required',
  ],
  pending_confirmation: ['confirmed', 'reverted', 'status_unknown', 'reconciliation_required'],
  status_unknown: ['pending_confirmation', 'confirmed', 'reverted', 'reconciliation_required'],
  confirmed: ['reconciliation_required'],
  reverted: ['reconciliation_required'],
  failed: ['reconciliation_required'],
  reconciliation_required: [],
};

interface Row {
  readonly id: string;
  readonly tenant_id: string | null;
  readonly status: string;
}

/** The one place a chain operation's status changes; every change is recorded. */
export async function transitionChainOperation(
  tx: Tx,
  row: Row,
  to: ChainOperationStatus,
  source: ChainTransitionSource,
  reason: string | null,
  data: Prisma.operationUncheckedUpdateManyInput = {},
): Promise<void> {
  const from = row.status as ChainOperationStatus;
  if (!CHAIN_TRANSITIONS[from].includes(to)) {
    throw new AppError(
      'invalid_state_transition',
      `Cannot move a chain operation from ${from} to ${to}.`,
    );
  }
  const updated = await tx.operation.updateMany({
    where: { id: row.id, status: from },
    data: { ...data, status: to },
  });
  if (updated.count !== 1) {
    throw new AppError('invalid_state_transition', 'The chain operation changed concurrently.');
  }
  await tx.transition.create({
    data: {
      operation_id: row.id,
      tenant_id: row.tenant_id,
      from_status: from,
      to_status: to,
      source,
      reason,
    },
  });
}
