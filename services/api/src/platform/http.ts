import { randomUUID } from 'node:crypto';
import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  type NestMiddleware,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { map, type Observable } from 'rxjs';
import type { z } from 'zod';
import { AppError } from './errors.js';

export type Role = 'admin' | 'finance' | 'cashier';

export interface Membership {
  readonly tenantId: string;
  readonly role: Role;
  /** The branch a member is tied to; a cashier acts and sees within it only. */
  readonly branchId: string | null;
}

export interface SessionContext {
  readonly sessionId: string;
  readonly accountId: string;
  readonly isPlatformOperator: boolean;
  readonly stepUpUntil: Date | null;
  /** Minutes since the sign-in factor was last verified on this session; null if unknown. */
  readonly firstFactorAgeMinutes: number | null;
  readonly memberships: readonly Membership[];
  /** Set when the request authenticated with an API key instead of a person's session (ADR 0023). */
  readonly apiKeyId?: string;
}

export interface RequestContext {
  requestId: string;
  session?: SessionContext;
  tenantId?: string;
  role?: Role;
  branchId?: string | null;
}

declare global {
  // Express's documented extension point for request properties.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      aora?: RequestContext;
      rawBody?: Buffer;
    }
  }
}

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const requestId = randomUUID();
    request.aora = { requestId };
    response.setHeader('Aora-Request-Id', requestId);
    response.setHeader('Aora-Mode', 'sandbox');
    next();
  }
}

/** Every JSON object the API returns says it is sandbox data (CLAUDE.md rule 10). */
@Injectable()
export class SandboxLabelInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next
      .handle()
      .pipe(
        map((body: unknown) =>
          typeof body === 'object' && body !== null && !Array.isArray(body)
            ? { ...body, mode: 'sandbox' }
            : body,
        ),
      );
  }
}

export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.join('.') || 'body').join(', ');
    throw new AppError('invalid_request', `Invalid request: ${fields}.`);
  }
  return result.data;
}

export function contextOf(request: Request): RequestContext {
  if (!request.aora) {
    throw new AppError('internal_error', 'Request context missing.');
  }
  return request.aora;
}

export function sessionOf(request: Request): SessionContext {
  const session = contextOf(request).session;
  if (!session) {
    throw new AppError('unauthenticated', 'Sign in required.');
  }
  return session;
}

export function tenantOf(request: Request): {
  tenantId: string;
  role: Role;
  branchId: string | null;
} {
  const { tenantId, role, branchId } = contextOf(request);
  if (!tenantId || !role) {
    throw new AppError('forbidden', 'Workspace access required.');
  }
  return { tenantId, role, branchId: branchId ?? null };
}
