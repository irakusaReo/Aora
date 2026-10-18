import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AppError } from '../../platform/errors.js';
import { contextOf, parseBody, sessionOf, tenantOf } from '../../platform/http.js';
import { parseMinorUnits } from '../../platform/money.js';
import { SessionGuard, WorkspaceGuard } from '../identity/guards.js';
import { Permit } from '../tenancy/permissions.js';
import { type QuoteRequestView, QuotesService, type QuoteView } from './quotes.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const requestBody = z.strictObject({
  listing_id: z.uuid(),
  details: z.string().trim().min(10).max(1000),
});
const quoteBody = z.strictObject({
  // Validated by parseMinorUnits, so that a JSON number is rejected, not coerced.
  price_minor: z.unknown(),
  expires_at: z.iso.datetime({ offset: true }),
});

const id = (value: string, what: string): string => {
  if (!UUID.test(value)) throw new AppError('not_found', `${what} not found.`);
  return value.toLowerCase();
};

/** A signed-in buyer's quote requests (ADR 0017). */
@Controller('v1/kelo')
@UseGuards(SessionGuard)
export class KeloBuyerQuotesController {
  constructor(@Inject(QuotesService) private readonly quotes: QuotesService) {}

  @Post('quote-requests')
  async request(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<QuoteRequestView> {
    if (!idempotencyKey || idempotencyKey.length > 200) {
      throw new AppError(
        'idempotency_key_required',
        'An Idempotency-Key header of 1 to 200 characters is required.',
      );
    }
    const input = parseBody(requestBody, body);
    const result = await this.quotes.request(
      { accountId: sessionOf(request).accountId, requestId: contextOf(request).requestId },
      idempotencyKey,
      { listingId: input.listing_id.toLowerCase(), details: input.details },
    );
    response.status(result.replayed ? 200 : 201);
    if (result.replayed) response.setHeader('Idempotent-Replay', 'true');
    return result.request;
  }

  @Get('me/quote-requests')
  async mine(@Req() request: Request): Promise<{ data: QuoteRequestView[] }> {
    return { data: await this.quotes.mine(sessionOf(request).accountId) };
  }

  @Post('me/quotes/:id/decline')
  @HttpCode(200)
  decline(@Param('id') quoteId: string, @Req() request: Request): Promise<QuoteView> {
    return this.quotes.decline(
      { accountId: sessionOf(request).accountId, requestId: contextOf(request).requestId },
      id(quoteId, 'Quote'),
    );
  }
}

/** The merchant's quote inbox, in the KELO section of KONY. */
@Controller('v1/workspace/kelo/quote-requests')
@UseGuards(SessionGuard, WorkspaceGuard)
export class KeloMerchantQuotesController {
  constructor(@Inject(QuotesService) private readonly quotes: QuotesService) {}

  @Get()
  @Permit('kelo_listing.read')
  async inbox(@Req() request: Request): Promise<{ data: QuoteRequestView[] }> {
    return { data: await this.quotes.inbox(tenantOf(request).tenantId) };
  }

  @Post(':id/quotes')
  @Permit('kelo_listing.manage')
  quote(
    @Param('id') requestId: string,
    @Body() body: unknown,
    @Req() request: Request,
  ): Promise<QuoteView> {
    const input = parseBody(quoteBody, body);
    return this.quotes.quote(
      {
        tenantId: tenantOf(request).tenantId,
        accountId: sessionOf(request).accountId,
        requestId: contextOf(request).requestId,
      },
      id(requestId, 'Quote request'),
      { priceMinor: parseMinorUnits(input.price_minor), expiresAt: new Date(input.expires_at) },
    );
  }
}
