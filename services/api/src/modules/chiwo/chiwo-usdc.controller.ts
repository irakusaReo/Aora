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
import type { AddressView, PersonalUsdcView, WithdrawalView } from '../chain/treasury.service.js';
import { TreasuryService } from '../chain/treasury.service.js';
import { SessionGuard, StepUpGuard } from '../identity/guards.js';
import { ConsumerGuard } from './consumer.service.js';
import { type PaymentRequestView, RequestsService } from './requests.service.js';
import { type RecipientView, type TransferView, UsdcService } from './usdc.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHONE = z.string().regex(/^\+[1-9][0-9]{7,14}$/);
const NOTE = z.string().trim().min(1).max(140);

const registerBody = z.strictObject({
  challenge_id: z.uuid(),
  address: z.string().min(1).max(64),
  signature: z.string().min(1).max(300),
  label: z.string().trim().min(1).max(60).optional(),
});
const withdrawBody = z.strictObject({ amount_minor: z.unknown(), address_id: z.uuid() });
const recipientBody = z.strictObject({ phone: PHONE });
const transferBody = z.strictObject({
  recipient_id: z.uuid(),
  amount_minor: z.unknown(),
  note: NOTE.optional(),
});
const requestBody = z.strictObject({
  amount_minor: z.unknown(),
  note: NOTE.optional(),
  payer_phone: PHONE.optional(),
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

function uuidOr404(id: string, what: string): string {
  if (!UUID.test(id)) throw new AppError('not_found', `${what} not found.`);
  return id;
}

/**
 * CHIWO personal USDC, transfers between consumers and payment requests
 * (phase 7B). Personal routes: no workspace, ever (P7-1). Anything that moves
 * money needs a PIN step-up.
 */
@Controller('v1/chiwo')
@UseGuards(SessionGuard, ConsumerGuard)
export class ChiwoUsdcController {
  constructor(
    @Inject(UsdcService) private readonly usdc: UsdcService,
    @Inject(RequestsService) private readonly requests: RequestsService,
    @Inject(TreasuryService) private readonly treasury: TreasuryService,
  ) {}

  @Get('usdc')
  view(@Req() request: Request): Promise<PersonalUsdcView> {
    return this.usdc.overview(sessionOf(request).accountId);
  }

  @Post('usdc/address-challenges')
  @HttpCode(201)
  challenge(@Req() request: Request): Promise<{ id: string; message: string; expires_at: string }> {
    return this.treasury.createPersonalChallenge(sessionOf(request).accountId);
  }

  @Post('usdc/addresses')
  @HttpCode(201)
  register(@Body() body: unknown, @Req() request: Request): Promise<AddressView> {
    const input = parseBody(registerBody, body);
    return this.treasury.registerPersonalAddress(
      { accountId: sessionOf(request).accountId, requestId: contextOf(request).requestId },
      {
        challengeId: input.challenge_id,
        address: input.address,
        signature: input.signature,
        label: input.label ?? null,
      },
    );
  }

  @Post('usdc/withdrawals')
  @UseGuards(StepUpGuard)
  async withdraw(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<WithdrawalView> {
    const key = idempotencyKeyOf(idempotencyKey);
    const input = parseBody(withdrawBody, body);
    const result = await this.usdc.withdraw(
      { accountId: sessionOf(request).accountId, requestId: contextOf(request).requestId },
      {
        idempotencyKey: key,
        amount: parseMinorUnits(input.amount_minor),
        addressId: input.address_id,
      },
    );
    response.status(result.replayed ? 200 : 201);
    return result.withdrawal;
  }

  @Get('recipients')
  async recipients(@Req() request: Request): Promise<{ data: RecipientView[] }> {
    return { data: await this.usdc.listRecipients(sessionOf(request).accountId) };
  }

  @Post('recipients')
  async addRecipient(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<RecipientView> {
    const input = parseBody(recipientBody, body);
    const result = await this.usdc.addRecipient(sessionOf(request).accountId, input.phone);
    response.status(result.created ? 201 : 200);
    return result.view;
  }

  @Post('recipients/:id/confirm')
  @HttpCode(200)
  @UseGuards(StepUpGuard)
  confirmRecipient(@Param('id') id: string, @Req() request: Request): Promise<RecipientView> {
    return this.usdc.confirmRecipient(
      { accountId: sessionOf(request).accountId, requestId: contextOf(request).requestId },
      uuidOr404(id, 'Recipient'),
    );
  }

  @Post('transfers')
  @UseGuards(StepUpGuard)
  async send(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<TransferView> {
    const key = idempotencyKeyOf(idempotencyKey);
    const input = parseBody(transferBody, body);
    const result = await this.usdc.send(
      { accountId: sessionOf(request).accountId, requestId: contextOf(request).requestId },
      {
        idempotencyKey: key,
        recipientId: input.recipient_id,
        amount: parseMinorUnits(input.amount_minor),
        note: input.note ?? null,
      },
    );
    response.status(result.replayed ? 200 : 201);
    if (result.replayed) response.setHeader('Idempotent-Replay', 'true');
    return result.transfer;
  }

  @Get('requests')
  async listRequests(@Req() request: Request): Promise<{ data: PaymentRequestView[] }> {
    return { data: await this.requests.list(sessionOf(request).accountId) };
  }

  @Post('requests')
  @HttpCode(201)
  createRequest(@Body() body: unknown, @Req() request: Request): Promise<PaymentRequestView> {
    const input = parseBody(requestBody, body);
    return this.requests.create(
      { accountId: sessionOf(request).accountId, requestId: contextOf(request).requestId },
      {
        amount: parseMinorUnits(input.amount_minor),
        note: input.note ?? null,
        payerPhone: input.payer_phone ?? null,
      },
    );
  }

  @Get('requests/:id')
  getRequest(@Param('id') id: string, @Req() request: Request): Promise<PaymentRequestView> {
    return this.requests.get(sessionOf(request).accountId, uuidOr404(id, 'Request'));
  }

  @Post('requests/:id/cancel')
  @HttpCode(200)
  cancel(@Param('id') id: string, @Req() request: Request): Promise<PaymentRequestView> {
    return this.requests.cancel(
      { accountId: sessionOf(request).accountId, requestId: contextOf(request).requestId },
      uuidOr404(id, 'Request'),
    );
  }

  @Post('requests/:id/pay')
  @HttpCode(200)
  @UseGuards(StepUpGuard)
  async pay(
    @Param('id') id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PaymentRequestView & { transfer: TransferView }> {
    const key = idempotencyKeyOf(idempotencyKey);
    const result = await this.requests.pay(
      { accountId: sessionOf(request).accountId, requestId: contextOf(request).requestId },
      uuidOr404(id, 'Request'),
      key,
    );
    if (result.replayed) response.setHeader('Idempotent-Replay', 'true');
    return { ...result.request, transfer: result.transfer };
  }
}
