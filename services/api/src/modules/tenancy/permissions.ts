import { SetMetadata } from '@nestjs/common';
import type { Role } from '../../platform/http.js';

/**
 * What each role may do in a workspace. Routes name a permission, never a
 * role, so this table is the single place the answer lives. A route with no
 * permission admits nobody.
 */
export const PERMISSIONS = {
  'payment_intent.create': ['admin', 'finance', 'cashier'],
  'payment_intent.read': ['admin', 'finance', 'cashier'],
  'tariff.read': ['admin', 'finance', 'cashier'],
  'ledger.read': ['admin', 'finance'],
  'branch.read': ['admin', 'finance', 'cashier'],
  'branch.manage': ['admin'],
  'workspace.read': ['admin', 'finance', 'cashier'],
  'settlement.read': ['admin', 'finance'],
  'payout_recipient.read': ['admin', 'finance'],
  'payout_recipient.manage': ['admin', 'finance'],
  'payout.read': ['admin', 'finance'],
  'payout.create': ['admin', 'finance'],
  'refund.read': ['admin', 'finance'],
  'refund.create': ['admin', 'finance'],
  'member.read': ['admin', 'finance'],
  'member.manage': ['admin'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export const PERMISSION_METADATA = 'aora:permission';

/** The permission a workspace route requires. Use with WorkspaceGuard. */
export const Permit = (permission: Permission): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSION_METADATA, permission);

export function rolesFor(permission: Permission | undefined): readonly Role[] {
  return permission ? PERMISSIONS[permission] : [];
}
