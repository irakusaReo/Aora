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
import { contextOf, parseBody, sessionOf } from '../../../platform/http.js';
import { parseMinorUnits } from '../../../platform/money.js';
import { SessionGuard } from '../../identity/guards.js';
import { SCENARIOS } from '../../payments/simulator.js';
import { BUREAU_RESULTS } from './bureau.js';
import { CreditService, type DecisionView, type LimitView } from './credit.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const decisionBody = z.strictObject({
  listing_id: z.uuid(),
  variant_id: z.uuid().optional(),
  session_id: z.uuid().optional(),
  template_key: z.string().regex(/^[a-z][a-z0-9_]{2,60}$/),
  // Validated by parseMinorUnits, so that a JSON number is rejected, not coerced.
  declared_monthly_income_minor: z.unknown(),
  bureau_check: z
    .strictObject({
      consent_version: z.string().min(1).max(40),
      // SANDBOX ONLY: scripts the bureau simulator.
      sandbox_result: z.enum(BUREAU_RESULTS).optional(),
    })
    .optional(),
});
const payBody = z.strictObject({
  // SANDBOX ONLY: scripts the simulator. Without it, the M-Pesa rail is used.
  sandbox_scenario: z.enum(SCENARIOS).optional(),
  payer_phone: z
    .string()
    .regex(/^\+[1-9][0-9]{7,14}$/)
    .optional(),
});

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

/** KELO credit for a signed-in buyer (phase 8A). `not_found` while the flag is off. */
@Controller('v1/kelo')
@UseGuards(SessionGuard)
export class KeloCreditController {
  constructor(@Inject(CreditService) private readonly credit: CreditService) {}

  @Get('credit/limit')
  limit(@Req() request: Request): Promise<LimitView> {
    return this.credit.limit(sessionOf(request).accountId);
  }

  @Post('credit/decisions')
  async decide(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<DecisionView> {
    const idempotencyKey = requireKey(key);
    const input = parseBody(decisionBody, body);
    const income = parseMinorUnits(input.declared_monthly_income_minor);
    if (income <= 0n) {
      throw new AppError('invalid_request', 'Invalid request: declared_monthly_income_minor.');
    }
    const result = await this.credit.decide(buyer(request), idempotencyKey, {
      listingId: input.listing_id.toLowerCase(),
      variantId: input.variant_id?.toLowerCase() ?? null,
      sessionId: input.session_id?.toLowerCase() ?? null,
      templateKey: input.template_key,
      declaredMonthlyIncomeMinor: income,
      bureau: input.bureau_check
        ? {
            consentVersion: input.bureau_check.consent_version,
            scripted: input.bureau_check.sandbox_result ?? null,
          }
        : null,
    });
    response.status(result.replayed ? 200 : 201);
    if (result.replayed) response.setHeader('Idempotent-Replay', 'true');
    return result.decision;
  }

  @Get('credit/decisions/:id')
  decision(@Param('id') decisionId: string, @Req() request: Request): Promise<DecisionView> {
    return this.credit.decision(sessionOf(request).accountId, id(decisionId, 'Decision'));
  }

  @Post('me/purchases/:id/credit/instalments/:seq/pay')
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
    if (!/^(0|[1-9][0-9]?)$/.test(seq)) throw new AppError('not_found', 'Instalment not found.');
    return this.credit.pay(buyer(request), idempotencyKey, {
      purchaseId: id(purchaseId, 'Purchase'),
      seq: Number.parseInt(seq, 10),
      scenario: input.sandbox_scenario ?? null,
      payerPhone: input.payer_phone ?? null,
    });
  }
}
