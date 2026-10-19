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
import { AppError } from '../../../platform/errors.js';
import { contextOf, parseBody, sessionOf, tenantOf } from '../../../platform/http.js';
import { OperatorGuard, SessionGuard, StepUpGuard, WorkspaceGuard } from '../../identity/guards.js';
import { Permit } from '../../tenancy/permissions.js';
import { CLAIM_REASONS, type ClaimView, ClaimsService } from './claims.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const openBody = z.strictObject({
  kind: z.enum(['return', 'dispute']),
  reason_code: z.enum(CLAIM_REASONS),
  // Purchase data only; never health information.
  details: z.string().trim().min(1).max(500).optional(),
});
const reasonBody = z.strictObject({ reason: z.string().trim().min(3).max(300) });
const decisionBody = z.strictObject({
  outcome: z.enum(['accepted', 'rejected']),
  reason: z.string().trim().min(3).max(300),
});

const id = (value: string, what: string): string => {
  if (!UUID.test(value)) throw new AppError('not_found', `${what} not found.`);
  return value.toLowerCase();
};

const person = (request: Request) => ({
  accountId: sessionOf(request).accountId,
  requestId: contextOf(request).requestId,
});
const merchant = (request: Request) => ({
  tenantId: tenantOf(request).tenantId,
  accountId: sessionOf(request).accountId,
  requestId: contextOf(request).requestId,
});

/** A buyer's returns and disputes (phase 8C). `not_found` while the credit flag is off. */
@Controller('v1/kelo/me/purchases')
@UseGuards(SessionGuard)
export class KeloBuyerClaimsController {
  constructor(@Inject(ClaimsService) private readonly claims: ClaimsService) {}

  @Post(':id/claims')
  async open(
    @Param('id') purchaseId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ClaimView> {
    if (!key || key.length > 200) {
      throw new AppError(
        'idempotency_key_required',
        'An Idempotency-Key header of 1 to 200 characters is required.',
      );
    }
    const input = parseBody(openBody, body);
    const result = await this.claims.open(person(request), key, id(purchaseId, 'Purchase'), {
      kind: input.kind,
      reasonCode: input.reason_code,
      details: input.details ?? null,
    });
    response.status(result.replayed ? 200 : 201);
    return result.claim;
  }

  @Post(':id/claims/:claim/withdraw')
  @HttpCode(200)
  withdraw(
    @Param('id') purchaseId: string,
    @Param('claim') claimId: string,
    @Req() request: Request,
  ): Promise<ClaimView> {
    return this.claims.withdraw(person(request), id(purchaseId, 'Purchase'), id(claimId, 'Claim'));
  }
}

/** The merchant decides returns (never disputes) in the KELO section of KONY. */
@Controller('v1/workspace/kelo/claims')
@UseGuards(SessionGuard, WorkspaceGuard)
export class KeloMerchantClaimsController {
  constructor(@Inject(ClaimsService) private readonly claims: ClaimsService) {}

  /** Accepting refunds the buyer and claws back from the merchant: a refund authority. */
  @Post(':id/accept')
  @HttpCode(200)
  @Permit('refund.create')
  @UseGuards(StepUpGuard)
  accept(@Param('id') claimId: string, @Req() request: Request): Promise<ClaimView> {
    return this.claims.merchantAccept(merchant(request), id(claimId, 'Claim'));
  }

  @Post(':id/reject')
  @HttpCode(200)
  @Permit('kelo_listing.manage')
  reject(
    @Param('id') claimId: string,
    @Body() body: unknown,
    @Req() request: Request,
  ): Promise<ClaimView> {
    const input = parseBody(reasonBody, body);
    return this.claims.merchantReject(merchant(request), id(claimId, 'Claim'), input.reason);
  }
}

/** Platform operators decide disputes, with a step-up and a reason. */
@Controller('v1/ops/kelo/claims')
@UseGuards(SessionGuard, OperatorGuard)
export class KeloOpsClaimsController {
  constructor(@Inject(ClaimsService) private readonly claims: ClaimsService) {}

  @Get()
  async list(): Promise<{ data: (ClaimView & { workspace_id: string })[] }> {
    return { data: await this.claims.openDisputes() };
  }

  @Post(':id/decision')
  @HttpCode(200)
  @UseGuards(StepUpGuard)
  decide(
    @Param('id') claimId: string,
    @Body() body: unknown,
    @Req() request: Request,
  ): Promise<ClaimView> {
    const input = parseBody(decisionBody, body);
    return this.claims.operatorDecide(
      person(request),
      id(claimId, 'Claim'),
      input.outcome,
      input.reason,
    );
  }
}
