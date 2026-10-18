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
import {
  type Actor,
  type AddressView,
  type TransferView,
  type TreasuryView,
  TreasuryService,
  type WithdrawalView,
} from './treasury.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADDRESS = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

const registerBody = z.strictObject({
  challenge_id: z.uuid(),
  address: ADDRESS,
  signature: z.string().regex(/^0x[0-9a-fA-F]{2,400}$/),
  label: z.string().trim().min(1).max(60).optional(),
});
const withdrawalBody = z.strictObject({ amount_minor: z.unknown(), destination: ADDRESS });
const rejectBody = z.strictObject({ reason: z.string().trim().min(1).max(500) });

function actorOf(request: Request): Actor {
  return {
    tenantId: tenantOf(request).tenantId,
    accountId: sessionOf(request).accountId,
    requestId: contextOf(request).requestId,
  };
}

function idOf(id: string, what: string): string {
  if (!UUID.test(id)) throw new AppError('not_found', `${what} not found.`);
  return id;
}

/** KONY USDC treasury on Base Sepolia (phase-5 plan 5C). SANDBOX: testnet only. */
@Controller('v1/treasury')
@UseGuards(SessionGuard, WorkspaceGuard)
export class TreasuryController {
  constructor(@Inject(TreasuryService) private readonly treasury: TreasuryService) {}

  @Get()
  @Permit('treasury.read')
  view(@Req() request: Request): Promise<TreasuryView> {
    return this.treasury.view(tenantOf(request).tenantId);
  }

  @Post('address-challenges')
  @Permit('treasury.manage')
  challenge(@Req() request: Request): ReturnType<TreasuryService['createChallenge']> {
    return this.treasury.createChallenge(actorOf(request));
  }

  @Post('addresses')
  @Permit('treasury.manage')
  @UseGuards(StepUpGuard)
  register(@Body() body: unknown, @Req() request: Request): Promise<AddressView> {
    const input = parseBody(registerBody, body);
    return this.treasury.registerAddress(actorOf(request), {
      challengeId: input.challenge_id,
      address: input.address,
      signature: input.signature,
      label: input.label ?? null,
    });
  }

  @Get('addresses')
  @Permit('treasury.read')
  async addresses(@Req() request: Request): Promise<{ data: AddressView[] }> {
    return { data: await this.treasury.listAddresses(tenantOf(request).tenantId) };
  }

  @Post('addresses/:id/revocation')
  @HttpCode(200)
  @Permit('treasury.manage')
  @UseGuards(StepUpGuard)
  revoke(@Param('id') id: string, @Req() request: Request): Promise<AddressView> {
    return this.treasury.revokeAddress(actorOf(request), idOf(id, 'Address'));
  }

  @Get('transfers')
  @Permit('treasury.read')
  async transfers(@Req() request: Request): Promise<{ data: TransferView[] }> {
    return { data: await this.treasury.listTransfers(tenantOf(request).tenantId) };
  }

  @Post('withdrawals')
  @Permit('treasury.withdraw')
  @UseGuards(StepUpGuard)
  async withdraw(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<WithdrawalView> {
    if (!key || key.length > 200) {
      throw new AppError(
        'idempotency_key_required',
        'An Idempotency-Key header of 1 to 200 characters is required.',
      );
    }
    const input = parseBody(withdrawalBody, body);
    const result = await this.treasury.createWithdrawal(actorOf(request), {
      idempotencyKey: key,
      amount: parseMinorUnits(input.amount_minor),
      destination: input.destination,
    });
    response.status(result.replayed ? 200 : 201);
    if (result.replayed) response.setHeader('Idempotent-Replay', 'true');
    return result.withdrawal;
  }

  @Get('withdrawals')
  @Permit('treasury.read')
  async withdrawals(@Req() request: Request): Promise<{ data: WithdrawalView[] }> {
    return { data: await this.treasury.listWithdrawals(tenantOf(request).tenantId) };
  }

  @Post('withdrawals/:id/approval')
  @HttpCode(200)
  @Permit('treasury.approve')
  @UseGuards(StepUpGuard)
  approve(@Param('id') id: string, @Req() request: Request): Promise<WithdrawalView> {
    return this.treasury.approve(actorOf(request), idOf(id, 'Withdrawal'));
  }

  @Post('withdrawals/:id/rejection')
  @HttpCode(200)
  @Permit('treasury.approve')
  reject(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: Request,
  ): Promise<WithdrawalView> {
    const input = parseBody(rejectBody, body);
    return this.treasury.reject(actorOf(request), idOf(id, 'Withdrawal'), input.reason);
  }
}
