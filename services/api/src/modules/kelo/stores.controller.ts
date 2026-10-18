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
import { contextOf, parseBody, sessionOf } from '../../platform/http.js';
import { OperatorGuard, SessionGuard } from '../identity/guards.js';
import { RESTRICTION_KINDS, TenancyService } from '../tenancy/tenancy.service.js';
import {
  type ProvisioningStatus,
  ProvisioningService,
  type ProvisioningView,
} from './provisioning.service.js';
import { type StoreBusiness, StoresService, type StoreView } from './stores.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const line = (max: number): z.ZodString => z.string().trim().min(1).max(max);
const slug = z.string().regex(/^[a-z][a-z0-9-]{1,60}$/);
const reason = z.string().trim().min(10).max(500);

const newBusiness = {
  name: line(120),
  country: z.string().regex(/^[A-Z]{2}$/),
};
const businessBody = z.union([
  z.strictObject({ workspace_id: z.uuid() }),
  z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('registered'),
      ...newBusiness,
      registration: z.strictObject({
        type: z.string().regex(/^[a-z][a-z0-9_]{2,40}$/),
        value: line(60),
      }),
    }),
    z.strictObject({
      kind: z.literal('unregistered'),
      ...newBusiness,
      location: z.strictObject({ area: line(80), locality: line(80), place: line(120) }),
    }),
  ]),
]);
const enlistBody = z.strictObject({
  display_name: line(80),
  categories: z.array(slug).min(1).max(12),
  business: businessBody,
  // SANDBOX ONLY: scripts the sandbox verification adapter's answer (D-8).
  sandbox_kyb: z.enum(['verified', 'unverified']).optional(),
});
const decisionBody = z.strictObject({
  outcome: z.enum(['approved', 'rejected']),
  reason,
  attestations: z.record(slug, z.array(z.string().regex(/^[a-z][a-z0-9_]{2,60}$/)).max(20)),
  restrictions: z.array(z.enum(RESTRICTION_KINDS)).max(RESTRICTION_KINDS.length).default([]),
});
const storeStatus = z.strictObject({
  status: z.enum(['submitted', 'approved', 'rejected']).default('submitted'),
});
const provisioningStatus = z.strictObject({
  status: z
    .enum([
      'requested',
      'business_resolved',
      'workspace_linked',
      'admin_assigned',
      'completed',
      'failed_retryable',
      'failed_needs_review',
      'reconciliation_required',
    ])
    .default('failed_needs_review'),
});
const reasonBody = z.strictObject({ reason });

const actorOf = (request: Request) => ({
  accountId: sessionOf(request).accountId,
  requestId: contextOf(request).requestId,
});

/** A person enlisting a store on KELO (ADR 0017). */
@Controller('v1/kelo/stores')
@UseGuards(SessionGuard)
export class KeloStoresController {
  constructor(@Inject(StoresService) private readonly stores: StoresService) {}

  @Post()
  async enlist(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StoreView> {
    if (!idempotencyKey || idempotencyKey.length > 200) {
      throw new AppError(
        'idempotency_key_required',
        'An Idempotency-Key header of 1 to 200 characters is required.',
      );
    }
    const input = parseBody(enlistBody, body);
    const business: StoreBusiness =
      'workspace_id' in input.business
        ? { workspaceId: input.business.workspace_id.toLowerCase() }
        : {
            kind: input.business.kind,
            name: input.business.name,
            country: input.business.country,
            registration: input.business.kind === 'registered' ? input.business.registration : null,
            location: input.business.kind === 'unregistered' ? input.business.location : null,
            verification: input.sandbox_kyb ?? 'verified',
          };
    const result = await this.stores.enlist(actorOf(request), idempotencyKey, {
      displayName: input.display_name,
      categories: input.categories,
      business,
    });
    response.status(result.replayed ? 200 : 201);
    if (result.replayed) response.setHeader('Idempotent-Replay', 'true');
    return result.store;
  }

  @Get()
  async list(@Req() request: Request): Promise<{ data: StoreView[] }> {
    return { data: await this.stores.list(sessionOf(request).accountId) };
  }

  @Get(':id')
  get(@Param('id') id: string, @Req() request: Request): Promise<StoreView> {
    if (!UUID.test(id)) throw new AppError('not_found', 'Store not found.');
    return this.stores.get(sessionOf(request).accountId, id);
  }
}

/** The operator's vetting queue. */
@Controller('v1/ops/kelo/stores')
@UseGuards(SessionGuard, OperatorGuard)
export class KeloStoreVettingController {
  constructor(@Inject(StoresService) private readonly stores: StoresService) {}

  @Get()
  async list(@Query() query: unknown): Promise<{ data: StoreView[] }> {
    return { data: await this.stores.operatorList(parseBody(storeStatus, query).status) };
  }

  @Get(':id')
  get(@Param('id') id: string): ReturnType<StoresService['operatorGet']> {
    if (!UUID.test(id)) throw new AppError('not_found', 'Store not found.');
    return this.stores.operatorGet(id);
  }

  @Post(':id/decision')
  @HttpCode(200)
  decide(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: Request,
  ): Promise<StoreView> {
    const input = parseBody(decisionBody, body);
    if (!UUID.test(id)) throw new AppError('not_found', 'Store not found.');
    return this.stores.decide(actorOf(request), id, input);
  }
}

/** Provisioning status for support staff, with an audited retry (ADR 0008). */
@Controller('v1/ops/kelo/provisioning')
@UseGuards(SessionGuard, OperatorGuard)
export class KeloProvisioningController {
  constructor(@Inject(ProvisioningService) private readonly provisioning: ProvisioningService) {}

  @Get()
  async list(@Query() query: unknown): Promise<{ data: ProvisioningView[] }> {
    const status: ProvisioningStatus = parseBody(provisioningStatus, query).status;
    return { data: await this.provisioning.list(status) };
  }

  @Post(':id/retry')
  @HttpCode(200)
  retry(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: Request,
  ): Promise<ProvisioningView> {
    const input = parseBody(reasonBody, body);
    if (!UUID.test(id)) throw new AppError('not_found', 'Provisioning record not found.');
    return this.provisioning.retry(actorOf(request), id, input.reason);
  }
}

/** Lifting a workspace restriction is an operator's decision, with a reason. */
@Controller('v1/ops/workspaces')
@UseGuards(SessionGuard, OperatorGuard)
export class WorkspaceRestrictionsController {
  constructor(@Inject(TenancyService) private readonly tenancy: TenancyService) {}

  @Post(':id/restrictions/:kind/lift')
  @HttpCode(200)
  lift(
    @Param('id') id: string,
    @Param('kind') kind: string,
    @Body() body: unknown,
    @Req() request: Request,
  ): ReturnType<TenancyService['liftRestriction']> {
    const input = parseBody(reasonBody, body);
    const restriction = RESTRICTION_KINDS.find((entry) => entry === kind);
    if (!UUID.test(id) || !restriction)
      throw new AppError('not_found', 'No such active restriction.');
    return this.tenancy.liftRestriction(
      actorOf(request),
      id.toLowerCase(),
      restriction,
      input.reason,
    );
  }
}
