import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { Database } from '../../platform/database.js';
import { AppError } from '../../platform/errors.js';
import { AuditService } from '../audit/audit.service.js';

/** A merchant may hold a price for at most this long. */
const MAX_QUOTE_DAYS = 30;

export type QuoteStatus = 'offered' | 'accepted' | 'declined' | 'expired';

export interface QuoteView {
  readonly id: string;
  readonly price_minor: string;
  readonly currency: string;
  readonly expires_at: string;
  readonly status: QuoteStatus;
  readonly created_at: string;
}

export interface QuoteRequestView {
  readonly id: string;
  readonly listing_id: string;
  readonly listing_title: string;
  readonly details: string;
  readonly status: string;
  readonly quotes: QuoteView[];
  readonly created_at: string;
}

type Quote = Prisma.quoteGetPayload<object>;
type Request = Prisma.quote_requestGetPayload<{ include: { quote: true } }>;

function quoteView(row: Quote, now: Date): QuoteView {
  // Expiry is a fact of time, not a stored transition.
  const expired = row.status === 'offered' && row.expires_at <= now;
  return {
    id: row.id,
    price_minor: row.price_minor.toString(),
    currency: row.currency,
    expires_at: row.expires_at.toISOString(),
    status: expired ? 'expired' : (row.status as QuoteStatus),
    created_at: row.created_at.toISOString(),
  };
}

function requestView(row: Request, listingTitle: string): QuoteRequestView {
  const now = new Date();
  return {
    id: row.id,
    listing_id: row.listing_id,
    listing_title: listingTitle,
    details: row.details,
    status: row.status,
    quotes: [...row.quote]
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
      .map((quote) => quoteView(quote, now)),
    created_at: row.created_at.toISOString(),
  };
}

const INCLUDE = { quote: true, listing: true } as const;

/**
 * Quotes for quote-based services (ADR 0017). A buyer's rows are read under
 * the consumer barrier, a merchant's under the tenant barrier; writes go
 * through the platform role naming the owner in every statement.
 */
@Injectable()
export class QuotesService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async request(
    actor: { accountId: string; requestId: string },
    idempotencyKey: string,
    input: { listingId: string; details: string },
  ): Promise<{ request: QuoteRequestView; replayed: boolean }> {
    const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const result = await this.db.asPlatform(async (tx) => {
      const earlier = await tx.quote_request.findUnique({
        where: {
          consumer_account_id_idempotency_key: {
            consumer_account_id: actor.accountId,
            idempotency_key: idempotencyKey,
          },
        },
      });
      if (earlier) {
        if (earlier.request_hash !== requestHash) {
          throw new AppError(
            'idempotency_key_reused',
            'This Idempotency-Key was already used with a different request.',
          );
        }
        return { id: earlier.id, replayed: true };
      }
      const listing = await tx.listing.findFirst({
        where: { id: input.listingId, status: 'published' },
      });
      if (!listing) throw new AppError('not_found', 'Listing not found.');
      if (listing.type !== 'quote_service') {
        throw new AppError(
          'invalid_request',
          'This listing has a price; it does not take quote requests.',
        );
      }
      const created = await tx.quote_request.create({
        data: {
          tenant_id: listing.tenant_id,
          listing_id: listing.id,
          consumer_account_id: actor.accountId,
          idempotency_key: idempotencyKey,
          request_hash: requestHash,
          details: input.details,
        },
      });
      await this.audit.record(tx, {
        tenantId: listing.tenant_id,
        actorKind: 'user',
        actorAccountId: actor.accountId,
        action: 'kelo.quote.requested',
        subjectType: 'kelo_quote_request',
        subjectId: created.id,
        outcome: 'success',
        requestId: actor.requestId,
      });
      return { id: created.id, replayed: false };
    });
    const [request] = await this.mine(actor.accountId, result.id);
    if (!request) throw new AppError('internal_error', 'Quote request vanished.');
    return { request, replayed: result.replayed };
  }

  /** The buyer's own requests, under the consumer barrier. */
  async mine(accountId: string, onlyId?: string): Promise<QuoteRequestView[]> {
    const rows = await this.db.withConsumer(accountId, (tx) =>
      tx.quote_request.findMany({
        where: { consumer_account_id: accountId, ...(onlyId ? { id: onlyId } : {}) },
        include: { quote: true },
        orderBy: { created_at: 'desc' },
        take: 100,
      }),
    );
    // Listing titles are public facts of published listings; read them separately.
    const titles = await this.db.asPlatform((tx) =>
      tx.listing.findMany({
        where: { id: { in: rows.map((row) => row.listing_id) } },
        select: { id: true, title: true },
      }),
    );
    const titleOf = new Map(titles.map((row) => [row.id, row.title]));
    return rows.map((row) => requestView(row, titleOf.get(row.listing_id) ?? ''));
  }

  /** The merchant's inbox, under the tenant barrier. Nothing identifies the buyer. */
  async inbox(tenantId: string): Promise<QuoteRequestView[]> {
    const rows = await this.db.withTenant(tenantId, (tx) =>
      tx.quote_request.findMany({
        where: { tenant_id: tenantId },
        include: INCLUDE,
        orderBy: { created_at: 'desc' },
        take: 200,
      }),
    );
    return rows.map((row) => requestView(row, row.listing.title));
  }

  async quote(
    actor: { tenantId: string; accountId: string; requestId: string },
    requestId: string,
    input: { priceMinor: bigint; expiresAt: Date },
  ): Promise<QuoteView> {
    const now = Date.now();
    if (
      input.expiresAt.getTime() <= now ||
      input.expiresAt.getTime() > now + MAX_QUOTE_DAYS * 86_400_000
    ) {
      throw new AppError(
        'invalid_request',
        `Invalid request: expires_at must be within ${String(MAX_QUOTE_DAYS)} days.`,
      );
    }
    return this.db.asPlatform(async (tx) => {
      await tx.$queryRaw`
        select id from kelo.quote_request
         where id = ${requestId}::uuid and tenant_id = ${actor.tenantId}::uuid for update`;
      const request = await tx.quote_request.findFirst({
        where: { id: requestId, tenant_id: actor.tenantId },
        include: { listing: true },
      });
      if (!request) throw new AppError('not_found', 'Quote request not found.');
      if (request.status !== 'open' && request.status !== 'quoted') {
        throw new AppError('invalid_state_transition', 'This request is closed.');
      }
      const created = await tx.quote.create({
        data: {
          tenant_id: actor.tenantId,
          request_id: request.id,
          consumer_account_id: request.consumer_account_id,
          price_minor: input.priceMinor,
          currency: request.listing.currency,
          expires_at: input.expiresAt,
          created_by: actor.accountId,
        },
      });
      if (request.status === 'open') {
        await tx.quote_request.update({ where: { id: request.id }, data: { status: 'quoted' } });
      }
      await this.audit.record(tx, {
        tenantId: actor.tenantId,
        actorKind: 'user',
        actorAccountId: actor.accountId,
        action: 'kelo.quote.offered',
        subjectType: 'kelo_quote',
        subjectId: created.id,
        outcome: 'success',
        requestId: actor.requestId,
        detail: { price_minor: created.price_minor.toString(), currency: created.currency },
      });
      return quoteView(created, new Date());
    });
  }

  async decline(
    actor: { accountId: string; requestId: string },
    quoteId: string,
  ): Promise<QuoteView> {
    return this.db.asPlatform(async (tx) => {
      await tx.$queryRaw`
        select id from kelo.quote
         where id = ${quoteId}::uuid and consumer_account_id = ${actor.accountId}::uuid for update`;
      const quote = await tx.quote.findFirst({
        where: { id: quoteId, consumer_account_id: actor.accountId },
      });
      // Someone else's quote looks like one that does not exist.
      if (!quote) throw new AppError('not_found', 'Quote not found.');
      if (quote.status !== 'offered') {
        throw new AppError('invalid_state_transition', 'This quote has already been answered.');
      }
      if (quote.expires_at <= new Date()) {
        throw new AppError('invalid_state_transition', 'This quote has expired.');
      }
      const updated = await tx.quote.update({
        where: { id: quote.id },
        data: { status: 'declined', decided_at: new Date() },
      });
      await this.audit.record(tx, {
        tenantId: quote.tenant_id,
        actorKind: 'user',
        actorAccountId: actor.accountId,
        action: 'kelo.quote.declined',
        subjectType: 'kelo_quote',
        subjectId: quote.id,
        outcome: 'success',
        requestId: actor.requestId,
      });
      return quoteView(updated, new Date());
    });
  }
}
