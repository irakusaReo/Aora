import type { Call } from '@aora/mobile/testing';

export const assets = {
  data: [
    { code: 'KES', exponent: 2 },
    { code: 'USDC', exponent: 6 },
  ],
};

export const usdc = {
  network: { name: 'base-sepolia', label: 'Base Sepolia', chain_id: 84532 },
  deposit_address: null,
  wallet_label: 'AORA sandbox testnet wallet',
  asset: { code: 'USDC', decimals: 6, contract: '0x036c' },
  balances: { available_minor: '12500000', withdrawals_in_flight_minor: '0' },
  addresses: [],
  explorer_url: 'https://sepolia.basescan.org',
  note: '',
};

export function routes(rest: (call: Call) => unknown): (call: Call) => unknown {
  return (call) => {
    if (call.method === 'GET' && call.path === '/v1/assets') return assets;
    if (call.method === 'GET' && call.path === '/v1/chiwo/usdc') return usdc;
    return rest(call);
  };
}
