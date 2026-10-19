import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTROLLERS } from '../src/app.module.js';
import { PERMISSIONS } from '../src/modules/tenancy/permissions.js';
import { type Harness, startHarness } from './support/harness.js';

// The route × role matrix, written out by hand so that a change to the
// permission map or to a route's decorator has to be made here too.
const EXPECTED: Record<
  string,
  { admin: boolean; finance: boolean; cashier: boolean; stepUp?: true }
> = {
  'POST /v1/payment-intents': { admin: true, finance: true, cashier: true },
  'GET /v1/workspace/kelo/listings/:id/plan-options': { admin: true, finance: true, cashier: true },
  'POST /v1/workspace/kelo/listings/:id/plan-offers': {
    admin: true,
    finance: false,
    cashier: false,
  },
  'GET /v1/workspace/kelo/purchases': { admin: true, finance: true, cashier: true },
  'POST /v1/workspace/kelo/purchases/:id/confirm': { admin: true, finance: false, cashier: false },
  'POST /v1/workspace/kelo/purchases/:id/fulfil': { admin: true, finance: false, cashier: false },
  'GET /v1/workspace/kelo/quote-requests': { admin: true, finance: true, cashier: true },
  'POST /v1/workspace/kelo/quote-requests/:id/quotes': {
    admin: true,
    finance: false,
    cashier: false,
  },
  'GET /v1/workspace/kelo/store': { admin: true, finance: true, cashier: true },
  'POST /v1/workspace/kelo/listings': { admin: true, finance: false, cashier: false },
  'GET /v1/workspace/kelo/listings': { admin: true, finance: true, cashier: true },
  'GET /v1/workspace/kelo/listings/:id': { admin: true, finance: true, cashier: true },
  'PATCH /v1/workspace/kelo/listings/:id': { admin: true, finance: false, cashier: false },
  'POST /v1/workspace/kelo/listings/:id/variants': { admin: true, finance: false, cashier: false },
  'PATCH /v1/workspace/kelo/listings/:id/variants/:variantId': {
    admin: true,
    finance: false,
    cashier: false,
  },
  'POST /v1/workspace/kelo/listings/:id/sessions': { admin: true, finance: false, cashier: false },
  'POST /v1/workspace/kelo/listings/:id/submit': { admin: true, finance: false, cashier: false },
  'POST /v1/workspace/kelo/listings/:id/images/upload-token': {
    admin: true,
    finance: false,
    cashier: false,
  },
  'POST /v1/workspace/kelo/listings/:id/images': { admin: true, finance: false, cashier: false },
  'GET /v1/payment-intents': { admin: true, finance: true, cashier: true },
  'GET /v1/payment-intents/:id': { admin: true, finance: true, cashier: true },
  'GET /v1/tariffs/quote': { admin: true, finance: true, cashier: true },
  'GET /v1/workspace/branches': { admin: true, finance: true, cashier: true },
  'POST /v1/workspace/branches': { admin: true, finance: false, cashier: false },
  'PATCH /v1/workspace/branches/:id': { admin: true, finance: false, cashier: false },
  'GET /v1/ledger/balances': { admin: true, finance: true, cashier: false },
  'GET /v1/workspace/members': { admin: true, finance: true, cashier: false },
  'GET /v1/workspace': { admin: true, finance: true, cashier: true },
  'GET /v1/api-keys': { admin: true, finance: false, cashier: false },
  'POST /v1/api-keys': { admin: true, finance: false, cashier: false, stepUp: true },
  'DELETE /v1/api-keys/:id': { admin: true, finance: false, cashier: false, stepUp: true },
  'GET /v1/webhook-endpoints': { admin: true, finance: true, cashier: false },
  'POST /v1/webhook-endpoints': { admin: true, finance: false, cashier: false, stepUp: true },
  'GET /v1/webhook-deliveries': { admin: true, finance: true, cashier: false },
  'POST /v1/webhook-deliveries/:id/replay': {
    admin: true,
    finance: false,
    cashier: false,
    stepUp: true,
  },
  'GET /v1/settlements': { admin: true, finance: true, cashier: false },
  'GET /v1/payout-recipients': { admin: true, finance: true, cashier: false },
  'POST /v1/payout-recipients': { admin: true, finance: true, cashier: false },
  'POST /v1/payout-recipients/:id/confirmation': {
    admin: true,
    finance: true,
    cashier: false,
    stepUp: true,
  },
  'GET /v1/pay-codes': { admin: true, finance: true, cashier: true },
  'POST /v1/pay-codes': { admin: true, finance: false, cashier: false },
  'POST /v1/pay-codes/:code/deactivate': { admin: true, finance: false, cashier: false },
  'GET /v1/nam': { admin: true, finance: true, cashier: false },
  'POST /v1/nam/orders': { admin: true, finance: true, cashier: false, stepUp: true },
  'GET /v1/nam/orders': { admin: true, finance: true, cashier: false },
  'POST /v1/nam/redemptions': { admin: true, finance: true, cashier: false, stepUp: true },
  'GET /v1/nam/redemptions': { admin: true, finance: true, cashier: false },
  'GET /v1/treasury': { admin: true, finance: true, cashier: false },
  'POST /v1/treasury/address-challenges': { admin: true, finance: false, cashier: false },
  'POST /v1/treasury/addresses': { admin: true, finance: false, cashier: false, stepUp: true },
  'GET /v1/treasury/addresses': { admin: true, finance: true, cashier: false },
  'POST /v1/treasury/addresses/:id/revocation': {
    admin: true,
    finance: false,
    cashier: false,
    stepUp: true,
  },
  'GET /v1/treasury/transfers': { admin: true, finance: true, cashier: false },
  'POST /v1/treasury/withdrawals': { admin: true, finance: true, cashier: false, stepUp: true },
  'GET /v1/treasury/withdrawals': { admin: true, finance: true, cashier: false },
  'POST /v1/treasury/withdrawals/:id/approval': {
    admin: true,
    finance: false,
    cashier: false,
    stepUp: true,
  },
  'POST /v1/treasury/withdrawals/:id/rejection': { admin: true, finance: false, cashier: false },
  'POST /v1/payouts/preview': { admin: true, finance: true, cashier: false },
  'POST /v1/payouts': { admin: true, finance: true, cashier: false, stepUp: true },
  'GET /v1/payouts': { admin: true, finance: true, cashier: false },
  'GET /v1/payouts/:id': { admin: true, finance: true, cashier: false },
  'POST /v1/payment-intents/:id/refunds': {
    admin: true,
    finance: true,
    cashier: false,
    stepUp: true,
  },
  'GET /v1/refunds/:id': { admin: true, finance: true, cashier: false },
  'GET /v1/workspace/invitations': { admin: true, finance: true, cashier: false },
  'POST /v1/workspace/invitations': { admin: true, finance: false, cashier: false, stepUp: true },
  'DELETE /v1/workspace/invitations/:id': {
    admin: true,
    finance: false,
    cashier: false,
    stepUp: true,
  },
  'PATCH /v1/workspace/members/:id': { admin: true, finance: false, cashier: false, stepUp: true },
};

interface Route {
  key: string;
  method: string;
  path: string;
  guards: string[];
  permission: string | undefined;
}

function routes(): Route[] {
  const found: Route[] = [];
  for (const controller of CONTROLLERS) {
    const base = Reflect.getMetadata('path', controller) as string;
    const classGuards = (Reflect.getMetadata('__guards__', controller) ?? []) as { name: string }[];
    const prototype = controller.prototype as unknown as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(prototype)) {
      const handler = prototype[name];
      if (name === 'constructor' || typeof handler !== 'function') continue;
      const method = Reflect.getMetadata('method', handler) as RequestMethod | undefined;
      if (method === undefined) continue;
      const sub = Reflect.getMetadata('path', handler) as string;
      const path = `/${[base, sub].filter((part) => part && part !== '/').join('/')}`;
      const guards = [
        ...classGuards,
        ...((Reflect.getMetadata('__guards__', handler) ?? []) as { name: string }[]),
      ].map((guard) => guard.name);
      found.push({
        key: `${RequestMethod[method]} ${path}`,
        method: RequestMethod[method].toLowerCase(),
        path,
        guards,
        permission:
          (Reflect.getMetadata('aora:permission', handler) as string | undefined) ??
          (Reflect.getMetadata('aora:permission', controller) as string | undefined),
      });
    }
  }
  return found;
}

let h: Harness;
const tokens: Record<string, string> = {};

beforeAll(async () => {
  h = await startHarness();
  for (const who of ['adminA', 'financeA', 'cashierA'] as const) {
    tokens[who] = await h.signIn(who);
    await h.stepUp(tokens[who] ?? '');
  }
});
afterAll(() => h.close());

describe('route × role matrix', () => {
  const workspaceRoutes = routes().filter((route) => route.guards.includes('WorkspaceGuard'));

  it('covers every workspace route, and every workspace route names a permission', () => {
    expect(workspaceRoutes.map((route) => route.key).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const route of workspaceRoutes) {
      expect(route.permission, route.key).toEqual(expect.any(String));
      expect(Object.keys(PERMISSIONS)).toContain(route.permission);
    }
  });

  it('declares step-up exactly where the matrix says', () => {
    for (const route of workspaceRoutes) {
      expect(route.guards.includes('StepUpGuard'), route.key).toBe(
        EXPECTED[route.key]?.stepUp === true,
      );
    }
  });

  it('puts every route behind authentication unless it is on the public list', () => {
    const open = routes()
      .filter(
        (route) =>
          !route.guards.some((g) => ['SessionGuard', 'CronGuard', 'InboxGuard'].includes(g)),
      )
      .map((route) => route.key)
      .sort();
    // Webhook routes are authenticated by signature inside the handler, not by a guard.
    expect(open).toEqual([
      // Reference data (asset codes and exponents): prices are shown before sign-in.
      'GET /v1/assets',
      'GET /v1/health',
      // KELO browsing needs no sign-in: published listings and the taxonomy only.
      'GET /v1/kelo/categories',
      'GET /v1/kelo/marketplace/listings',
      'GET /v1/kelo/marketplace/listings/:id',
      'GET /v1/kelo/marketplace/listings/:id/plans',
      'GET /v1/terms/:key',
      'GET /v1/webhook-signing-key',
      'POST /v1/webhooks/clerk',
      'POST /v1/webhooks/daraja/b2c-status/:payoutId/:token',
      'POST /v1/webhooks/daraja/b2c/:payoutId/:token',
      'POST /v1/webhooks/daraja/stk/:intentId/:token',
      'POST /v1/webhooks/resend',
      'POST /v1/webhooks/sandbox',
    ]);
  });

  it.each(Object.entries(EXPECTED))('%s', async (key, expected) => {
    const route = workspaceRoutes.find((candidate) => candidate.key === key);
    expect(route).toBeDefined();
    if (!route) return;
    const path = route.path.replace(':id', '00000000-0000-4000-8000-000000000000');
    for (const [who, role] of [
      ['adminA', 'admin'],
      ['financeA', 'finance'],
      ['cashierA', 'cashier'],
    ] as const) {
      const response = await (
        h.http() as unknown as Record<string, (p: string) => import('supertest').Test>
      )
        [route.method]?.(path)
        .set('Authorization', `Bearer ${tokens[who] ?? ''}`)
        .set('Aora-Workspace-Id', h.seed.tenantA)
        .set('Idempotency-Key', `${who}-${key}`)
        .send({});
      const denied = response?.status === 403 && response.body.error.code === 'forbidden';
      expect(denied, `${role} on ${key} (status ${String(response?.status)})`).toBe(
        !expected[role],
      );
    }
  });

  it('denies a member of another workspace on every workspace route', async () => {
    const outsider = await h.signIn('adminB');
    for (const route of workspaceRoutes) {
      const path = route.path.replace(':id', '00000000-0000-4000-8000-000000000000');
      const response = await (
        h.http() as unknown as Record<string, (p: string) => import('supertest').Test>
      )
        [route.method]?.(path)
        .set('Authorization', `Bearer ${outsider}`)
        .set('Aora-Workspace-Id', h.seed.tenantA)
        .send({});
      expect(response?.status, route.key).toBe(403);
    }
  });
});
