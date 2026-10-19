import type { Prisma } from '../../generated/prisma/client.js';
import type { Tx } from '../../platform/database.js';
import { AppError } from '../../platform/errors.js';

/**
 * What layaway and credit purchases share: one order machine (ADR 0017), one
 * reservation rule and one price lookup. No money moves here.
 */

export type PurchaseStatus =
  | 'placed'
  | 'payment_ready'
  | 'merchant_confirmed'
  | 'fulfilled'
  | 'completed'
  | 'cancelled'
  | 'return_requested'
  | 'returned'
  | 'disputed';
export type PlanType = 'layaway' | 'pay_in_n' | 'monthly_financing';

/**
 * ADR 0017's order machine as layaway and credit use it: delivery is one step
 * (no partial fulfilment), and a return or dispute (8C) can follow delivery;
 * a dispute can also come before it. A dispute returns to where it was, or
 * ends in a return or a cancellation.
 */
export const PURCHASE_TRANSITIONS: Readonly<Record<PurchaseStatus, readonly PurchaseStatus[]>> = {
  placed: ['payment_ready', 'cancelled'],
  payment_ready: ['merchant_confirmed', 'cancelled', 'disputed'],
  merchant_confirmed: ['fulfilled', 'cancelled', 'disputed'],
  fulfilled: ['completed'],
  completed: ['return_requested', 'disputed'],
  return_requested: ['returned', 'completed'],
  disputed: ['payment_ready', 'merchant_confirmed', 'completed', 'returned', 'cancelled'],
  returned: [],
  cancelled: [],
};

/** A refund to the buyer is submitted to the provider through the outbox (handled by layaway). */
export const EVENT_REFUND_SUBMIT = 'kelo.layaway.refund_submit';

export type PurchaseRow = Prisma.purchaseGetPayload<object>;
export type PlanTemplate = Prisma.plan_templateGetPayload<object>;

/** In effect at `now`: started, and not yet ended. Shared by every versioned table. */
export function effective(now: Date): {
  effective_from: { lte: Date };
  OR: ({ effective_to: null } | { effective_to: { gt: Date } })[];
} {
  return {
    effective_from: { lte: now },
    OR: [{ effective_to: null }, { effective_to: { gt: now } }],
  };
}

/** The newest version of each template the category allows, of the given plan types. */
export async function allowedTemplates(
  tx: Tx,
  categorySlug: string,
  planTypes: readonly PlanType[],
): Promise<PlanTemplate[]> {
  const now = new Date();
  const rules = await tx.category_plan_rule.findMany({
    where: { category_slug: categorySlug, ...effective(now) },
  });
  const keys = [...new Set(rules.map((rule) => rule.template_key))];
  return tx.plan_template.findMany({
    where: { key: { in: keys }, plan_type: { in: [...planTypes] }, ...effective(now) },
    orderBy: [{ key: 'asc' }, { version: 'desc' }],
    distinct: ['key'],
  });
}

/** The price of the chosen variant or future session of a listing. */
export async function priceOf(
  tx: Tx,
  listingId: string,
  choice: { variantId: string | null; sessionId: string | null },
): Promise<bigint> {
  if ((choice.variantId === null) === (choice.sessionId === null)) {
    throw new AppError(
      'invalid_request',
      'Invalid request: give exactly one of variant_id and session_id.',
    );
  }
  if (choice.variantId) {
    const variant = await tx.listing_variant.findFirst({
      where: { id: choice.variantId, listing_id: listingId },
    });
    if (!variant) throw new AppError('not_found', 'Variant not found.');
    return variant.price_minor;
  }
  const session = await tx.listing_session.findFirst({
    where: { id: choice.sessionId ?? '', listing_id: listingId, starts_at: { gt: new Date() } },
  });
  if (!session) throw new AppError('not_found', 'Session not found.');
  return session.price_minor;
}

/**
 * Reserves one unit in the same transaction as the order; the database refuses
 * a reservation beyond stock or capacity, so concurrent buyers cannot oversell.
 */
export async function reserve(
  tx: Tx,
  listingId: string,
  choice: { variantId: string | null; sessionId: string | null },
): Promise<void> {
  const reserved = choice.sessionId
    ? await tx.$executeRaw`
        update kelo.listing_session set reserved = reserved + 1
         where id = ${choice.sessionId}::uuid and listing_id = ${listingId}::uuid
           and reserved < capacity and starts_at > now()`
    : await tx.$executeRaw`
        update kelo.listing_variant set stock_reserved = stock_reserved + 1
         where id = ${choice.variantId}::uuid and listing_id = ${listingId}::uuid
           and stock_reserved < stock_on_hand`;
  if (reserved !== 1) throw new AppError('sold_out', 'This is no longer available.');
}

export async function release(tx: Tx, purchase: PurchaseRow): Promise<void> {
  if (purchase.session_id) {
    await tx.$executeRaw`update kelo.listing_session set reserved = reserved - 1 where id = ${purchase.session_id}::uuid`;
  } else if (purchase.variant_id) {
    await tx.$executeRaw`update kelo.listing_variant set stock_reserved = stock_reserved - 1 where id = ${purchase.variant_id}::uuid`;
  }
}

export async function purchaseEvent(
  tx: Tx,
  purchase: PurchaseRow,
  field: 'status' | 'plan_status',
  from: string | null,
  to: string,
  actorKind: 'user' | 'system' | 'provider',
  actorAccountId: string | null,
): Promise<void> {
  await tx.purchase_event.create({
    data: {
      tenant_id: purchase.tenant_id,
      purchase_id: purchase.id,
      field,
      from_value: from,
      to_value: to,
      actor_kind: actorKind,
      actor_account_id: actorAccountId,
    },
  });
}

export async function movePurchase(
  tx: Tx,
  purchase: PurchaseRow,
  to: PurchaseStatus,
  actorKind: 'user' | 'system',
  actorAccountId: string | null,
): Promise<void> {
  const from = purchase.status as PurchaseStatus;
  if (!PURCHASE_TRANSITIONS[from].includes(to)) {
    throw new AppError('invalid_state_transition', `Cannot move a purchase from ${from} to ${to}.`);
  }
  const updated = await tx.purchase.updateMany({
    where: { id: purchase.id, status: from },
    data: { status: to },
  });
  if (updated.count !== 1) {
    throw new AppError('invalid_state_transition', 'Purchase status changed concurrently.');
  }
  await purchaseEvent(tx, purchase, 'status', from, to, actorKind, actorAccountId);
}

export async function lockPurchaseForBuyer(
  tx: Tx,
  accountId: string,
  purchaseId: string,
): Promise<PurchaseRow> {
  await tx.$queryRaw`
    select id from kelo.purchase where id = ${purchaseId}::uuid and consumer_account_id = ${accountId}::uuid for update`;
  const row = await tx.purchase.findFirst({
    where: { id: purchaseId, consumer_account_id: accountId },
  });
  // Someone else's purchase looks like one that does not exist.
  if (!row) throw new AppError('not_found', 'Purchase not found.');
  return row;
}

export function payloadId(event: { id: string; payload: unknown }, key: string): string {
  const payload = event.payload as Record<string, unknown> | null;
  const value = payload?.[key];
  if (typeof value !== 'string') throw new Error(`Outbox event ${event.id} is missing ${key}.`);
  return value;
}
