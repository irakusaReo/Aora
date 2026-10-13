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
import { AllowRoles, OperatorGuard, SessionGuard, WorkspaceGuard } from '../identity/guards.js';
import { type IntentView, PaymentsService } from './payments.service.js';
import { type ExceptionView, ReconciliationService } from './reconciliation.service.js';
import { SCENARIOS, SIM_SIGNATURE_HEADER } from './simulator.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createBody = z.strictObject({
  // Validated by parseMinorUnits, so that a JSON number is rejected, not coerced.
  amount_minor: z.unknown(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  sandbox_scenario: z.enum(SCENARIOS).optional(),
});

@Controller('v1/payment-intents')
@UseGuards(SessionGuard, WorkspaceGuard)
export class PaymentIntentsController {
  constructor(@Inject(PaymentsService) private readonly payments: PaymentsService) {}

  @Post()
  @AllowRoles('admin', 'finance', 'cashier')
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<IntentView> {
    if (!idempotencyKey || idempotencyKey.length > 200) {
      throw new AppError(
        'idempotency_key_required',
        'An Idempotency-Key header of 1 to 200 characters is required.',
      );
    }
    const input = parseBody(createBody, body);
    const { tenantId } = tenantOf(request);
    const result = await this.payments.createIntent({
      tenantId,
      accountId: sessionOf(request).accountId,
      requestId: contextOf(request).requestId,
      idempotencyKey,
      amount: parseMinorUnits(input.amount_minor),
      assetCode: input.currency,
      scenario: input.sandbox_scenario ?? null,
    });
    response.status(result.replayed ? 200 : 201);
    if (result.replayed) response.setHeader('Idempotent-Replay', 'true');
    return result.intent;
  }

  @Get(':id')
  @AllowRoles('admin', 'finance', 'cashier')
  get(@Param('id') id: string, @Req() request: Request): Promise<IntentView> {
    if (!UUID.test(id)) throw new AppError('not_found', 'Payment intent not found.');
    return this.payments.getIntent(tenantOf(request).tenantId, id);
  }
}

@Controller('v1/webhooks')
export class WebhooksController {
  constructor(@Inject(PaymentsService) private readonly payments: PaymentsService) {}

  /** Authenticated by signature, not by session. Acknowledges fast; work happens in the worker. */
  @Post('sandbox')
  @HttpCode(200)
  async sandbox(@Req() request: Request): Promise<{ received: true }> {
    await this.payments.receiveWebhook(request.rawBody, request.header(SIM_SIGNATURE_HEADER));
    return { received: true };
  }
}

@Controller('v1/ops')
@UseGuards(SessionGuard, OperatorGuard)
export class OpsController {
  constructor(
    @Inject(ReconciliationService) private readonly reconciliation: ReconciliationService,
  ) {}

  @Post('reconciliation-runs')
  @HttpCode(201)
  run(@Req() request: Request): ReturnType<ReconciliationService['run']> {
    return this.reconciliation.run({
      accountId: sessionOf(request).accountId,
      requestId: contextOf(request).requestId,
    });
  }

  @Get('reconciliation-exceptions')
  async list(): Promise<{ data: ExceptionView[] }> {
    return { data: await this.reconciliation.listExceptions() };
  }

  @Get('reconciliation-exceptions/:id')
  get(@Param('id') id: string): Promise<ExceptionView> {
    return this.reconciliation.getException(id);
  }
}
