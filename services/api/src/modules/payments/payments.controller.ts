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
import { OperatorGuard, SessionGuard, WorkspaceGuard } from '../identity/guards.js';
import { Permit } from '../tenancy/permissions.js';
import { type IntentView, PaymentsService } from './payments.service.js';
import { type ExceptionView, ReconciliationService } from './reconciliation.service.js';
import { SCENARIOS, SIM_SIGNATURE_HEADER } from './simulator.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RAIL = /^[a-z][a-z0-9_]{1,30}$/;
/** The rail a collection uses when the request names none. */
const DEFAULT_RAIL = 'mpesa';

const createBody = z.strictObject({
  // Validated by parseMinorUnits, so that a JSON number is rejected, not coerced.
  amount_minor: z.unknown(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  rail: z.string().regex(RAIL).optional(),
  branch_id: z.uuid().optional(),
  // The merchant's own label for the sale: an order, a counter, a vehicle (lessons §5).
  reference: z.string().trim().min(1).max(64).optional(),
  sandbox_scenario: z.enum(SCENARIOS).optional(),
});
const listQuery = z.strictObject({
  branch_id: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(200).optional(),
});
const exceptionQuery = z.strictObject({ status: z.enum(['open', 'resolved']).optional() });
const resolutionBody = z.strictObject({
  resolution: z.enum(['corrected', 'accepted', 'false_positive']),
  reason: z.string().trim().min(10).max(500),
});
const quoteQuery = z.strictObject({
  operation: z.literal('collection'),
  rail: z.string().regex(RAIL),
  currency: z.string().regex(/^[A-Z]{3}$/),
  amount_minor: z.unknown(),
});

@Controller('v1/payment-intents')
@UseGuards(SessionGuard, WorkspaceGuard)
export class PaymentIntentsController {
  constructor(@Inject(PaymentsService) private readonly payments: PaymentsService) {}

  @Post()
  @Permit('payment_intent.create')
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
    const { tenantId, role, branchId } = tenantOf(request);
    // A cashier collects for their own branch and no other.
    if (role === 'cashier' && input.branch_id !== undefined && input.branch_id !== branchId) {
      throw new AppError('forbidden', 'You do not have access to this workspace or action.');
    }
    const result = await this.payments.createIntent({
      tenantId,
      accountId: sessionOf(request).accountId,
      requestId: contextOf(request).requestId,
      idempotencyKey,
      amount: parseMinorUnits(input.amount_minor),
      assetCode: input.currency,
      rail: input.rail ?? DEFAULT_RAIL,
      branchId: role === 'cashier' ? branchId : (input.branch_id ?? null),
      reference: input.reference ?? null,
      scenario: input.sandbox_scenario ?? null,
    });
    response.status(result.replayed ? 200 : 201);
    if (result.replayed) response.setHeader('Idempotent-Replay', 'true');
    return result.intent;
  }

  @Get()
  @Permit('payment_intent.read')
  list(
    @Query() query: unknown,
    @Req() request: Request,
  ): Promise<{ data: IntentView[]; next_cursor: string | null }> {
    const input = parseBody(listQuery, query);
    const { tenantId, role, branchId } = tenantOf(request);
    return this.payments.listIntents(tenantId, {
      ...(role === 'cashier' ? { branchScope: branchId } : {}),
      ...(input.branch_id ? { branchId: input.branch_id } : {}),
      limit: input.limit,
      ...(input.cursor ? { cursor: input.cursor } : {}),
    });
  }

  @Get(':id')
  @Permit('payment_intent.read')
  get(@Param('id') id: string, @Req() request: Request): Promise<IntentView> {
    if (!UUID.test(id)) throw new AppError('not_found', 'Payment intent not found.');
    const { tenantId, role, branchId } = tenantOf(request);
    return role === 'cashier'
      ? this.payments.getIntent(tenantId, id, branchId)
      : this.payments.getIntent(tenantId, id);
  }
}

@Controller('v1/tariffs')
@UseGuards(SessionGuard, WorkspaceGuard)
export class TariffsController {
  constructor(@Inject(PaymentsService) private readonly payments: PaymentsService) {}

  /** What a collection of this amount would cost right now: gross, fee and net. */
  @Get('quote')
  @Permit('tariff.read')
  quote(
    @Query() query: unknown,
    @Req() request: Request,
  ): ReturnType<PaymentsService['quoteCollection']> {
    const input = parseBody(quoteQuery, query);
    return this.payments.quoteCollection(tenantOf(request).tenantId, {
      rail: input.rail,
      assetCode: input.currency,
      amount: parseMinorUnits(input.amount_minor),
    });
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
  async list(@Query() query: unknown): Promise<{ data: ExceptionView[] }> {
    const input = parseBody(exceptionQuery, query);
    return { data: await this.reconciliation.listExceptions(input.status) };
  }

  /** An operator's judgement, with a reason. Audited; final; moves no money. */
  @Post('reconciliation-exceptions/:id/resolution')
  @HttpCode(200)
  resolve(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: Request,
  ): Promise<ExceptionView> {
    const input = parseBody(resolutionBody, body);
    if (!UUID.test(id)) throw new AppError('not_found', 'Reconciliation exception not found.');
    return this.reconciliation.resolve(
      { accountId: sessionOf(request).accountId, requestId: contextOf(request).requestId },
      id,
      input,
    );
  }

  @Get('reconciliation-exceptions/:id')
  get(@Param('id') id: string): Promise<ExceptionView> {
    return this.reconciliation.getException(id);
  }
}
