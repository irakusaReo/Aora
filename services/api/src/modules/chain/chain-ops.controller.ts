import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AppError } from '../../platform/errors.js';
import { contextOf, parseBody, sessionOf } from '../../platform/http.js';
import { OperatorGuard, SessionGuard } from '../identity/guards.js';
import { TreasuryService } from './treasury.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const attributionBody = z.strictObject({
  workspace_id: z.uuid().optional(),
  reason: z.string().trim().min(3).max(500),
});

/** Operator actions on Base Sepolia records (phase-5 plan 5C). SANDBOX. */
@Controller('v1/ops/chain')
@UseGuards(SessionGuard, OperatorGuard)
export class ChainOpsController {
  constructor(@Inject(TreasuryService) private readonly treasury: TreasuryService) {}

  /** Inbound transfers needing a person: unattributed USDC and other tokens (by default). */
  @Get('transfers')
  async transfers(
    @Query('status') status: string | undefined,
  ): Promise<{ data: Awaited<ReturnType<TreasuryService['opsTransfers']>> }> {
    const allowed = [
      'unattributed',
      'unexpected_asset',
      'credited',
      'confirmed',
      'observed',
      'dropped',
    ];
    if (status !== undefined && !allowed.includes(status)) {
      throw new AppError('invalid_request', `status must be one of ${allowed.join(', ')}.`);
    }
    return {
      data: await this.treasury.opsTransfers(
        status ? [status] : ['unattributed', 'unexpected_asset'],
      ),
    };
  }

  @Post('transfers/:id/attribution')
  @HttpCode(200)
  attribute(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: Request,
  ): ReturnType<TreasuryService['attribute']> {
    if (!UUID.test(id)) throw new AppError('not_found', 'Transfer not found.');
    const input = parseBody(attributionBody, body);
    return this.treasury.attribute(
      { accountId: sessionOf(request).accountId, requestId: contextOf(request).requestId },
      id,
      { workspaceId: input.workspace_id ?? null, reason: input.reason },
    );
  }
}
