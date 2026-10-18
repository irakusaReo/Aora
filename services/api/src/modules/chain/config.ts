import type { Address } from 'viem';

/**
 * The only chain this codebase knows (CLAUDE.md rule 1, ADR 0004). There is no
 * mainnet entry and no way to select a chain: Base Sepolia is the configuration.
 *
 * This is the ONE place the native USDC address lives (ADR 0005 point 2). A test
 * checks that no other source file contains it. Startup re-checks the chain ID,
 * the contract code and decimals() against the chain before anything uses it.
 */
export const BASE_SEPOLIA = {
  network: 'base-sepolia',
  label: 'Base Sepolia (testnet, sandbox)',
  chainId: 84532,
  explorerUrl: 'https://sepolia.basescan.org',
  usdc: {
    assetCode: 'USDC',
    address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address,
    decimals: 6,
    provenance: {
      source: 'https://developers.circle.com/stablecoins/usdc-contract-addresses',
      verifiedOn: '2026-10-13',
      verifiedBy: 'AORA engineering (ADR 0005); decimals and symbol re-read on chain 2026-10-18',
    },
  },
  /**
   * AORA's own contracts (ADR 0015), copied from contracts/deployments/base-sepolia.json
   * once deployed. Null: not deployed yet, and the features that need them stay off.
   */
  contracts: {
    anchorRegistry: null as Address | null,
    namUsdcVault: null as Address | null,
  },
} as const;

export type { ChainSettings } from '../../platform/chain-settings.js';
