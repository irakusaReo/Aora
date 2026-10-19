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
import { type ClaimView, ClaimsService } from './credit/claims.service.js';
import { CreditService, type CreditView } from './credit/credit.service.js';
import { type KeloDashboard, KeloDashboardService } from './dashboard.service.js';
import type { CreditOffer } from './credit/offer.js';

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
/** A credit purchase: everything else comes from the approved decision (P8-5). */
const creditPurchaseBody = z.strictObject({
  decision_id: z.uuid(),
  expected_total_payable_minor: z.unknown(),
  agreement_version: z.string().min(1).max(40),
  kid_version: z.string().min(1).max(40),
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
  ): Promise<{ data: (PlanOffer | CreditOffer)[] }> {
    const choice = parseBody(choiceQuery, query);
    return {
      data: await this.layaway.plansFor(id(listingId, 'Listing'), {
        variantId: choice.variant_id?.toLowerCase() ?? null,
        sessionId: choice.session_id?.toLowerCase() ?? null,
      }),
    };
  }
}

type PurchaseView = BuyerPurchaseView & { credit: CreditView | null; claim: ClaimView | null };

/** A signed-in buyer's purchases: layaway (journey K4) and credit (K2, phase 8A). */
@Controller('v1/kelo')
@UseGuards(SessionGuard)
export class KeloPurchasesController {
  constructor(
    @Inject(LayawayService) private readonly layaway: LayawayService,
    @Inject(CreditService) private readonly credit: CreditService,
    @Inject(ClaimsService) private readonly claims: ClaimsService,
  ) {}

  /** Each purchase with its credit agreement and latest claim, if it has them. */
  private async withCredit(accountId: string, views: BuyerPurchaseView[]): Promise<PurchaseView[]> {
    const ids = views.filter((view) => view.plan_type !== 'layaway').map((view) => view.id);
    const [credit, claims] = await Promise.all([
      this.credit.views(accountId, ids),
      this.claims.forBuyer(accountId, ids),
    ]);
    return views.map((view) => ({
      ...view,
      credit: credit.get(view.id) ?? null,
      claim: claims.get(view.id) ?? null,
    }));
  }

  private async view(accountId: string, purchaseId: string): Promise<PurchaseView> {
    const [view] = await this.withCredit(accountId, [
      await this.layaway.one(accountId, purchaseId),
    ]);
    if (!view) throw new AppError('not_found', 'Purchase not found.');
    return view;
  }

  @Post('purchases')
  async purchase(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PurchaseView> {
    const idempotencyKey = requireKey(key);
    if (body && typeof body === 'object' && 'decision_id' in body) {
      const input = parseBody(creditPurchaseBody, body);
      const result = await this.credit.purchase(buyer(request), idempotencyKey, {
        decisionId: input.decision_id.toLowerCase(),
        expectedTotalPayableMinor: parseMinorUnits(input.expected_total_payable_minor),
        agreementVersion: input.agreement_version,
        kidVersion: input.kid_version,
      });
      response.status(result.replayed ? 200 : 201);
      if (result.replayed) response.setHeader('Idempotent-Replay', 'true');
      return this.view(sessionOf(request).accountId, result.purchaseId);
    }
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
    return { ...result.purchase, credit: null, claim: null };
  }

  @Get('me/purchases')
  async mine(@Req() request: Request): Promise<{ data: PurchaseView[] }> {
    const accountId = sessionOf(request).accountId;
    return { data: await this.withCredit(accountId, await this.layaway.mine(accountId)) };
  }

  @Get('me/purchases/:id')
  one(@Param('id') purchaseId: string, @Req() request: Request): Promise<PurchaseView> {
    return this.view(sessionOf(request).accountId, id(purchaseId, 'Purchase'));
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
  async cancel(@Param('id') purchaseId: string, @Req() request: Request): Promise<PurchaseView> {
    const actor = buyer(request);
    const purchase = id(purchaseId, 'Purchase');
    if (await this.credit.isCredit(actor.accountId, purchase)) {
      await this.credit.cancel(actor, purchase);
    } else {
      await this.layaway.cancel(actor, purchase);
    }
    return this.view(actor.accountId, purchase);
  }

  @Post('me/purchases/:id/confirm-delivery')
  @HttpCode(200)
  async confirmDelivery(
    @Param('id') purchaseId: string,
    @Req() request: Request,
  ): Promise<PurchaseView> {
    const actor = buyer(request);
    await this.layaway.confirmDelivery(actor, id(purchaseId, 'Purchase'));
    return this.view(actor.accountId, id(purchaseId, 'Purchase'));
  }
}

/** The merchant side, in the KELO section of KONY. Never shows who the buyer is. */
@Controller('v1/workspace/kelo')
@UseGuards(SessionGuard, WorkspaceGuard)
export class KeloMerchantPurchasesController {
  constructor(
    @Inject(LayawayService) private readonly layaway: LayawayService,
    @Inject(ClaimsService) private readonly claims: ClaimsService,
    @Inject(KeloDashboardService) private readonly dashboards: KeloDashboardService,
  ) {}

  /** The KELO dashboard (8D): every figure from the ledger, nothing about any buyer's credit. */
  @Get('dashboard')
  @Permit('settlement.read')
  dashboard(@Req() request: Request): Promise<KeloDashboard> {
    return this.dashboards.forWorkspace(tenantOf(request).tenantId);
  }

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
  async list(
    @Req() request: Request,
  ): Promise<{ data: (MerchantPurchaseView & { claim: ClaimView | null })[] }> {
    const tenantId = tenantOf(request).tenantId;
    const rows = await this.layaway.merchantList(tenantId);
    const claims = await this.claims.forMerchant(
      tenantId,
      rows.map((row) => row.id),
    );
    return {
      data: rows.map((row) => {
        const claim = claims.get(row.id) ?? null;
        // An open return waits on the merchant; an open dispute on KELO (8C).
        const next_action: MerchantPurchaseView['next_action'] =
          claim?.status === 'open'
            ? claim.kind === 'return'
              ? 'respond_to_return'
              : 'wait_for_decision'
            : row.next_action;
        return { ...row, next_action, claim };
      }),
    };
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
