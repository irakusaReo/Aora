import { Body, Controller, Get, HttpCode, Inject, Post, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
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
  ) {}

  @Get('me')
  me(@Req() request: Request): {
    account_id: string;
    is_platform_operator: boolean;
    memberships: { workspace_id: string; role: string }[];
  } {
    // Contact details are not returned here; the phone number is shown masked by PUT /v1/me/phone.
    const session = sessionOf(request);
    return {
      account_id: session.accountId,
      is_platform_operator: session.isPlatformOperator,
      memberships: session.memberships.map((entry) => ({
        workspace_id: entry.tenantId,
        role: entry.role,
      })),
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
