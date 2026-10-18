import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
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
import { SCENARIOS } from '../payments/simulator.js';
import { Permit } from '../tenancy/permissions.js';
import {
  type BuyerPurchaseView,
  LayawayService,
  type MerchantPurchaseView,
  type PlanOffer,
} from './layaway.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const choiceQuery = z.strictObject({
  variant_id: z.uuid().optional(),
  session_id: z.uuid().optional(),
});
const purchaseBody = z.strictObject({
  listing_id: z.uuid(),
  variant_id: z.uuid().optional(),
  session_id: z.uuid().optional(),
  template_key: z.string().regex(/^[a-z][a-z0-9_]{2,60}$/),
  // Validated by parseMinorUnits, so that a JSON number is rejected, not coerced.
  expected_total_minor: z.unknown(),
  terms_version: z.string().min(1).max(40),
});
const payBody = z.strictObject({
  // SANDBOX ONLY: scripts the simulator. Without it, the M-Pesa rail is used.
  sandbox_scenario: z.enum(SCENARIOS).optional(),
  payer_phone: z
    .string()
    .regex(/^\+[1-9][0-9]{7,14}$/)
    .optional(),
});
const offerBody = z.strictObject({ template_key: z.string().regex(/^[a-z][a-z0-9_]{2,60}$/) });
const fulfilBody = z.strictObject({ proof_reference: z.string().trim().min(3).max(80).optional() });

const id = (value: string, what: string): string => {
  if (!UUID.test(value)) throw new AppError('not_found', `${what} not found.`);
  return value.toLowerCase();
};

function requireKey(key: string | undefined): string {
  if (!key || key.length > 200) {
    throw new AppError(
      'idempotency_key_required',
      'An Idempotency-Key header of 1 to 200 characters is required.',
    );
  }
  return key;
}

const buyer = (request: Request) => ({
  accountId: sessionOf(request).accountId,
  requestId: contextOf(request).requestId,
});
const merchant = (request: Request) => ({
  tenantId: tenantOf(request).tenantId,
  accountId: sessionOf(request).accountId,
  requestId: contextOf(request).requestId,
});

/** The plans a listing offers, with every figure from the schedule engine. Public. */
@Controller('v1/kelo/marketplace/listings')
export class KeloPlansController {
  constructor(@Inject(LayawayService) private readonly layaway: LayawayService) {}

  @Get(':id/plans')
  async plans(
    @Param('id') listingId: string,
    @Query() query: unknown,
  ): Promise<{ data: PlanOffer[] }> {
    const choice = parseBody(choiceQuery, query);
    return {
      data: await this.layaway.plansFor(id(listingId, 'Listing'), {
        variantId: choice.variant_id?.toLowerCase() ?? null,
        sessionId: choice.session_id?.toLowerCase() ?? null,
      }),
    };
  }
}

/** A signed-in buyer's layaway purchases (journey K4). */
@Controller('v1/kelo')
@UseGuards(SessionGuard)
export class KeloPurchasesController {
  constructor(@Inject(LayawayService) private readonly layaway: LayawayService) {}

  @Post('purchases')
  async purchase(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<BuyerPurchaseView> {
    const idempotencyKey = requireKey(key);
    const input = parseBody(purchaseBody, body);
    const result = await this.layaway.purchase(buyer(request), idempotencyKey, {
      listingId: input.listing_id.toLowerCase(),
      variantId: input.variant_id?.toLowerCase() ?? null,
      sessionId: input.session_id?.toLowerCase() ?? null,
      templateKey: input.template_key,
      expectedTotalMinor: parseMinorUnits(input.expected_total_minor),
      termsVersion: input.terms_version,
    });
    response.status(result.replayed ? 200 : 201);
    if (result.replayed) response.setHeader('Idempotent-Replay', 'true');
    return result.purchase;
  }

  @Get('me/purchases')
  async mine(@Req() request: Request): Promise<{ data: BuyerPurchaseView[] }> {
    return { data: await this.layaway.mine(sessionOf(request).accountId) };
  }

  @Get('me/purchases/:id')
  one(@Param('id') purchaseId: string, @Req() request: Request): Promise<BuyerPurchaseView> {
    return this.layaway.one(sessionOf(request).accountId, id(purchaseId, 'Purchase'));
  }

  @Post('me/purchases/:id/instalments/:seq/pay')
  @HttpCode(202)
  pay(
    @Param('id') purchaseId: string,
    @Param('seq') seq: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: Request,
  ): Promise<{ seq: number; status: string; payment_intent_id: string }> {
    const idempotencyKey = requireKey(key);
    const input = parseBody(payBody, body);
    if (!/^[1-9][0-9]{0,1}$/.test(seq)) throw new AppError('not_found', 'Instalment not found.');
    return this.layaway.payInstalment(buyer(request), idempotencyKey, {
      purchaseId: id(purchaseId, 'Purchase'),
      seq: Number.parseInt(seq, 10),
      scenario: input.sandbox_scenario ?? null,
      payerPhone: input.payer_phone ?? null,
    });
  }

  @Post('me/purchases/:id/cancel')
  @HttpCode(200)
  cancel(@Param('id') purchaseId: string, @Req() request: Request): Promise<BuyerPurchaseView> {
    return this.layaway.cancel(buyer(request), id(purchaseId, 'Purchase'));
  }

  @Post('me/purchases/:id/confirm-delivery')
  @HttpCode(200)
  confirmDelivery(
    @Param('id') purchaseId: string,
    @Req() request: Request,
  ): Promise<BuyerPurchaseView> {
    return this.layaway.confirmDelivery(buyer(request), id(purchaseId, 'Purchase'));
  }
}

/** The merchant side, in the KELO section of KONY. Never shows who the buyer is. */
@Controller('v1/workspace/kelo')
@UseGuards(SessionGuard, WorkspaceGuard)
export class KeloMerchantPurchasesController {
  constructor(@Inject(LayawayService) private readonly layaway: LayawayService) {}

  @Get('listings/:id/plan-options')
  @Permit('kelo_listing.read')
  async planOptions(
    @Param('id') listingId: string,
    @Req() request: Request,
  ): Promise<{ data: Awaited<ReturnType<LayawayService['planOptions']>> }> {
    return {
      data: await this.layaway.planOptions(tenantOf(request).tenantId, id(listingId, 'Listing')),
    };
  }

  @Post('listings/:id/plan-offers')
  @Permit('kelo_listing.manage')
  offer(
    @Param('id') listingId: string,
    @Body() body: unknown,
    @Req() request: Request,
  ): Promise<{ template_key: string; offered: true }> {
    const input = parseBody(offerBody, body);
    return this.layaway.offerPlan(merchant(request), id(listingId, 'Listing'), input.template_key);
  }

  @Get('purchases')
  @Permit('kelo_listing.read')
  async list(@Req() request: Request): Promise<{ data: MerchantPurchaseView[] }> {
    return { data: await this.layaway.merchantList(tenantOf(request).tenantId) };
  }

  @Post('purchases/:id/confirm')
  @HttpCode(200)
  @Permit('kelo_listing.manage')
  confirm(@Param('id') purchaseId: string, @Req() request: Request): Promise<MerchantPurchaseView> {
    return this.layaway.merchantConfirm(merchant(request), id(purchaseId, 'Purchase'));
  }

  @Post('purchases/:id/fulfil')
  @HttpCode(200)
  @Permit('kelo_listing.manage')
  fulfil(
    @Param('id') purchaseId: string,
    @Body() body: unknown,
    @Req() request: Request,
  ): Promise<MerchantPurchaseView> {
    const input = parseBody(fulfilBody, body ?? {});
    return this.layaway.merchantFulfil(
      merchant(request),
      id(purchaseId, 'Purchase'),
      input.proof_reference ?? null,
    );
  }
}
