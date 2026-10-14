import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AppError } from '../../platform/errors.js';
import { contextOf, parseBody, sessionOf, tenantOf } from '../../platform/http.js';
import { SessionGuard, StepUpGuard, WorkspaceGuard } from '../identity/guards.js';
import { Permit } from '../tenancy/permissions.js';
import {
  type ApiKeyView,
  type DeliveryView,
  DeveloperService,
  type EndpointView,
  WEBHOOK_EVENT_TYPES,
} from './developer.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keyBody = z.strictObject({
  name: z.string().trim().min(1).max(60),
  scope: z.enum(['collect', 'full']),
});
const endpointBody = z.strictObject({
  url: z.string().min(10).max(500),
  event_types: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1).max(WEBHOOK_EVENT_TYPES.length),
});

const actorOf = (request: Request): { tenantId: string; accountId: string; requestId: string } => ({
  tenantId: tenantOf(request).tenantId,
  accountId: sessionOf(request).accountId,
  requestId: contextOf(request).requestId,
});

/** Keys are made and revoked by a person with a PIN step-up; a key can never manage keys. */
@Controller('v1/api-keys')
@UseGuards(SessionGuard, WorkspaceGuard)
export class ApiKeysController {
  constructor(@Inject(DeveloperService) private readonly developer: DeveloperService) {}

  @Get()
  @Permit('api_key.read')
  async list(@Req() request: Request): Promise<{ data: ApiKeyView[] }> {
    return { data: await this.developer.listKeys(tenantOf(request).tenantId) };
  }

  @Post()
  @HttpCode(201)
  @Permit('api_key.manage')
  @UseGuards(StepUpGuard)
  create(@Body() body: unknown, @Req() request: Request): Promise<ApiKeyView & { key: string }> {
    return this.developer.createKey(actorOf(request), parseBody(keyBody, body));
  }

  @Delete(':id')
  @Permit('api_key.manage')
  @UseGuards(StepUpGuard)
  revoke(@Param('id') id: string, @Req() request: Request): Promise<ApiKeyView> {
    if (!UUID.test(id)) throw new AppError('not_found', 'API key not found.');
    return this.developer.revokeKey(actorOf(request), id);
  }
}

@Controller('v1/webhook-endpoints')
@UseGuards(SessionGuard, WorkspaceGuard)
export class WebhookEndpointsController {
  constructor(@Inject(DeveloperService) private readonly developer: DeveloperService) {}

  @Get()
  @Permit('webhook.read')
  async list(@Req() request: Request): Promise<{ data: EndpointView[] }> {
    return { data: await this.developer.listEndpoints(tenantOf(request).tenantId) };
  }

  /** Where a workspace's data is sent is a sensitive setting. */
  @Post()
  @HttpCode(201)
  @Permit('webhook.manage')
  @UseGuards(StepUpGuard)
  create(@Body() body: unknown, @Req() request: Request): Promise<EndpointView> {
    const input = parseBody(endpointBody, body);
    return this.developer.createEndpoint(actorOf(request), {
      url: input.url,
      eventTypes: input.event_types,
    });
  }
}

@Controller('v1/webhook-deliveries')
@UseGuards(SessionGuard, WorkspaceGuard)
export class WebhookDeliveriesController {
  constructor(@Inject(DeveloperService) private readonly developer: DeveloperService) {}

  @Get()
  @Permit('webhook.read')
  async list(@Req() request: Request): Promise<{ data: DeliveryView[] }> {
    return { data: await this.developer.listDeliveries(tenantOf(request).tenantId) };
  }

  @Post(':id/replay')
  @HttpCode(201)
  @Permit('webhook.manage')
  @UseGuards(StepUpGuard)
  replay(
    @Param('id') id: string,
    @Req() request: Request,
  ): Promise<{ id: string; replay_of: string }> {
    if (!UUID.test(id)) throw new AppError('not_found', 'Delivery not found.');
    return this.developer.replay(actorOf(request), id);
  }
}

/** Public: the key every AORA webhook can be verified with. */
@Controller('v1/webhook-signing-key')
export class WebhookSigningKeyController {
  constructor(@Inject(DeveloperService) private readonly developer: DeveloperService) {}

  @Get()
  get(): ReturnType<DeveloperService['publicKey']> {
    return this.developer.publicKey();
  }
}
