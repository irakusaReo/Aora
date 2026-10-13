import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { contextOf, parseBody, sessionOf } from '../../platform/http.js';
import { RateLimiter } from '../../platform/rate-limit.js';
import { SessionGuard } from './guards.js';
import { IdentityService } from './identity.service.js';

const phone = z.string().regex(/^\+[1-9][0-9]{7,14}$/);
const challengeBody = z.strictObject({ phone });
const sessionBody = z.strictObject({ challenge_id: z.string(), code: z.string().min(1).max(12) });
const pinBody = z.strictObject({
  pin: z.string().max(12),
  challenge_id: z.string(),
  code: z.string().min(1).max(12),
});
const stepUpBody = z.strictObject({ pin: z.string().min(1).max(12) });

function addressOf(request: Request): string {
  return request.ip ?? 'unknown';
}

@Controller('v1')
export class IdentityController {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  @Post('auth/challenges')
  @HttpCode(201)
  async startSignIn(
    @Body() body: unknown,
    @Req() request: Request,
  ): Promise<{ challenge_id: string }> {
    const input = parseBody(challengeBody, body);
    await this.limiter.consume('sign_in_start_address', addressOf(request));
    // Counted for every number, registered or not, so the limit reveals nothing.
    await this.limiter.consume('sign_in_start_phone', input.phone);
    return { challenge_id: await this.identity.startChallenge(input.phone, 'sign_in') };
  }

  @Post('auth/sessions')
  @HttpCode(201)
  async createSession(
    @Body() body: unknown,
    @Req() request: Request,
  ): Promise<{ token: string; expires_at: string }> {
    const input = parseBody(sessionBody, body);
    await this.limiter.consume('sign_in_verify_address', addressOf(request));
    const session = await this.identity.createSession(
      input.challenge_id,
      input.code,
      contextOf(request).requestId,
    );
    return { token: session.token, expires_at: session.expiresAt.toISOString() };
  }

  @Delete('auth/session')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async signOut(@Req() request: Request): Promise<void> {
    await this.identity.signOut(sessionOf(request), contextOf(request).requestId);
  }

  @Post('auth/pin/challenges')
  @HttpCode(201)
  @UseGuards(SessionGuard)
  async startPinChange(@Req() request: Request): Promise<{ challenge_id: string }> {
    const session = sessionOf(request);
    await this.limiter.consume('pin_code_account', session.accountId);
    return { challenge_id: await this.identity.startPinChallenge(session.accountId) };
  }

  @Put('auth/pin')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async setPin(@Body() body: unknown, @Req() request: Request): Promise<{ pin_set: true }> {
    const input = parseBody(pinBody, body);
    await this.identity.setPin(
      sessionOf(request),
      { pin: input.pin, challengeId: input.challenge_id, code: input.code },
      contextOf(request).requestId,
    );
    return { pin_set: true };
  }

  @Post('auth/step-up')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async stepUp(@Body() body: unknown, @Req() request: Request): Promise<{ step_up_until: string }> {
    const input = parseBody(stepUpBody, body);
    const session = sessionOf(request);
    await this.limiter.consume('pin_step_up_account', session.accountId);
    const until = await this.identity.stepUp(session, input.pin, contextOf(request).requestId);
    return { step_up_until: until.toISOString() };
  }

  @Get('me')
  @UseGuards(SessionGuard)
  me(@Req() request: Request): {
    account_id: string;
    is_platform_operator: boolean;
    memberships: { workspace_id: string; role: string }[];
  } {
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
}
