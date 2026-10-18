import { erc20Abi, type PublicClient } from 'viem';
import { BASE_SEPOLIA } from './config.js';

export type ChainVerificationCode =
  | 'rpc_unreachable'
  | 'wrong_chain'
  | 'no_token_code'
  | 'wrong_decimals'
  | 'ledger_exponent_mismatch';

/** The chain is not the one configured: nothing may read, credit or send. */
export class ChainVerificationError extends Error {
  constructor(
    readonly code: ChainVerificationCode,
    message: string,
  ) {
    super(message);
    this.name = 'ChainVerificationError';
  }
}

/**
 * ADR 0004 and ADR 0005 point 4: the RPC answers with Base Sepolia's chain ID,
 * contract code exists at the configured native USDC address, its decimals()
 * equals the configured value, and the ledger's USDC exponent equals both.
 * Any difference stops every chain feature.
 */
export async function verifyChain(
  client: PublicClient,
  ledgerExponent: number,
): Promise<{ chainId: number; headBlock: bigint }> {
  const { usdc } = BASE_SEPOLIA;
  let chainId: number;
  let headBlock: bigint;
  try {
    [chainId, headBlock] = await Promise.all([client.getChainId(), client.getBlockNumber()]);
  } catch {
    throw new ChainVerificationError('rpc_unreachable', 'The Base Sepolia RPC did not answer.');
  }
  if (chainId !== BASE_SEPOLIA.chainId) {
    throw new ChainVerificationError(
      'wrong_chain',
      `The RPC is on chain ${String(chainId)}, not Base Sepolia (${String(BASE_SEPOLIA.chainId)}).`,
    );
  }
  const code = await client.getCode({ address: usdc.address });
  if (!code || code === '0x') {
    throw new ChainVerificationError('no_token_code', 'No contract code at the USDC address.');
  }
  const decimals = await client.readContract({
    address: usdc.address,
    abi: erc20Abi,
    functionName: 'decimals',
  });
  if (decimals !== usdc.decimals) {
    throw new ChainVerificationError(
      'wrong_decimals',
      `The USDC contract reports ${String(decimals)} decimals; the config says ${String(usdc.decimals)}.`,
    );
  }
  if (ledgerExponent !== usdc.decimals) {
    throw new ChainVerificationError(
      'ledger_exponent_mismatch',
      `The ledger's USDC exponent is ${String(ledgerExponent)}; the config says ${String(usdc.decimals)}.`,
    );
  }
  return { chainId, headBlock };
}
