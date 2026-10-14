import { Body, Controller, Get, HttpCode, Inject, Post, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { Database } from '../../platform/database.js';
import { contextOf, parseBody, sessionOf } from '../../platform/http.js';
import { RateLimiter } from '../../platform/rate-limit.js';
import { SessionGuard } from './guards.js';
import { IdentityService } from './identity.service.js';

const pinBody = z.strictObject({ pin: z.string().max(12) });
const stepUpBody = z.strictObject({ pin: z.string().min(1).max(12) });
const phoneBody = z.strictObject({ phone: z.string().max(20) });

// Sign-in, sign-out and account recovery are the identity provider's (ADR 0019).
// These routes are what stays AORA's: who you are here, and the transaction PIN.
@Controller('v1')
@UseGuards(SessionGuard)
export class IdentityController {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(Database) private readonly db: Database,
  ) {}

  /** Assets and their minor-unit exponents, so no screen assumes two decimal places. */
  @Get('assets')
  async assets(): Promise<{ data: { code: string; kind: string; exponent: number }[] }> {
    const rows = await this.db.asPlatform((tx) => tx.asset.findMany({ orderBy: { code: 'asc' } }));
    return {
      data: rows.map((row) => ({ code: row.code, kind: row.kind, exponent: row.exponent })),
    };
  }

  @Get('me')
  async me(@Req() request: Request): Promise<{
    account_id: string;
    is_platform_operator: boolean;
    memberships: { workspace_id: string; role: string }[];
    phone_set: boolean;
  }> {
    // Contact details are not returned here; the phone number is shown masked by PUT /v1/me/phone.
    const session = sessionOf(request);
    return {
      account_id: session.accountId,
      is_platform_operator: session.isPlatformOperator,
      memberships: session.memberships.map((entry) => ({
        workspace_id: entry.tenantId,
        role: entry.role,
      })),
      // Lets an app ask for the phone number (the financial identity) until it is set.
      phone_set: await this.db.asPlatform(async (tx) => {
        const account = await tx.user_account.findUniqueOrThrow({
          where: { id: session.accountId },
          select: { phone_e164: true },
        });
        return account.phone_e164 !== null;
      }),
    };
  }

  /** The phone number is AORA's to hold: the payment identifier, not a sign-in credential. */
  @Put('me/phone')
  @HttpCode(200)
  setPhone(
    @Body() body: unknown,
    @Req() request: Request,
  ): Promise<{ phone_hint: string; phone_verified: boolean }> {
    const input = parseBody(phoneBody, body);
    return this.identity.setPhone(sessionOf(request), input.phone, contextOf(request).requestId);
  }

  @Put('auth/pin')
  @HttpCode(200)
  async setPin(@Body() body: unknown, @Req() request: Request): Promise<{ pin_set: true }> {
    const input = parseBody(pinBody, body);
    await this.identity.setPin(sessionOf(request), input.pin, contextOf(request).requestId);
    return { pin_set: true };
  }

  @Post('auth/step-up')
  @HttpCode(200)
  async stepUp(@Body() body: unknown, @Req() request: Request): Promise<{ step_up_until: string }> {
    const input = parseBody(stepUpBody, body);
    const session = sessionOf(request);
    await this.limiter.consume('pin_step_up_account', session.accountId);
    const until = await this.identity.stepUp(session, input.pin, contextOf(request).requestId);
    return { step_up_until: until.toISOString() };
  }
}
