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
import { contextOf, parseBody, sessionOf } from '../../platform/http.js';
import { OperatorGuard, SessionGuard } from '../identity/guards.js';
import { type ApplicationView, OnboardingService, type ReviewView } from './onboarding.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const line = (max: number): z.ZodString => z.string().trim().min(1).max(max);

const common = {
  name: line(120),
  country: z.string().regex(/^[A-Z]{2}$/),
  // SANDBOX ONLY: scripts the sandbox verification adapter's answer.
  sandbox_kyb: z.enum(['verified', 'unverified']).optional(),
};
const applicationBody = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('registered'),
    ...common,
    registration: z.strictObject({
      type: z.string().regex(/^[a-z][a-z0-9_]{2,40}$/),
      value: line(60),
    }),
  }),
  z.strictObject({
    kind: z.literal('unregistered'),
    ...common,
    location: z.strictObject({ area: line(80), locality: line(80), place: line(120) }),
  }),
]);
const decisionBody = z.strictObject({
  outcome: z.enum(['distinct', 'same']),
  reason: z.string().trim().min(10).max(500),
});

/** A person applying to bring their business onto AORA. No workspace exists yet. */
@Controller('v1/onboarding/applications')
@UseGuards(SessionGuard)
export class OnboardingController {
  constructor(@Inject(OnboardingService) private readonly onboarding: OnboardingService) {}

  @Post()
  async apply(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ApplicationView> {
    if (!idempotencyKey || idempotencyKey.length > 200) {
      throw new AppError(
        'idempotency_key_required',
        'An Idempotency-Key header of 1 to 200 characters is required.',
      );
    }
    const input = parseBody(applicationBody, body);
    const result = await this.onboarding.apply(
      { accountId: sessionOf(request).accountId, requestId: contextOf(request).requestId },
      idempotencyKey,
      {
        kind: input.kind,
        name: input.name,
        country: input.country,
        registration: input.kind === 'registered' ? input.registration : null,
        location: input.kind === 'unregistered' ? input.location : null,
        verification: input.sandbox_kyb ?? 'verified',
      },
    );
    response.status(result.replayed ? 200 : 201);
    if (result.replayed) response.setHeader('Idempotent-Replay', 'true');
    return result.application;
  }

  @Get()
  async list(@Req() request: Request): Promise<{ data: ApplicationView[] }> {
    return { data: await this.onboarding.list(sessionOf(request).accountId) };
  }

  @Get(':id')
  get(@Param('id') id: string, @Req() request: Request): Promise<ApplicationView> {
    if (!UUID.test(id)) throw new AppError('not_found', 'Application not found.');
    return this.onboarding.get(sessionOf(request).accountId, id);
  }
}

/** The operator's queue of possible duplicate businesses (ADR 0012 rule 3). */
@Controller('v1/ops/onboarding-reviews')
@UseGuards(SessionGuard, OperatorGuard)
export class OnboardingReviewsController {
  constructor(@Inject(OnboardingService) private readonly onboarding: OnboardingService) {}

  @Get()
  async list(): Promise<{ data: ReviewView[] }> {
    return { data: await this.onboarding.reviewQueue() };
  }

  @Post(':id/decision')
  @HttpCode(200)
  decide(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: Request,
  ): Promise<ApplicationView> {
    const input = parseBody(decisionBody, body);
    if (!UUID.test(id)) throw new AppError('not_found', 'Application not found.');
    return this.onboarding.decide(
      { accountId: sessionOf(request).accountId, requestId: contextOf(request).requestId },
      id,
      input,
    );
  }
}
