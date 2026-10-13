import { Body, Controller, Get, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { contextOf, parseBody, sessionOf } from '../../platform/http.js';
import { SessionGuard } from './guards.js';
import { IdentityService } from './identity.service.js';

const phone = z.string().regex(/^\+[1-9][0-9]{7,14}$/);
const challengeBody = z.strictObject({ phone });
const sessionBody = z.strictObject({ challenge_id: z.string(), code: z.string().min(1).max(12) });

@Controller('v1')
export class IdentityController {
  constructor(@Inject(IdentityService) private readonly identity: IdentityService) {}

  @Post('auth/challenges')
  @HttpCode(201)
  async startSignIn(@Body() body: unknown): Promise<{ challenge_id: string }> {
    const input = parseBody(challengeBody, body);
    return { challenge_id: await this.identity.startChallenge(input.phone, 'sign_in') };
  }

  @Post('auth/sessions')
  @HttpCode(201)
  async createSession(
    @Body() body: unknown,
    @Req() request: Request,
  ): Promise<{ token: string; expires_at: string }> {
    const input = parseBody(sessionBody, body);
    const session = await this.identity.createSession(
      input.challenge_id,
      input.code,
      contextOf(request).requestId,
    );
    return { token: session.token, expires_at: session.expiresAt.toISOString() };
  }

  @Post('auth/step-up/challenges')
  @HttpCode(201)
  @UseGuards(SessionGuard)
  async startStepUp(@Req() request: Request): Promise<{ challenge_id: string }> {
    const session = sessionOf(request);
    return { challenge_id: await this.identity.startStepUpFor(session.accountId) };
  }

  @Post('auth/step-up')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async stepUp(@Body() body: unknown, @Req() request: Request): Promise<{ step_up_until: string }> {
    const input = parseBody(sessionBody, body);
    const until = await this.identity.stepUp(
      sessionOf(request),
      input.challenge_id,
      input.code,
      contextOf(request).requestId,
    );
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
