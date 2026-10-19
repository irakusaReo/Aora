import type { Call } from '@aora/mobile/testing';

export const WS = '11111111-1111-4111-8111-111111111111';

export const assets = {
  data: [
    { code: 'KES', exponent: 2 },
    { code: 'USDC', exponent: 6 },
  ],
};

export function me(role: 'admin' | 'finance' | 'cashier', phoneSet = true): unknown {
  return {
    account_id: 'acc_1',
    is_platform_operator: false,
    memberships: [{ workspace_id: WS, role }],
    phone_set: phoneSet,
  };
}

export const workspace = {
  id: WS,
  name: 'Mama Njeri Groceries',
  kind: 'unregistered',
  country: 'KE',
  tier: 'tier_1',
  restrictions: [],
  limits: [],
};

/** Answers the reads every screen makes; `rest` handles the rest. */
export function routes(
  role: 'admin' | 'finance' | 'cashier',
  rest: (call: Call) => unknown = () => {
    throw new Error('unexpected call');
  },
): (call: Call) => unknown {
  return (call) => {
    if (call.method === 'GET' && call.path === '/v1/assets') return assets;
    if (call.method === 'GET' && call.path === '/v1/me') return me(role);
    if (call.method === 'GET' && call.path === '/v1/workspace') return workspace;
    return rest(call);
  };
}
