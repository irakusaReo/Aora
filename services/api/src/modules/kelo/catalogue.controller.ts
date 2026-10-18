import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AppError } from '../../platform/errors.js';
import { contextOf, parseBody, sessionOf, tenantOf } from '../../platform/http.js';
import { parseMinorUnits } from '../../platform/money.js';
import { OperatorGuard, SessionGuard, WorkspaceGuard } from '../identity/guards.js';
import { Permit } from '../tenancy/permissions.js';
import {
  CatalogueService,
  type ListingView,
  type PublicListingSummary,
  type PublicListingView,
} from './catalogue.service.js';
import { IMAGE_TYPES, type UploadGrant } from './images.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const slug = z.string().regex(/^[a-z][a-z0-9-]{1,60}$/);
const title = z.string().trim().min(3).max(120);
const description = z.string().trim().min(3).max(4000);
const quantity = z.number().int().min(0).max(1_000_000);

const createBody = z.strictObject({
  category: slug,
  type: z.enum(['stock_item', 'scheduled_service', 'quote_service']),
  title,
  description,
  currency: z.string().regex(/^[A-Z0-9]{3,10}$/),
});
const updateBody = z
  .strictObject({ title: title.optional(), description: description.optional() })
  .refine((value) => value.title !== undefined || value.description !== undefined);
const variantBody = z.strictObject({
  name: z.string().trim().min(1).max(80),
  // Validated by parseMinorUnits, so that a JSON number is rejected, not coerced.
  price_minor: z.unknown(),
  stock_on_hand: quantity,
});
const variantUpdateBody = z
  .strictObject({
    name: z.string().trim().min(1).max(80).optional(),
    price_minor: z.unknown().optional(),
    stock_on_hand: quantity.optional(),
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined));
const sessionBody = z.strictObject({
  starts_at: z.iso.datetime({ offset: true }),
  price_minor: z.unknown(),
  capacity: z.number().int().min(1).max(100_000),
});
const uploadBody = z.strictObject({
  content_type: z.enum(IMAGE_TYPES),
  size_bytes: z.number().int().min(1),
});
const attachBody = z.strictObject({ pathname: z.string().min(10).max(300) });
const searchQuery = z.strictObject({
  q: z.string().trim().min(1).max(100).optional(),
  category: slug.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
const reviewQuery = z.strictObject({
  status: z.enum(['draft', 'in_review', 'published', 'rejected', 'suspended']).default('in_review'),
});
const moderationBody = z.strictObject({
  outcome: z.enum(['approved', 'rejected', 'suspended']),
  reason: z.string().trim().min(10).max(500),
});

const id = (value: string, what: string): string => {
  if (!UUID.test(value)) throw new AppError('not_found', `${what} not found.`);
  return value.toLowerCase();
};

function actorOf(request: Request): { tenantId: string; accountId: string; requestId: string } {
  return {
    tenantId: tenantOf(request).tenantId,
    accountId: sessionOf(request).accountId,
    requestId: contextOf(request).requestId,
  };
}

/** The current taxonomy (data, ADR 0017). Public. */
@Controller('v1/kelo/categories')
export class KeloCategoriesController {
  constructor(@Inject(CatalogueService) private readonly catalogue: CatalogueService) {}

  @Get()
  async list(): Promise<{ data: Awaited<ReturnType<CatalogueService['categories']>> }> {
    return { data: await this.catalogue.categories() };
  }
}

/** Published listings only. Public: browsing needs no sign-in. */
@Controller('v1/kelo/marketplace/listings')
export class KeloMarketplaceController {
  constructor(@Inject(CatalogueService) private readonly catalogue: CatalogueService) {}

  @Get()
  search(
    @Query() query: unknown,
  ): Promise<{ data: PublicListingSummary[]; next_cursor: string | null }> {
    const input = parseBody(searchQuery, query);
    return this.catalogue.search({
      q: input.q ?? null,
      category: input.category ?? null,
      cursor: input.cursor ?? null,
      limit: input.limit,
    });
  }

  @Get(':id')
  get(@Param('id') listingId: string): Promise<PublicListingView> {
    return this.catalogue.published(id(listingId, 'Listing'));
  }
}

/** A merchant's listings, in the KELO section of their KONY workspace. */
@Controller('v1/workspace/kelo/listings')
@UseGuards(SessionGuard, WorkspaceGuard)
export class KeloListingsController {
  constructor(@Inject(CatalogueService) private readonly catalogue: CatalogueService) {}

  @Post()
  @Permit('kelo_listing.manage')
  create(@Body() body: unknown, @Req() request: Request): Promise<ListingView> {
    return this.catalogue.create(actorOf(request), parseBody(createBody, body));
  }

  @Get()
  @Permit('kelo_listing.read')
  async list(@Req() request: Request): Promise<{ data: ListingView[] }> {
    return { data: await this.catalogue.list(tenantOf(request).tenantId) };
  }

  @Get(':id')
  @Permit('kelo_listing.read')
  get(@Param('id') listingId: string, @Req() request: Request): Promise<ListingView> {
    return this.catalogue.get(tenantOf(request).tenantId, id(listingId, 'Listing'));
  }

  @Patch(':id')
  @Permit('kelo_listing.manage')
  update(
    @Param('id') listingId: string,
    @Body() body: unknown,
    @Req() request: Request,
  ): Promise<ListingView> {
    const input = parseBody(updateBody, body);
    return this.catalogue.update(actorOf(request), id(listingId, 'Listing'), {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
    });
  }

  @Post(':id/variants')
  @Permit('kelo_listing.manage')
  addVariant(
    @Param('id') listingId: string,
    @Body() body: unknown,
    @Req() request: Request,
  ): Promise<ListingView['variants'][number]> {
    const input = parseBody(variantBody, body);
    return this.catalogue.addVariant(actorOf(request), id(listingId, 'Listing'), {
      name: input.name,
      priceMinor: parseMinorUnits(input.price_minor),
      stockOnHand: input.stock_on_hand,
    });
  }

  @Patch(':id/variants/:variantId')
  @Permit('kelo_listing.manage')
  updateVariant(
    @Param('id') listingId: string,
    @Param('variantId') variantId: string,
    @Body() body: unknown,
    @Req() request: Request,
  ): Promise<ListingView['variants'][number]> {
    const input = parseBody(variantUpdateBody, body);
    return this.catalogue.updateVariant(
      actorOf(request),
      id(listingId, 'Listing'),
      id(variantId, 'Variant'),
      {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.price_minor !== undefined
          ? { priceMinor: parseMinorUnits(input.price_minor) }
          : {}),
        ...(input.stock_on_hand !== undefined ? { stockOnHand: input.stock_on_hand } : {}),
      },
    );
  }

  @Post(':id/sessions')
  @Permit('kelo_listing.manage')
  addSession(
    @Param('id') listingId: string,
    @Body() body: unknown,
    @Req() request: Request,
  ): Promise<ListingView['sessions'][number]> {
    const input = parseBody(sessionBody, body);
    return this.catalogue.addSession(actorOf(request), id(listingId, 'Listing'), {
      startsAt: new Date(input.starts_at),
      priceMinor: parseMinorUnits(input.price_minor),
      capacity: input.capacity,
    });
  }

  @Post(':id/submit')
  @HttpCode(200)
  @Permit('kelo_listing.manage')
  submit(@Param('id') listingId: string, @Req() request: Request): Promise<ListingView> {
    return this.catalogue.submit(actorOf(request), id(listingId, 'Listing'));
  }

  @Post(':id/images/upload-token')
  @Permit('kelo_listing.manage')
  uploadToken(
    @Param('id') listingId: string,
    @Body() body: unknown,
    @Req() request: Request,
  ): Promise<UploadGrant> {
    const input = parseBody(uploadBody, body);
    return this.catalogue.grantImageUpload(actorOf(request), id(listingId, 'Listing'), {
      contentType: input.content_type,
      sizeBytes: input.size_bytes,
    });
  }

  @Post(':id/images')
  @Permit('kelo_listing.manage')
  attachImage(
    @Param('id') listingId: string,
    @Body() body: unknown,
    @Req() request: Request,
  ): Promise<ListingView['images'][number]> {
    const input = parseBody(attachBody, body);
    return this.catalogue.attachImage(actorOf(request), id(listingId, 'Listing'), input.pathname);
  }
}

/** The workspace's KELO store, for its members: status and the categories it may list in. */
@Controller('v1/workspace/kelo/store')
@UseGuards(SessionGuard, WorkspaceGuard)
export class KeloWorkspaceStoreController {
  constructor(@Inject(CatalogueService) private readonly catalogue: CatalogueService) {}

  @Get()
  @Permit('kelo_listing.read')
  get(@Req() request: Request): ReturnType<CatalogueService['workspaceStore']> {
    return this.catalogue.workspaceStore(tenantOf(request).tenantId);
  }
}

/** The operator's listing review queue (ADR 0017 moderation). */
@Controller('v1/ops/kelo/listings')
@UseGuards(SessionGuard, OperatorGuard)
export class KeloModerationController {
  constructor(@Inject(CatalogueService) private readonly catalogue: CatalogueService) {}

  @Get()
  async queue(@Query() query: unknown): Promise<{ data: ListingView[] }> {
    return { data: await this.catalogue.reviewQueue(parseBody(reviewQuery, query).status) };
  }

  @Post(':id/decision')
  @HttpCode(200)
  decide(
    @Param('id') listingId: string,
    @Body() body: unknown,
    @Req() request: Request,
  ): Promise<ListingView> {
    const input = parseBody(moderationBody, body);
    return this.catalogue.moderate(
      { accountId: sessionOf(request).accountId, requestId: contextOf(request).requestId },
      id(listingId, 'Listing'),
      input,
    );
  }
}
