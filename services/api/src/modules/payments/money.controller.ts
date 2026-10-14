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
import { SessionGuard, StepUpGuard, WorkspaceGuard } from '../identity/guards.js';
import { Permit } from '../tenancy/permissions.js';
import { type PayoutView, PayoutsService, type RecipientView } from './payouts.service.js';
import { type RefundView, RefundsService } from './refunds.service.js';
import { type SettlementView, SettlementService } from './settlement.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHONE = z.string().regex(/^\+[1-9][0-9]{7,14}$/);
const MONEY_SCENARIOS = [
  'success',
  'decline',
  'timeout_then_success',
  'timeout_then_failure',
] as const;

const recipientBody = z.strictObject({ phone: PHONE, label: z.string().trim().min(1).max(60) });
const confirmBody = z.strictObject({ phone: PHONE });
const previewBody = z.strictObject({
  recipient_id: z.uuid(),
  amount_minor: z.unknown(),
  currency: z.string().regex(/^[A-Z]{3}$/),
});
const payoutBody = z.strictObject({
  recipient_id: z.uuid(),
  amount_minor: z.unknown(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  // The fee the person was shown, and the tariff version it came from.
  expected_fee_minor: z.string().regex(/^(0|[1-9][0-9]{0,18})$/),
  tariff_version_id: z.uuid(),
  sandbox_scenario: z.enum(MONEY_SCENARIOS).optional(),
});
const refundBody = z.strictObject({
  amount_minor: z.unknown(),
  sandbox_scenario: z.enum(MONEY_SCENARIOS).optional(),
});

function idempotencyKeyOf(key: string | undefined): string {
  if (!key || key.length > 200) {
    throw new AppError(
      'idempotency_key_required',
      'An Idempotency-Key header of 1 to 200 characters is required.',
    );
  }
  return key;
}

function actorOf(request: Request): { tenantId: string; accountId: string; requestId: string } {
  return {
    tenantId: tenantOf(request).tenantId,
    accountId: sessionOf(request).accountId,
    requestId: contextOf(request).requestId,
  };
}

@Controller('v1/settlements')
@UseGuards(SessionGuard, WorkspaceGuard)
export class SettlementsController {
  constructor(@Inject(SettlementService) private readonly settlement: SettlementService) {}

  @Get()
  @Permit('settlement.read')
  async list(@Req() request: Request): Promise<{ data: SettlementView[] }> {
    return { data: await this.settlement.list(tenantOf(request).tenantId) };
  }
}

@Controller('v1/payout-recipients')
@UseGuards(SessionGuard, WorkspaceGuard)
export class PayoutRecipientsController {
  constructor(@Inject(PayoutsService) private readonly payouts: PayoutsService) {}

  @Get()
  @Permit('payout_recipient.read')
  async list(@Req() request: Request): Promise<{ data: RecipientView[] }> {
    return { data: await this.payouts.listRecipients(tenantOf(request).tenantId) };
  }

  @Post()
  @HttpCode(201)
  @Permit('payout_recipient.manage')
  add(@Body() body: unknown, @Req() request: Request): Promise<RecipientView> {
    return this.payouts.addRecipient(actorOf(request), parseBody(recipientBody, body));
  }

  /** The number typed a second time, with a PIN step-up: proves intent, not ownership (O-11). */
  @Post(':id/confirmation')
  @HttpCode(200)
  @Permit('payout_recipient.manage')
  @UseGuards(StepUpGuard)
  confirm(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: Request,
  ): Promise<RecipientView> {
    const input = parseBody(confirmBody, body);
    if (!UUID.test(id)) throw new AppError('not_found', 'Recipient not found.');
    return this.payouts.confirmRecipient(actorOf(request), id, input.phone);
  }
}

@Controller('v1/payouts')
@UseGuards(SessionGuard, WorkspaceGuard)
export class PayoutsController {
  constructor(@Inject(PayoutsService) private readonly payouts: PayoutsService) {}

  /** Exactly what a payout would cost now. Changes nothing. */
  @Post('preview')
  @HttpCode(200)
  @Permit('payout.read')
  preview(@Body() body: unknown, @Req() request: Request): ReturnType<PayoutsService['preview']> {
    const input = parseBody(previewBody, body);
    return this.payouts.preview(tenantOf(request).tenantId, {
      recipientId: input.recipient_id,
      amount: parseMinorUnits(input.amount_minor),
      assetCode: input.currency,
    });
  }

  @Post()
  @Permit('payout.create')
  @UseGuards(StepUpGuard)
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PayoutView> {
    const idempotencyKey = idempotencyKeyOf(key);
    const input = parseBody(payoutBody, body);
    const result = await this.payouts.create(actorOf(request), {
      idempotencyKey,
      recipientId: input.recipient_id,
      amount: parseMinorUnits(input.amount_minor),
      assetCode: input.currency,
      expectedFee: BigInt(input.expected_fee_minor),
      tariffVersionId: input.tariff_version_id,
      scenario: input.sandbox_scenario ?? null,
    });
    response.status(result.replayed ? 200 : 201);
    if (result.replayed) response.setHeader('Idempotent-Replay', 'true');
    return result.payout;
  }

  @Get()
  @Permit('payout.read')
  async list(@Req() request: Request): Promise<{ data: PayoutView[] }> {
    return { data: await this.payouts.list(tenantOf(request).tenantId) };
  }

  @Get(':id')
  @Permit('payout.read')
  get(@Param('id') id: string, @Req() request: Request): Promise<PayoutView> {
    if (!UUID.test(id)) throw new AppError('not_found', 'Payout not found.');
    return this.payouts.get(tenantOf(request).tenantId, id);
  }
}

@Controller('v1')
@UseGuards(SessionGuard, WorkspaceGuard)
export class RefundsController {
  constructor(@Inject(RefundsService) private readonly refunds: RefundsService) {}

  @Post('payment-intents/:id/refunds')
  @Permit('refund.create')
  @UseGuards(StepUpGuard)
  async create(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<RefundView> {
    const idempotencyKey = idempotencyKeyOf(key);
    const input = parseBody(refundBody, body);
    if (!UUID.test(id)) throw new AppError('not_found', 'Payment intent not found.');
    const result = await this.refunds.create(actorOf(request), {
      intentId: id,
      idempotencyKey,
      amount: parseMinorUnits(input.amount_minor),
      scenario: input.sandbox_scenario ?? null,
    });
    response.status(result.replayed ? 200 : 201);
    if (result.replayed) response.setHeader('Idempotent-Replay', 'true');
    return result.refund;
  }

  @Get('refunds/:id')
  @Permit('refund.read')
  get(@Param('id') id: string, @Req() request: Request): Promise<RefundView> {
    if (!UUID.test(id)) throw new AppError('not_found', 'Refund not found.');
    return this.refunds.get(tenantOf(request).tenantId, id);
  }
}

/** Daraja B2C results and Transaction Status results (ADR 0022). Nothing here logs the URL. */
@Controller('v1/webhooks/daraja')
export class DarajaPayoutWebhooksController {
  constructor(@Inject(PayoutsService) private readonly payouts: PayoutsService) {}

  @Post('b2c/:payoutId/:token')
  @HttpCode(200)
  async result(
    @Param('payoutId') payoutId: string,
    @Param('token') token: string,
    @Req() request: Request,
  ): Promise<{ received: true }> {
    await this.payouts.receiveDarajaResult({
      payoutId,
      token,
      purpose: 'b2c',
      rawBody: request.rawBody,
      sourceIp: request.ip ?? null,
    });
    return { received: true };
  }

  @Post('b2c-status/:payoutId/:token')
  @HttpCode(200)
  async status(
    @Param('payoutId') payoutId: string,
    @Param('token') token: string,
    @Req() request: Request,
  ): Promise<{ received: true }> {
    await this.payouts.receiveDarajaResult({
      payoutId,
      token,
      purpose: 'b2c_status',
      rawBody: request.rawBody,
      sourceIp: request.ip ?? null,
    });
    return { received: true };
  }
}
