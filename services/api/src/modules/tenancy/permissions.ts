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
  'api_key.read': ['admin'],
  'api_key.manage': ['admin'],
  'webhook.read': ['admin', 'finance'],
  'webhook.manage': ['admin'],
  'member.read': ['admin', 'finance'],
  'member.manage': ['admin'],
  'kelo_listing.read': ['admin', 'finance', 'cashier'],
  'kelo_listing.manage': ['admin'],
  // USDC treasury on Base Sepolia (phase 5C). Approving a withdrawal is admin
  // only and never by the person who requested it (enforced in the service).
  'treasury.read': ['admin', 'finance'],
  'treasury.manage': ['admin'],
  'treasury.withdraw': ['admin', 'finance'],
  'treasury.approve': ['admin'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export const PERMISSION_METADATA = 'aora:permission';

/** The permission a workspace route requires. Use with WorkspaceGuard. */
export const Permit = (permission: Permission): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSION_METADATA, permission);

export function rolesFor(permission: Permission | undefined): readonly Role[] {
  return permission ? PERMISSIONS[permission] : [];
}
