import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client.js';
import { Database, type Tx } from '../../../platform/database.js';
import { AppError } from '../../../platform/errors.js';
import { AuditService } from '../../audit/audit.service.js';
import { FeatureFlagsService } from '../../ops/feature-flags.js';
import {
  lockPurchaseForBuyer,
  movePurchase,
  type PurchaseRow,
  type PurchaseStatus,
} from '../purchase-common.js';
import { nairobiToday } from '../schedule.js';
import { type AgreementStatus, CreditService } from './credit.service.js';

export type ClaimStatus = 'open' | 'accepted' | 'rejected' | 'withdrawn';
export type ClaimKind = 'return' | 'dispute';
export const CLAIM_REASONS = [
  'not_delivered',
  'not_as_described',
  'faulty',
  'changed_mind',
  'other',
] as const;
export type ClaimReason = (typeof CLAIM_REASONS)[number];

/** A claim is decided once (phase 8C). */
export const CLAIM_TRANSITIONS: Readonly<Record<ClaimStatus, readonly ClaimStatus[]>> = {
  open: ['accepted', 'rejected', 'withdrawn'],
  accepted: [],
  rejected: [],
  withdrawn: [],
};

type Claim = Prisma.purchase_claimGetPayload<object>;

/** What anyone on the order may see of a claim: never the buyer's identity or credit. */
export interface ClaimView {
  readonly id: string;
  readonly purchase_id: string;
  readonly kind: ClaimKind;
  readonly reason_code: ClaimReason;
  readonly details: string | null;
  readonly status: ClaimStatus;
  readonly decided_as: string | null;
  readonly decision_reason: string | null;
  readonly created_at: string;
  readonly decided_at: string | null;
}

function view(row: Claim): ClaimView {
  return {
    id: row.id,
    purchase_id: row.purchase_id,
    kind: row.kind as ClaimKind,
    reason_code: row.reason_code as ClaimReason,
    details: row.details,
    status: row.status as ClaimStatus,
    decided_as: row.decided_as,
    decision_reason: row.decision_reason,
    created_at: row.created_at.toISOString(),
    decided_at: row.decided_at?.toISOString() ?? null,
  };
}

/** Where a claim can be opened from: a return after delivery, a dispute once paid for. */
const OPENS_FROM: Readonly<Record<ClaimKind, readonly PurchaseStatus[]>> = {
  return: ['completed'],
  dispute: ['payment_ready', 'merchant_confirmed', 'completed'],
};

/**
 * Returns and disputes on KELO credit purchases (phase 8C; ADR 0017). An open
 * claim pauses every open part of the schedule: no reminders, no late charges,
 * no repayment. A return is decided by the merchant (accepting needs the
 * refund permission and a step-up), a dispute by a platform operator.
 * Accepted: the credit is undone by compensating entries and everything paid
 * is refunded (`CreditService.unwind`). Rejected or withdrawn: everything is
 * put back, and a part whose due date passed meanwhile gets its grace again.
 */
@Injectable()
export class ClaimsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(FeatureFlagsService) private readonly flags: FeatureFlagsService,
    @Inject(CreditService) private readonly credit: CreditService,
  ) {}

  async open(
    actor: { accountId: string; requestId: string },
    idempotencyKey: string,
    purchaseId: string,
    input: { kind: ClaimKind; reasonCode: ClaimReason; details: string | null },
  ): Promise<{ claim: ClaimView; replayed: boolean }> {
    await this.flags.require('kelo_credit');
    return this.db.asPlatform(async (tx) => {
      const earlier = await tx.purchase_claim.findUnique({
        where: {
          consumer_account_id_idempotency_key: {
            consumer_account_id: actor.accountId,
            idempotency_key: idempotencyKey,
          },
        },
      });
      if (earlier) {
        if (earlier.purchase_id !== purchaseId || earlier.kind !== input.kind) {
          throw new AppError(
            'idempotency_key_reused',
            'This Idempotency-Key was already used with a different request.',
          );
        }
        return { claim: view(earlier), replayed: true };
      }
      const purchase = await lockPurchaseForBuyer(tx, actor.accountId, purchaseId);
      if (purchase.plan_type === 'layaway') {
        throw new AppError(
          'invalid_request',
          'Returns and disputes are for KELO credit purchases.',
        );
      }
      if (
        await tx.purchase_claim.findFirst({ where: { purchase_id: purchase.id, status: 'open' } })
      ) {
        throw new AppError('invalid_state_transition', 'This purchase already has an open claim.');
      }
      if (!OPENS_FROM[input.kind].includes(purchase.status as PurchaseStatus)) {
        throw new AppError(
          'invalid_state_transition',
          input.kind === 'return'
            ? 'A return can be asked for once the item has been delivered.'
            : 'A dispute can be opened once the purchase is paid for.',
        );
      }
      const agreement = await this.credit.lockAgreementOf(tx, purchase.id);
      const lines = await tx.credit_instalment.findMany({ where: { agreement_id: agreement.id } });
      if (lines.some((line) => line.status === 'pending' || line.status === 'submitting')) {
        throw new AppError(
          'invalid_state_transition',
          'A payment is being checked. Try again once it has a result.',
        );
      }
      // Pause every open part, remembering how each was.
      const paused = lines
        .filter((line) => line.status === 'due' || line.status === 'late')
        .map((line) => ({ seq: line.seq, status: line.status }));
      await tx.credit_instalment.updateMany({
        where: { agreement_id: agreement.id, status: { in: ['due', 'late'] } },
        data: { status: 'paused' },
      });
      if (agreement.status === 'active' || agreement.status === 'defaulted') {
        await this.credit.moveAgreementAs(tx, agreement, 'paused', 'user', actor.accountId);
      }
      await movePurchase(
        tx,
        purchase,
        input.kind === 'return' ? 'return_requested' : 'disputed',
        'user',
        actor.accountId,
      );
      const created = await tx.purchase_claim.create({
        data: {
          tenant_id: purchase.tenant_id,
          purchase_id: purchase.id,
          consumer_account_id: actor.accountId,
          agreement_id: agreement.id,
          idempotency_key: idempotencyKey,
          kind: input.kind,
          reason_code: input.reasonCode,
          details: input.details,
          prior_purchase_status: purchase.status,
          prior_agreement_status: agreement.status,
          paused_lines: paused,
        },
      });
      await this.audit.record(tx, {
        tenantId: purchase.tenant_id,
        actorKind: 'user',
        actorAccountId: actor.accountId,
        action: 'kelo.claim.opened',
        subjectType: 'kelo_purchase_claim',
        subjectId: created.id,
        outcome: 'success',
        requestId: actor.requestId,
        detail: { kind: input.kind, reason_code: input.reasonCode },
      });
      return { claim: view(created), replayed: false };
    });
  }

  async withdraw(
    actor: { accountId: string; requestId: string },
    purchaseId: string,
    claimId: string,
  ): Promise<ClaimView> {
    await this.flags.require('kelo_credit');
    return this.db.asPlatform(async (tx) => {
      const purchase = await lockPurchaseForBuyer(tx, actor.accountId, purchaseId);
      const claim = await tx.purchase_claim.findFirst({
        where: { id: claimId, purchase_id: purchase.id },
      });
      if (!claim) throw new AppError('not_found', 'Claim not found.');
      await this.restore(tx, claim, purchase, 'user', actor.accountId);
      return this.decide(tx, claim, 'withdrawn', 'buyer', actor, null);
    });
  }

  /** The merchant accepts a return: refund permission and a step-up are checked by the route. */
  async merchantAccept(
    actor: { tenantId: string; accountId: string; requestId: string },
    claimId: string,
  ): Promise<ClaimView> {
    await this.flags.require('kelo_credit');
    return this.db.asPlatform(async (tx) => {
      const { claim, purchase } = await this.lockForMerchant(tx, actor.tenantId, claimId);
      const agreement = await this.credit.lockAgreementOf(tx, purchase.id);
      await this.credit.unwind(tx, purchase, agreement, {
        to: 'returned',
        actorKind: 'user',
        actorAccountId: actor.accountId,
      });
      return this.decide(tx, claim, 'accepted', 'merchant', actor, null);
    });
  }

  async merchantReject(
    actor: { tenantId: string; accountId: string; requestId: string },
    claimId: string,
    reason: string,
  ): Promise<ClaimView> {
    await this.flags.require('kelo_credit');
    return this.db.asPlatform(async (tx) => {
      const { claim, purchase } = await this.lockForMerchant(tx, actor.tenantId, claimId);
      await this.restore(tx, claim, purchase, 'user', actor.accountId);
      return this.decide(tx, claim, 'rejected', 'merchant', actor, reason);
    });
  }

  /** Open disputes, oldest first, for the operator queue. */
  async openDisputes(): Promise<(ClaimView & { workspace_id: string })[]> {
    const rows = await this.db.asPlatform((tx) =>
      tx.purchase_claim.findMany({
        where: { kind: 'dispute', status: 'open' },
        orderBy: { created_at: 'asc' },
        take: 200,
      }),
    );
    return rows.map((row) => ({ ...view(row), workspace_id: row.tenant_id }));
  }

  async operatorDecide(
    actor: { accountId: string; requestId: string },
    claimId: string,
    outcome: 'accepted' | 'rejected',
    reason: string,
  ): Promise<ClaimView> {
    await this.flags.require('kelo_credit');
    return this.db.asPlatform(async (tx) => {
      const found = await tx.purchase_claim.findUnique({ where: { id: claimId } });
      if (!found) throw new AppError('not_found', 'Claim not found.');
      await tx.$queryRaw`select id from kelo.purchase where id = ${found.purchase_id}::uuid for update`;
      const claim = await tx.purchase_claim.findUniqueOrThrow({ where: { id: claimId } });
      if (claim.kind !== 'dispute') {
        throw new AppError('invalid_state_transition', 'Returns are decided by the merchant.');
      }
      if (claim.status !== 'open') {
        throw new AppError('invalid_state_transition', 'This claim has already been decided.');
      }
      const purchase = await tx.purchase.findUniqueOrThrow({ where: { id: claim.purchase_id } });
      if (outcome === 'accepted') {
        const agreement = await this.credit.lockAgreementOf(tx, purchase.id);
        // Upheld after delivery it is a return; before delivery, a cancellation.
        await this.credit.unwind(tx, purchase, agreement, {
          to: claim.prior_purchase_status === 'completed' ? 'returned' : 'cancelled',
          actorKind: 'user',
          actorAccountId: actor.accountId,
        });
      } else {
        await this.restore(tx, claim, purchase, 'user', actor.accountId);
      }
      return this.decide(
        tx,
        claim,
        outcome,
        'operator',
        { ...actor, tenantId: purchase.tenant_id },
        reason,
      );
    });
  }

  /** The latest claim of each purchase, through the buyer's own barrier. */
  async forBuyer(accountId: string, purchaseIds: string[]): Promise<Map<string, ClaimView>> {
    if (purchaseIds.length === 0) return new Map();
    const rows = await this.db.withConsumer(accountId, (tx) =>
      tx.purchase_claim.findMany({
        where: { consumer_account_id: accountId, purchase_id: { in: purchaseIds } },
        orderBy: { created_at: 'asc' },
      }),
    );
    return new Map(rows.map((row) => [row.purchase_id, view(row)]));
  }

  /** The latest claim of each purchase, through the workspace's own barrier. */
  async forMerchant(tenantId: string, purchaseIds: string[]): Promise<Map<string, ClaimView>> {
    if (purchaseIds.length === 0) return new Map();
    const rows = await this.db.withTenant(tenantId, (tx) =>
      tx.purchase_claim.findMany({
        where: { tenant_id: tenantId, purchase_id: { in: purchaseIds } },
        orderBy: { created_at: 'asc' },
      }),
    );
    return new Map(rows.map((row) => [row.purchase_id, view(row)]));
  }

  // --- Internals ---

  /** An open return of this workspace; anyone else's looks like one that does not exist. */
  private async lockForMerchant(
    tx: Tx,
    tenantId: string,
    claimId: string,
  ): Promise<{ claim: Claim; purchase: PurchaseRow }> {
    const found = await tx.purchase_claim.findFirst({
      where: { id: claimId, tenant_id: tenantId },
    });
    if (!found) throw new AppError('not_found', 'Claim not found.');
    await tx.$queryRaw`select id from kelo.purchase where id = ${found.purchase_id}::uuid for update`;
    const claim = await tx.purchase_claim.findUniqueOrThrow({ where: { id: claimId } });
    if (claim.kind !== 'return') {
      throw new AppError(
        'invalid_state_transition',
        'A dispute is decided by KELO, not the merchant.',
      );
    }
    if (claim.status !== 'open') {
      throw new AppError('invalid_state_transition', 'This claim has already been decided.');
    }
    const purchase = await tx.purchase.findUniqueOrThrow({ where: { id: claim.purchase_id } });
    return { claim, purchase };
  }

  /** Puts the purchase, the agreement and every paused part back as they were. */
  private async restore(
    tx: Tx,
    claim: Claim,
    purchase: PurchaseRow,
    actorKind: 'user' | 'system',
    actorAccountId: string | null,
  ): Promise<void> {
    if (claim.status !== 'open') {
      throw new AppError('invalid_state_transition', 'This claim has already been decided.');
    }
    const today = new Date(`${nairobiToday()}T00:00:00Z`);
    for (const line of claim.paused_lines as { seq: number; status: string }[]) {
      await tx.credit_instalment.updateMany({
        where: { agreement_id: claim.agreement_id ?? '', seq: line.seq, status: 'paused' },
        // Lateness counts again from today, with the full grace period.
        data: { status: line.status, grace_from: today },
      });
    }
    if (claim.agreement_id) {
      const agreement = await this.credit.lockAgreementOf(tx, purchase.id);
      const prior = claim.prior_agreement_status as AgreementStatus | null;
      if (agreement.status === 'paused' && (prior === 'active' || prior === 'defaulted')) {
        await this.credit.moveAgreementAs(tx, agreement, prior, actorKind, actorAccountId);
      }
    }
    await movePurchase(
      tx,
      purchase,
      claim.prior_purchase_status as PurchaseStatus,
      actorKind,
      actorAccountId,
    );
  }

  private async decide(
    tx: Tx,
    claim: Claim,
    to: Exclude<ClaimStatus, 'open'>,
    as: 'merchant' | 'operator' | 'buyer',
    actor: { accountId: string; requestId: string; tenantId?: string },
    reason: string | null,
  ): Promise<ClaimView> {
    if (!CLAIM_TRANSITIONS[claim.status as ClaimStatus].includes(to)) {
      throw new AppError('invalid_state_transition', 'This claim has already been decided.');
    }
    const updated = await tx.purchase_claim.updateMany({
      where: { id: claim.id, status: 'open' },
      data: {
        status: to,
        decided_by: actor.accountId,
        decided_as: as,
        decision_reason: reason,
        decided_at: new Date(),
      },
    });
    if (updated.count !== 1) {
      throw new AppError('invalid_state_transition', 'This claim changed concurrently.');
    }
    await this.audit.record(tx, {
      tenantId: claim.tenant_id,
      actorKind: 'user',
      actorAccountId: actor.accountId,
      action: `kelo.claim.${to}`,
      subjectType: 'kelo_purchase_claim',
      subjectId: claim.id,
      outcome: 'success',
      requestId: actor.requestId,
      detail: { kind: claim.kind, decided_as: as, ...(reason ? { reason } : {}) },
    });
    return view(await tx.purchase_claim.findUniqueOrThrow({ where: { id: claim.id } }));
  }
}
