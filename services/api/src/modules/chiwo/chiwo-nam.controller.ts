import { Body, Controller, Get, Headers, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { contextOf, parseBody, sessionOf } from '../../platform/http.js';
import { parseMinorUnits } from '../../platform/money.js';
import { SessionGuard, StepUpGuard } from '../identity/guards.js';
import { keyOf, orderBody, redemptionBody } from '../nam/nam.controller.js';
import {
  type NamOwner,
  type NamView,
  NamService,
  type OrderView,
  type RedemptionView,
} from '../nam/nam.service.js';
import { ConsumerGuard } from './consumer.service.js';

function personOf(request: Request): NamOwner {
  return { kind: 'consumer', accountId: sessionOf(request).accountId };
}

function actorOf(request: Request): { accountId: string; requestId: string } {
  return { accountId: sessionOf(request).accountId, requestId: contextOf(request).requestId };
}

/**
 * The NAM Vault inside CHIWO (phase 7C): the same product, with a personal
 * investor profile that never meets the person's business profile (J13).
 * SANDBOX: testnet only; no return is offered.
 */
@Controller('v1/chiwo/nam')
@UseGuards(SessionGuard, ConsumerGuard)
export class ChiwoNamController {
  constructor(@Inject(NamService) private readonly nam: NamService) {}

  @Get()
  view(@Req() request: Request): Promise<NamView> {
    return this.nam.view(personOf(request));
  }

  @Post('orders')
  @UseGuards(StepUpGuard)
  async order(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OrderView> {
    const idempotencyKey = keyOf(key);
    const input = parseBody(orderBody, body);
    const result = await this.nam.createOrder(personOf(request), actorOf(request), {
      idempotencyKey,
      amount: parseMinorUnits(input.amount_minor),
      disclosureVersion: input.disclosure_version,
    });
    response.status(result.replayed ? 200 : 201);
    if (result.replayed) response.setHeader('Idempotent-Replay', 'true');
    return result.order;
  }

  @Get('orders')
  async orders(@Req() request: Request): Promise<{ data: OrderView[] }> {
    return { data: await this.nam.listOrders(personOf(request)) };
  }

  @Post('redemptions')
  @UseGuards(StepUpGuard)
  async redeem(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<RedemptionView> {
    const idempotencyKey = keyOf(key);
    const input = parseBody(redemptionBody, body);
    const result = await this.nam.createRedemption(personOf(request), actorOf(request), {
      idempotencyKey,
      shares: 'all' in input ? 'all' : BigInt(input.shares),
    });
    response.status(result.replayed ? 200 : 201);
    if (result.replayed) response.setHeader('Idempotent-Replay', 'true');
    return result.redemption;
  }

  @Get('redemptions')
  async redemptions(@Req() request: Request): Promise<{ data: RedemptionView[] }> {
    return { data: await this.nam.listRedemptions(personOf(request)) };
  }
}
