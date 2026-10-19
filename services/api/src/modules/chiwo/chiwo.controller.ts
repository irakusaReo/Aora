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
import { contextOf, parseBody, sessionOf } from '../../platform/http.js';
import { parseMinorUnits } from '../../platform/money.js';
import { SessionGuard } from '../identity/guards.js';
import { SCENARIOS } from '../payments/simulator.js';
import { PAY_CODE } from '../tenancy/pay-codes.js';
import {
  BeforeSignUp,
  type ChiwoMeView,
  ConsumerGuard,
  ConsumerService,
} from './consumer.service.js';
import {
  type MerchantPaymentView,
  MerchantPaymentsService,
  type MerchantView,
  type PaymentQuote,
  type ReceiptView,
} from './merchant-payments.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY = z.string().regex(/^[A-Z]{3}$/);
const payCode = z.string().regex(PAY_CODE);

const signUpBody = z.strictObject({ terms_version: z.string().min(1).max(40) });
const quoteBody = z.strictObject({
  pay_code: payCode,
  // Validated by parseMinorUnits, so that a JSON number is rejected, not coerced.
  amount_minor: z.unknown(),
  currency: CURRENCY,
});
const payBody = z.strictObject({
  pay_code: payCode,
  amount_minor: z.unknown(),
  currency: CURRENCY,
  // What the consumer was shown and agreed to (P7-5).
  expected_fee_minor: z.unknown(),
  expected_total_minor: z.unknown(),
  sandbox_scenario: z.enum(SCENARIOS).optional(),
});

function idempotencyKeyOf(value: string | undefined): string {
  if (!value || value.length > 200) {
    throw new AppError(
      'idempotency_key_required',
      'An Idempotency-Key header of 1 to 200 characters is required.',
    );
  }
  return value;
}

/** Non-negative minor units (a fee may be zero), with the same strict parsing. */
function parseNonNegative(value: unknown): bigint {
  if (value === '0') return 0n;
  return parseMinorUnits(value);
}

/**
 * CHIWO: the personal context (phase 7). Every route acts for the signed-in
 * person only and refuses a workspace header (P7-1).
 */
@Controller('v1/chiwo')
@UseGuards(SessionGuard, ConsumerGuard)
export class ChiwoController {
  constructor(
    @Inject(ConsumerService) private readonly consumers: ConsumerService,
    @Inject(MerchantPaymentsService) private readonly payments: MerchantPaymentsService,
  ) {}

  @Get('me')
  @BeforeSignUp()
  me(@Req() request: Request): Promise<ChiwoMeView> {
    return this.consumers.me(sessionOf(request).accountId);
  }

  @Post('sign-up')
  @BeforeSignUp()
  async signUp(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ChiwoMeView> {
    const input = parseBody(signUpBody, body);
    const result = await this.consumers.signUp(
      sessionOf(request).accountId,
      contextOf(request).requestId,
      input.terms_version,
    );
    response.status(result.created ? 201 : 200);
    return result.view;
  }

  @Get('merchants/:code')
  merchant(@Param('code') code: string, @Req() request: Request): Promise<MerchantView> {
    if (!PAY_CODE.test(code)) throw new AppError('not_found', 'Merchant not found.');
    return this.payments.lookup(sessionOf(request).accountId, code);
  }

  @Post('payments/quote')
  @HttpCode(200)
  quote(@Body() body: unknown, @Req() request: Request): Promise<PaymentQuote> {
    const input = parseBody(quoteBody, body);
    return this.payments.quote(sessionOf(request).accountId, {
      payCode: input.pay_code,
      amount: parseMinorUnits(input.amount_minor),
      currency: input.currency,
    });
  }

  @Post('payments')
  async pay(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MerchantPaymentView> {
    const key = idempotencyKeyOf(idempotencyKey);
    const input = parseBody(payBody, body);
    const result = await this.payments.pay(
      { accountId: sessionOf(request).accountId, requestId: contextOf(request).requestId },
      key,
      {
        payCode: input.pay_code,
        amount: parseMinorUnits(input.amount_minor),
        currency: input.currency,
        expectedFee: parseNonNegative(input.expected_fee_minor),
        expectedTotal: parseMinorUnits(input.expected_total_minor),
        scenario: input.sandbox_scenario ?? null,
      },
    );
    response.status(result.replayed ? 200 : 201);
    if (result.replayed) response.setHeader('Idempotent-Replay', 'true');
    return result.payment;
  }

  @Get('payments')
  async list(@Req() request: Request): Promise<{ data: MerchantPaymentView[] }> {
    return { data: await this.payments.list(sessionOf(request).accountId) };
  }

  @Get('payments/:id')
  get(@Param('id') id: string, @Req() request: Request): Promise<MerchantPaymentView> {
    if (!UUID.test(id)) throw new AppError('not_found', 'Payment not found.');
    return this.payments.get(sessionOf(request).accountId, id);
  }

  /** Everything the consumer did, newest first. Merchant payments in 7A; transfers join in 7B. */
  @Get('activity')
  async activity(
    @Req() request: Request,
  ): Promise<{ data: (MerchantPaymentView & { kind: 'merchant_payment' })[] }> {
    const payments = await this.payments.list(sessionOf(request).accountId);
    return { data: payments.map((payment) => ({ ...payment, kind: 'merchant_payment' as const })) };
  }

  @Get('receipts/:kind/:id')
  receipt(
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Req() request: Request,
  ): Promise<ReceiptView> {
    if (kind !== 'merchant_payment' || !UUID.test(id)) {
      throw new AppError('not_found', 'Receipt not found.');
    }
    return this.payments.receipt(sessionOf(request).accountId, id);
  }
}
