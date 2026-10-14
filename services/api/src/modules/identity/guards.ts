import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppError } from '../../platform/errors.js';
import { contextOf, sessionOf } from '../../platform/http.js';
import { PERMISSION_METADATA, type Permission, rolesFor } from '../tenancy/permissions.js';
import { DeveloperService } from '../developer/developer.service.js';
import { IdentityService } from './identity.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * Requires a valid session token, or an API key (ADR 0023). A key acts in its
 * own workspace only, with a fixed scope mapped onto an existing role, and only
 * on workspace routes; it has no PIN, so it can never pass a step-up.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(DeveloperService) private readonly developer: DeveloperService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (token.startsWith('aora_sk_')) {
      const key = await this.developer.authenticateKey(token);
      if (!key) throw new AppError('unauthenticated', 'Sign in required.');
      const guards = [
        ...((this.reflector.get<unknown[] | undefined>('__guards__', context.getClass()) ?? []) as {
          name?: string;
        }[]),
        ...((this.reflector.get<unknown[] | undefined>('__guards__', context.getHandler()) ??
          []) as { name?: string }[]),
      ];
      if (!guards.some((guard) => guard.name === 'WorkspaceGuard')) {
        throw new AppError('forbidden', 'API keys can only be used on workspace routes.');
      }
      contextOf(request).session = {
        sessionId: `api_key:${key.apiKeyId}`,
        accountId: key.createdBy,
        isPlatformOperator: false,
        stepUpUntil: null,
        firstFactorAgeMinutes: null,
        apiKeyId: key.apiKeyId,
        memberships: [
          {
            tenantId: key.tenantId,
            role: key.scope === 'collect' ? 'cashier' : 'finance',
            branchId: null,
          },
        ],
      };
      return true;
    }
    const session = token ? await this.identity.authenticate(token) : null;
    if (!session) throw new AppError('unauthenticated', 'Sign in required.');
    contextOf(request).session = session;
    return true;
  }
}

/**
 * Requires membership of the workspace named in `Aora-Workspace-Id` with a role
 * that holds the route's `@Permit` permission. Default deny: no permission
 * declared means no access.
 * Use after SessionGuard.
 */
@Injectable()
export class WorkspaceGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const session = sessionOf(request);
    const tenantId = request.header('aora-workspace-id') ?? '';
    const allowed = rolesFor(
      this.reflector.getAllAndOverride<Permission | undefined>(PERMISSION_METADATA, [
        context.getHandler(),
        context.getClass(),
      ]),
    );
    const membership = UUID.test(tenantId)
      ? session.memberships.find((entry) => entry.tenantId === tenantId.toLowerCase())
      : undefined;
    // Same answer for "no such workspace" and "not a member", so ids cannot be probed.
    if (!membership || !(allowed as readonly string[]).includes(membership.role)) {
      throw new AppError('forbidden', 'You do not have access to this workspace or action.');
    }
    const aora = contextOf(request);
    aora.tenantId = membership.tenantId;
    aora.role = membership.role;
    aora.branchId = membership.branchId;
    return true;
  }
}

/** Requires the platform-operator flag. Use after SessionGuard. */
@Injectable()
export class OperatorGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const session = sessionOf(context.switchToHttp().getRequest<Request>());
    if (!session.isPlatformOperator) {
      throw new AppError('forbidden', 'Operator access required.');
    }
    return true;
  }
}

/** Requires a step-up completed within the configured window. Use after SessionGuard. */
@Injectable()
export class StepUpGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const session = sessionOf(context.switchToHttp().getRequest<Request>());
    if (!session.stepUpUntil || session.stepUpUntil <= new Date()) {
      throw new AppError('step_up_required', 'Confirm this action with your PIN.');
    }
    return true;
  }
}
