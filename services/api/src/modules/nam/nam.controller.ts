import { Body, Controller, Get, Headers, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AppError } from '../../platform/errors.js';
import { contextOf, parseBody, sessionOf, tenantOf } from '../../platform/http.js';
import { parseMinorUnits } from '../../platform/money.js';
import { SessionGuard, StepUpGuard, WorkspaceGuard } from '../identity/guards.js';
import { Permit } from '../tenancy/permissions.js';
import {
  type Actor,
  type NamOwner,
  type NamView,
  NamService,
  type OrderView,
  type RedemptionView,
} from './nam.service.js';

export const orderBody = z.strictObject({
  amount_minor: z.unknown(),
  disclosure_version: z.string().min(1).max(40),
});
export const redemptionBody = z.union([
  z.strictObject({ shares: z.string().regex(/^[1-9][0-9]{0,77}$/) }),
  z.strictObject({ all: z.literal(true) }),
]);

function actorOf(request: Request): Actor {
  return { accountId: sessionOf(request).accountId, requestId: contextOf(request).requestId };
}

function workspaceOf(request: Request): NamOwner {
  return { kind: 'workspace', tenantId: tenantOf(request).tenantId };
}

export function keyOf(key: string | undefined): string {
  if (!key || key.length > 200) {
    throw new AppError(
      'idempotency_key_required',
      'An Idempotency-Key header of 1 to 200 characters is required.',
    );
  }
  return key;
}

/** NAM Vault for KONY workspaces (phase 6). SANDBOX: testnet only; no return is offered. */
@Controller('v1/nam')
@UseGuards(SessionGuard, WorkspaceGuard)
export class NamController {
  constructor(@Inject(NamService) private readonly nam: NamService) {}

  @Get()
  @Permit('nam.read')
  view(@Req() request: Request): Promise<NamView> {
    return this.nam.view(workspaceOf(request));
  }

  @Post('orders')
  @Permit('nam.invest')
  @UseGuards(StepUpGuard)
  async order(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OrderView> {
    const idempotencyKey = keyOf(key);
    const input = parseBody(orderBody, body);
    const result = await this.nam.createOrder(workspaceOf(request), actorOf(request), {
      idempotencyKey,
      amount: parseMinorUnits(input.amount_minor),
      disclosureVersion: input.disclosure_version,
    });
    response.status(result.replayed ? 200 : 201);
    if (result.replayed) response.setHeader('Idempotent-Replay', 'true');
    return result.order;
  }

  @Get('orders')
  @Permit('nam.read')
  async orders(@Req() request: Request): Promise<{ data: OrderView[] }> {
    return { data: await this.nam.listOrders(workspaceOf(request)) };
  }

  @Post('redemptions')
  @Permit('nam.invest')
  @UseGuards(StepUpGuard)
  async redeem(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<RedemptionView> {
    const idempotencyKey = keyOf(key);
    const input = parseBody(redemptionBody, body);
    const result = await this.nam.createRedemption(workspaceOf(request), actorOf(request), {
      idempotencyKey,
      shares: 'all' in input ? 'all' : BigInt(input.shares),
    });
    response.status(result.replayed ? 200 : 201);
    if (result.replayed) response.setHeader('Idempotent-Replay', 'true');
    return result.redemption;
  }

  @Get('redemptions')
  @Permit('nam.read')
  async redemptions(@Req() request: Request): Promise<{ data: RedemptionView[] }> {
    return { data: await this.nam.listRedemptions(workspaceOf(request)) };
  }
}
