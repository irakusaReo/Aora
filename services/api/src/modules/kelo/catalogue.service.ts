import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { Database, type Tx } from '../../platform/database.js';
import { AppError } from '../../platform/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { TenancyService } from '../tenancy/tenancy.service.js';
import {
  IMAGE_STORE,
  type ImageStore,
  type ImageType,
  IMAGE_MAX_BYTES,
  type UploadGrant,
} from './images.js';
import { currentCategory } from './stores.service.js';

export type ListingStatus = 'draft' | 'in_review' | 'published' | 'rejected' | 'suspended';
export type ListingType = 'stock_item' | 'scheduled_service' | 'quote_service';

/** Every legal status change of a listing (ADR 0017). */
export const LISTING_TRANSITIONS: Readonly<Record<ListingStatus, readonly ListingStatus[]>> = {
  draft: ['in_review'],
  in_review: ['published', 'rejected'],
  rejected: ['draft'],
  published: ['suspended', 'in_review'],
  suspended: ['in_review'],
};

/** An upload grant lasts long enough to pick and send a photo, and no longer. */
const UPLOAD_GRANT_SECONDS = 10 * 60;
const EXTENSION: Record<ImageType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

interface Actor {
  readonly tenantId: string;
  readonly accountId: string;
  readonly requestId: string;
}

type Listing = Prisma.listingGetPayload<{
  include: { listing_variant: true; listing_session: true; listing_image: true };
}>;

export interface ListingView {
  readonly id: string;
  readonly status: ListingStatus;
  readonly category: string;
  readonly type: ListingType;
  readonly title: string;
  readonly description: string;
  readonly currency: string;
  readonly revision: number;
  readonly variants: {
    id: string;
    name: string;
    price_minor: string;
    stock_on_hand: number;
    stock_reserved: number;
  }[];
  readonly sessions: {
    id: string;
    starts_at: string;
    price_minor: string;
    capacity: number;
    reserved: number;
  }[];
  readonly images: { id: string; url: string; content_type: string; size_bytes: number }[];
  readonly published_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** What anyone may see of a published listing. No stock counts, no merchant internals. */
export interface PublicListingView {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly category: string;
  readonly type: ListingType;
  readonly currency: string;
  readonly store: { display_name: string };
  readonly from_price_minor: string | null;
  readonly variants: { id: string; name: string; price_minor: string; in_stock: boolean }[];
  readonly sessions: { id: string; starts_at: string; price_minor: string; available: boolean }[];
  readonly images: { url: string }[];
}

export interface PublicListingSummary {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly type: ListingType;
  readonly currency: string;
  readonly store_name: string;
  readonly from_price_minor: string | null;
  readonly image_url: string | null;
}

const INCLUDE = {
  listing_variant: { orderBy: { created_at: 'asc' } },
  listing_session: { orderBy: { starts_at: 'asc' } },
  listing_image: { orderBy: { position: 'asc' } },
} as const;

function view(row: Listing): ListingView {
  return {
    id: row.id,
    status: row.status as ListingStatus,
    category: row.category_slug,
    type: row.type as ListingType,
    title: row.title,
    description: row.description,
    currency: row.currency,
    revision: row.revision,
    variants: row.listing_variant.map((variant) => ({
      id: variant.id,
      name: variant.name,
      price_minor: variant.price_minor.toString(),
      stock_on_hand: variant.stock_on_hand,
      stock_reserved: variant.stock_reserved,
    })),
    sessions: row.listing_session.map((session) => ({
      id: session.id,
      starts_at: session.starts_at.toISOString(),
      price_minor: session.price_minor.toString(),
      capacity: session.capacity,
      reserved: session.reserved,
    })),
    images: row.listing_image.map((image) => ({
      id: image.id,
      url: image.url,
      content_type: image.content_type,
      size_bytes: image.size_bytes,
    })),
    published_at: row.published_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

/** Lower-cased words separated by single spaces, padded, so a term matches whole words only. */
function words(text: string): string {
  return ` ${text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()} `;
}

function lowestPrice(prices: bigint[]): bigint | null {
  return prices.reduce<bigint | null>(
    (low, price) => (low === null || price < low ? price : low),
    null,
  );
}

/**
 * The KELO catalogue (ADR 0017): listings with stock or capacity, prohibited
 * items, moderation and images. Every write names the tenant; reads by members
 * go through row-level security.
 */
@Injectable()
export class CatalogueService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(TenancyService) private readonly tenancy: TenancyService,
    @Inject(IMAGE_STORE) private readonly images: ImageStore,
  ) {}

  async categories(): Promise<
    { slug: string; name: string; version: number; listing_types: string[]; restricted: boolean }[]
  > {
    return this.db.asPlatform(async (tx) => {
      const now = new Date();
      const rows = await tx.category.findMany({
        where: {
          effective_from: { lte: now },
          OR: [{ effective_to: null }, { effective_to: { gt: now } }],
        },
        orderBy: [{ slug: 'asc' }, { version: 'desc' }],
        distinct: ['slug'],
      });
      return rows.map((row) => ({
        slug: row.slug,
        name: row.name,
        version: row.version,
        listing_types: row.listing_types,
        restricted: row.restricted,
      }));
    });
  }

  // --- Merchant side ---

  /** The store linked to a workspace, or `store: null` when it has none. */
  async workspaceStore(tenantId: string): Promise<{
    store: {
      id: string;
      display_name: string;
      categories: { slug: string; name: string; listing_types: string[] }[];
    } | null;
  }> {
    return this.db.withTenant(tenantId, async (tx) => {
      const store = await tx.store.findFirst({
        where: { tenant_id: tenantId, status: 'approved' },
      });
      if (!store) return { store: null };
      const categories = [];
      for (const slug of store.category_slugs) {
        const category = await currentCategory(tx, slug);
        if (category) {
          categories.push({ slug, name: category.name, listing_types: category.listing_types });
        }
      }
      return { store: { id: store.id, display_name: store.display_name, categories } };
    });
  }

  async create(
    actor: Actor,
    input: {
      category: string;
      type: ListingType;
      title: string;
      description: string;
      currency: string;
    },
  ): Promise<ListingView> {
    return this.db.asPlatform(async (tx) => {
      const store = await this.storeOf(tx, actor.tenantId);
      const permitted = await tx.store_category.findUnique({
        where: { store_id_category_slug: { store_id: store.id, category_slug: input.category } },
      });
      if (!permitted) {
        throw new AppError('forbidden', 'This store was not vetted for that category.');
      }
      const category = await currentCategory(tx, input.category);
      if (!category) throw new AppError('invalid_request', 'Invalid request: category.');
      if (!category.listing_types.includes(input.type)) {
        throw new AppError(
          'invalid_request',
          'Invalid request: type is not allowed in this category.',
        );
      }
      const asset = await tx.asset.findUnique({ where: { code: input.currency } });
      if (!asset || asset.kind !== 'fiat') {
        throw new AppError('invalid_request', 'Invalid request: currency.');
      }
      const created = await tx.listing.create({
        data: {
          tenant_id: actor.tenantId,
          store_id: store.id,
          category_slug: category.slug,
          category_version: category.version,
          type: input.type,
          title: input.title,
          description: input.description,
          currency: input.currency,
        },
        include: INCLUDE,
      });
      await this.recordAudit(tx, actor, 'kelo.listing.created', created.id, {
        category: category.slug,
      });
      return view(created);
    });
  }

  async list(tenantId: string): Promise<ListingView[]> {
    const rows = await this.db.withTenant(tenantId, (tx) =>
      tx.listing.findMany({
        where: { tenant_id: tenantId },
        orderBy: { created_at: 'desc' },
        include: INCLUDE,
        take: 200,
      }),
    );
    return rows.map(view);
  }

  async get(tenantId: string, listingId: string): Promise<ListingView> {
    const row = await this.db.withTenant(tenantId, (tx) =>
      tx.listing.findFirst({ where: { id: listingId, tenant_id: tenantId }, include: INCLUDE }),
    );
    if (!row) throw new AppError('not_found', 'Listing not found.');
    return view(row);
  }

  async update(
    actor: Actor,
    listingId: string,
    input: { title?: string; description?: string },
  ): Promise<ListingView> {
    return this.db.asPlatform(async (tx) => {
      const listing = await this.lock(tx, actor.tenantId, listingId);
      const title = input.title ?? listing.title;
      const description = input.description ?? listing.description;
      if (listing.status === 'published')
        await this.assertPermitted(tx, listing, title, description);
      const status = await this.statusAfterEdit(tx, listing, input.description !== undefined);
      await tx.listing.update({
        where: { id: listing.id },
        data: { title, description, status, revision: { increment: 1 } },
      });
      await this.recordAudit(tx, actor, 'kelo.listing.updated', listing.id, { status });
      return view(await this.reload(tx, listing.id));
    });
  }

  async addVariant(
    actor: Actor,
    listingId: string,
    input: { name: string; priceMinor: bigint; stockOnHand: number },
  ): Promise<ListingView['variants'][number]> {
    return this.db.asPlatform(async (tx) => {
      const listing = await this.lock(tx, actor.tenantId, listingId);
      if (listing.type !== 'stock_item') {
        throw new AppError('invalid_request', 'Only a stock item has variants.');
      }
      const created = await tx.listing_variant.create({
        data: {
          tenant_id: actor.tenantId,
          listing_id: listing.id,
          name: input.name,
          price_minor: input.priceMinor,
          stock_on_hand: input.stockOnHand,
        },
      });
      await this.afterOfferChange(tx, actor, listing, true);
      return {
        id: created.id,
        name: created.name,
        price_minor: created.price_minor.toString(),
        stock_on_hand: created.stock_on_hand,
        stock_reserved: created.stock_reserved,
      };
    });
  }

  async updateVariant(
    actor: Actor,
    listingId: string,
    variantId: string,
    input: { name?: string; priceMinor?: bigint; stockOnHand?: number },
  ): Promise<ListingView['variants'][number]> {
    return this.db.asPlatform(async (tx) => {
      const listing = await this.lock(tx, actor.tenantId, listingId);
      await tx.$queryRaw`select id from kelo.listing_variant where id = ${variantId}::uuid for update`;
      const variant = await tx.listing_variant.findFirst({
        where: { id: variantId, listing_id: listing.id, tenant_id: actor.tenantId },
      });
      if (!variant) throw new AppError('not_found', 'Variant not found.');
      if (input.stockOnHand !== undefined && input.stockOnHand < variant.stock_reserved) {
        throw new AppError('conflict', 'Stock cannot go below what is already reserved by orders.');
      }
      const updated = await tx.listing_variant.update({
        where: { id: variant.id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.priceMinor !== undefined ? { price_minor: input.priceMinor } : {}),
          ...(input.stockOnHand !== undefined ? { stock_on_hand: input.stockOnHand } : {}),
        },
      });
      const priceChanged =
        input.priceMinor !== undefined && input.priceMinor !== variant.price_minor;
      await this.afterOfferChange(tx, actor, listing, priceChanged);
      return {
        id: updated.id,
        name: updated.name,
        price_minor: updated.price_minor.toString(),
        stock_on_hand: updated.stock_on_hand,
        stock_reserved: updated.stock_reserved,
      };
    });
  }

  async addSession(
    actor: Actor,
    listingId: string,
    input: { startsAt: Date; priceMinor: bigint; capacity: number },
  ): Promise<ListingView['sessions'][number]> {
    return this.db.asPlatform(async (tx) => {
      const listing = await this.lock(tx, actor.tenantId, listingId);
      if (listing.type !== 'scheduled_service') {
        throw new AppError('invalid_request', 'Only a scheduled service has sessions.');
      }
      if (input.startsAt.getTime() <= Date.now()) {
        throw new AppError('invalid_request', 'Invalid request: starts_at must be in the future.');
      }
      const created = await tx.listing_session.create({
        data: {
          tenant_id: actor.tenantId,
          listing_id: listing.id,
          starts_at: input.startsAt,
          price_minor: input.priceMinor,
          capacity: input.capacity,
        },
      });
      await this.afterOfferChange(tx, actor, listing, true);
      return {
        id: created.id,
        starts_at: created.starts_at.toISOString(),
        price_minor: created.price_minor.toString(),
        capacity: created.capacity,
        reserved: created.reserved,
      };
    });
  }

  /** Sends a draft or a suspended listing to review, after every check that applies. */
  async submit(actor: Actor, listingId: string): Promise<ListingView> {
    return this.db.asPlatform(async (tx) => {
      const listing = await this.lock(tx, actor.tenantId, listingId);
      await this.tenancy.assertNotRestricted(tx, actor.tenantId, 'listing_suspended');
      const from = listing.status as ListingStatus;
      if (from !== 'draft' && from !== 'suspended') {
        throw new AppError('invalid_state_transition', `A ${from} listing cannot be submitted.`);
      }
      await this.assertPermitted(tx, listing, listing.title, listing.description);
      const full = await this.reload(tx, listing.id);
      if (listing.type === 'stock_item' && full.listing_variant.length === 0) {
        throw new AppError('invalid_request', 'A stock item needs at least one priced variant.');
      }
      if (
        listing.type === 'scheduled_service' &&
        !full.listing_session.some((session) => session.starts_at.getTime() > Date.now())
      ) {
        throw new AppError(
          'invalid_request',
          'A scheduled service needs at least one future session.',
        );
      }
      await this.move(tx, listing, 'in_review');
      await this.recordAudit(tx, actor, 'kelo.listing.submitted', listing.id, {});
      return view(await this.reload(tx, listing.id));
    });
  }

  async grantImageUpload(
    actor: Actor,
    listingId: string,
    input: { contentType: ImageType; sizeBytes: number },
  ): Promise<UploadGrant> {
    if (input.sizeBytes > IMAGE_MAX_BYTES) {
      throw new AppError('invalid_request', 'Invalid request: an image may be at most 4 MB.');
    }
    const listing = await this.db.asPlatform((tx) => this.lock(tx, actor.tenantId, listingId));
    const pathname = `kelo/${actor.tenantId}/${listing.id}/${randomUUID()}.${EXTENSION[input.contentType]}`;
    return this.images.grantUpload({
      pathname,
      contentType: input.contentType,
      validForSeconds: UPLOAD_GRANT_SECONDS,
    });
  }

  async attachImage(
    actor: Actor,
    listingId: string,
    pathname: string,
  ): Promise<ListingView['images'][number]> {
    const prefix = `kelo/${actor.tenantId}/${listingId}/`;
    if (!pathname.startsWith(prefix) || pathname.slice(prefix.length).includes('/')) {
      throw new AppError(
        'invalid_request',
        'Invalid request: pathname does not belong to this listing.',
      );
    }
    // Ask the store before taking a lock: this is a network call.
    const stored = await this.images.inspect(pathname);
    if (!stored) throw new AppError('not_found', 'No uploaded image at that pathname.');
    if (
      stored.size > IMAGE_MAX_BYTES ||
      !(['image/jpeg', 'image/png', 'image/webp'] as string[]).includes(stored.contentType)
    ) {
      throw new AppError(
        'invalid_request',
        'Invalid request: the uploaded file is not an allowed image.',
      );
    }
    return this.db.asPlatform(async (tx) => {
      const listing = await this.lock(tx, actor.tenantId, listingId);
      const position = await tx.listing_image.count({ where: { listing_id: listing.id } });
      const created = await tx.listing_image.create({
        data: {
          tenant_id: actor.tenantId,
          listing_id: listing.id,
          pathname,
          url: stored.url,
          content_type: stored.contentType,
          size_bytes: stored.size,
          position,
        },
      });
      await this.recordAudit(tx, actor, 'kelo.listing.image_attached', listing.id, {});
      return {
        id: created.id,
        url: created.url,
        content_type: created.content_type,
        size_bytes: created.size_bytes,
      };
    });
  }

  // --- Operator moderation ---

  async reviewQueue(status: ListingStatus): Promise<ListingView[]> {
    const rows = await this.db.asPlatform((tx) =>
      tx.listing.findMany({
        where: { status },
        orderBy: { updated_at: 'asc' },
        include: INCLUDE,
        take: 200,
      }),
    );
    return rows.map(view);
  }

  async moderate(
    actor: { accountId: string; requestId: string },
    listingId: string,
    decision: { outcome: 'approved' | 'rejected' | 'suspended'; reason: string },
  ): Promise<ListingView> {
    return this.db.asPlatform(async (tx) => {
      await tx.$queryRaw`select id from kelo.listing where id = ${listingId}::uuid for update`;
      const listing = await tx.listing.findUnique({ where: { id: listingId } });
      if (!listing) throw new AppError('not_found', 'Listing not found.');
      const to: ListingStatus =
        decision.outcome === 'approved'
          ? 'published'
          : decision.outcome === 'rejected'
            ? 'rejected'
            : 'suspended';
      await this.move(tx, listing, to);
      await tx.moderation_decision.create({
        data: {
          tenant_id: listing.tenant_id,
          listing_id: listing.id,
          listing_revision: listing.revision,
          outcome: decision.outcome,
          reason: decision.reason,
          decided_by: actor.accountId,
        },
      });
      await this.audit.record(tx, {
        tenantId: listing.tenant_id,
        actorKind: 'user',
        actorAccountId: actor.accountId,
        action: `kelo.listing.${decision.outcome}`,
        subjectType: 'kelo_listing',
        subjectId: listing.id,
        outcome: 'success',
        requestId: actor.requestId,
        detail: { reason: decision.reason, revision: listing.revision },
      });
      return view(await this.reload(tx, listing.id));
    });
  }

  // --- Marketplace (public) ---

  async search(input: {
    q: string | null;
    category: string | null;
    cursor: string | null;
    limit: number;
  }): Promise<{ data: PublicListingSummary[]; next_cursor: string | null }> {
    const after = input.cursor ? decodeCursor(input.cursor) : null;
    return this.db.asPlatform(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; published_at: Date }[]>`
        select l.id, l.published_at
          from kelo.listing l
         where l.status = 'published'
           and (${input.q}::text is null or l.search @@ plainto_tsquery('simple', ${input.q}::text))
           and (${input.category}::text is null or l.category_slug = ${input.category}::text)
           and (${after?.at ?? null}::timestamptz is null
                or (l.published_at, l.id) < (${after?.at ?? null}::timestamptz, ${after?.id ?? null}::uuid))
         order by l.published_at desc, l.id desc
         limit ${input.limit + 1}`;
      const page = rows.slice(0, input.limit);
      const listings = await tx.listing.findMany({
        where: { id: { in: page.map((row) => row.id) } },
        include: { ...INCLUDE, store: { select: { display_name: true } } },
      });
      const byId = new Map(listings.map((listing) => [listing.id, listing]));
      const data = page.flatMap((row) => {
        const listing = byId.get(row.id);
        if (!listing) return [];
        const prices = [
          ...listing.listing_variant.map((variant) => variant.price_minor),
          ...listing.listing_session
            .filter((session) => session.starts_at.getTime() > Date.now())
            .map((session) => session.price_minor),
        ];
        return [
          {
            id: listing.id,
            title: listing.title,
            category: listing.category_slug,
            type: listing.type as ListingType,
            currency: listing.currency,
            store_name: listing.store.display_name,
            from_price_minor: lowestPrice(prices)?.toString() ?? null,
            image_url: listing.listing_image[0]?.url ?? null,
          },
        ];
      });
      const last = page[page.length - 1];
      return {
        data,
        next_cursor:
          rows.length > input.limit && last ? encodeCursor(last.published_at, last.id) : null,
      };
    });
  }

  async published(listingId: string): Promise<PublicListingView> {
    const row = await this.db.asPlatform((tx) =>
      tx.listing.findFirst({
        where: { id: listingId, status: 'published' },
        include: { ...INCLUDE, store: { select: { display_name: true } } },
      }),
    );
    // Unpublished and missing look the same.
    if (!row) throw new AppError('not_found', 'Listing not found.');
    const sessions = row.listing_session.filter(
      (session) => session.starts_at.getTime() > Date.now(),
    );
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      category: row.category_slug,
      type: row.type as ListingType,
      currency: row.currency,
      store: { display_name: row.store.display_name },
      from_price_minor:
        lowestPrice([
          ...row.listing_variant.map((variant) => variant.price_minor),
          ...sessions.map((session) => session.price_minor),
        ])?.toString() ?? null,
      variants: row.listing_variant.map((variant) => ({
        id: variant.id,
        name: variant.name,
        price_minor: variant.price_minor.toString(),
        in_stock: variant.stock_on_hand > variant.stock_reserved,
      })),
      sessions: sessions.map((session) => ({
        id: session.id,
        starts_at: session.starts_at.toISOString(),
        price_minor: session.price_minor.toString(),
        available: session.capacity > session.reserved,
      })),
      images: row.listing_image.map((image) => ({ url: image.url })),
    };
  }

  // --- Internals ---

  private async storeOf(tx: Tx, tenantId: string): Promise<Prisma.storeGetPayload<object>> {
    const store = await tx.store.findFirst({
      where: { tenant_id: tenantId, status: 'approved', provisioning: { status: 'completed' } },
    });
    if (!store) throw new AppError('forbidden', 'This workspace has no approved KELO store.');
    return store;
  }

  private async lock(
    tx: Tx,
    tenantId: string,
    listingId: string,
  ): Promise<Prisma.listingGetPayload<object>> {
    await tx.$queryRaw`
      select id from kelo.listing where id = ${listingId}::uuid and tenant_id = ${tenantId}::uuid for update`;
    const listing = await tx.listing.findFirst({ where: { id: listingId, tenant_id: tenantId } });
    if (!listing) throw new AppError('not_found', 'Listing not found.');
    return listing;
  }

  private reload(tx: Tx, listingId: string): Promise<Listing> {
    return tx.listing.findUniqueOrThrow({ where: { id: listingId }, include: INCLUDE });
  }

  private async move(
    tx: Tx,
    listing: Prisma.listingGetPayload<object>,
    to: ListingStatus,
  ): Promise<void> {
    const from = listing.status as ListingStatus;
    if (!LISTING_TRANSITIONS[from].includes(to)) {
      throw new AppError(
        'invalid_state_transition',
        `Cannot move a listing from ${from} to ${to}.`,
      );
    }
    const updated = await tx.listing.updateMany({
      where: { id: listing.id, status: from },
      data: { status: to, ...(to === 'published' ? { published_at: new Date() } : {}) },
    });
    if (updated.count !== 1) {
      throw new AppError('invalid_state_transition', 'Listing status changed concurrently.');
    }
  }

  /**
   * After a merchant edit: a rejected listing becomes a draft again; a
   * published one in a restricted category goes back to review when what the
   * buyer relies on (price or description) changed.
   */
  private async statusAfterEdit(
    tx: Tx,
    listing: Prisma.listingGetPayload<object>,
    reliedOnChanged: boolean,
  ): Promise<ListingStatus> {
    const status = listing.status as ListingStatus;
    if (status === 'rejected') return 'draft';
    if (status === 'published' && reliedOnChanged) {
      const category = await tx.category.findUniqueOrThrow({
        where: { slug_version: { slug: listing.category_slug, version: listing.category_version } },
      });
      if (category.restricted) return 'in_review';
    }
    return status;
  }

  private async afterOfferChange(
    tx: Tx,
    actor: Actor,
    listing: Prisma.listingGetPayload<object>,
    priceChanged: boolean,
  ): Promise<void> {
    const status = await this.statusAfterEdit(tx, listing, priceChanged);
    await tx.listing.update({
      where: { id: listing.id },
      data: { status, revision: { increment: 1 } },
    });
    await this.recordAudit(tx, actor, 'kelo.listing.offer_changed', listing.id, { status });
  }

  /** Refuses text that names a prohibited item (configuration, ADR 0017). */
  private async assertPermitted(
    tx: Tx,
    listing: Prisma.listingGetPayload<object>,
    title: string,
    description: string,
  ): Promise<void> {
    const now = new Date();
    const terms = await tx.prohibited_term.findMany({
      where: {
        effective_from: { lte: now },
        AND: [
          { OR: [{ effective_to: null }, { effective_to: { gt: now } }] },
          { OR: [{ category_slug: null }, { category_slug: listing.category_slug }] },
        ],
      },
    });
    const text = words(`${title} ${description}`);
    const hit = terms.find((term) => text.includes(words(term.term)));
    if (hit) {
      throw new AppError(
        'prohibited_item',
        `This listing cannot be published: it describes a prohibited item (${hit.reason}).`,
      );
    }
  }

  private recordAudit(
    tx: Tx,
    actor: Actor,
    action: string,
    listingId: string,
    detail: Prisma.InputJsonObject,
  ): Promise<void> {
    return this.audit.record(tx, {
      tenantId: actor.tenantId,
      actorKind: 'user',
      actorAccountId: actor.accountId,
      action,
      subjectType: 'kelo_listing',
      subjectId: listingId,
      outcome: 'success',
      requestId: actor.requestId,
      detail,
    });
  }
}

function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { at: string; id: string } {
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!at || !id || Number.isNaN(Date.parse(at)) || !/^[0-9a-f-]{36}$/.test(id)) {
    throw new AppError('invalid_request', 'Invalid request: cursor.');
  }
  return { at, id };
}
