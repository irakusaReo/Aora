import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppError } from '../../platform/errors.js';
import { contextOf, type Role, sessionOf } from '../../platform/http.js';
import { IdentityService } from './identity.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES = 'aora:roles';

/** Roles allowed to call a workspace endpoint. With no roles listed, nobody may. */
export const AllowRoles = (...roles: Role[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES, roles);

/** Requires a valid session token. */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(IdentityService) private readonly identity: IdentityService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const session = token ? await this.identity.authenticate(token) : null;
    if (!session) throw new AppError('unauthenticated', 'Sign in required.');
    contextOf(request).session = session;
    return true;
  }
}

/**
 * Requires membership of the workspace named in `Aora-Workspace-Id` with one of
 * the roles in `@AllowRoles`. Default deny: no decorator means no access.
 * Use after SessionGuard.
 */
@Injectable()
export class WorkspaceGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const session = sessionOf(request);
    const tenantId = request.header('aora-workspace-id') ?? '';
    const allowed =
      this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    const membership = UUID.test(tenantId)
      ? session.memberships.find((entry) => entry.tenantId === tenantId.toLowerCase())
      : undefined;
    // Same answer for "no such workspace" and "not a member", so ids cannot be probed.
    if (!membership || !allowed.includes(membership.role)) {
      throw new AppError('forbidden', 'You do not have access to this workspace or action.');
    }
    const aora = contextOf(request);
    aora.tenantId = membership.tenantId;
    aora.role = membership.role;
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
      throw new AppError('step_up_required', 'Confirm this action with your second factor.');
    }
    return true;
  }
}
