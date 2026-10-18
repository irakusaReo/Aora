import {
  type Address,
  erc20Abi,
  getAddress,
  type Hex,
  parseEventLogs,
  type PublicClient,
  TransactionReceiptNotFoundError,
} from 'viem';
import { BASE_SEPOLIA } from './config.js';

export type VerificationOutcome =
  'verified' | 'insufficient_confirmations' | 'reverted' | 'not_found' | 'no_matching_transfer';

export interface TransferVerification {
  readonly outcome: VerificationOutcome;
  readonly confirmations: number;
  readonly blockNumber: bigint | null;
  readonly blockHash: Hex | null;
  /** Who sent the matching transfer, when one matched. */
  readonly from: Address | null;
  readonly logIndex: number | null;
}

/**
 * Verification by content, never by hash (ADR 0004): a transfer counts only if
 * the receipt succeeded, a Transfer event emitted by the configured native USDC
 * contract carries the expected recipient and exact amount, and the block has
 * the required confirmations. Events from any other contract never match.
 */
export async function verifyUsdcTransfer(
  client: PublicClient,
  txHash: Hex,
  expected: { readonly to: Address; readonly amount: bigint; readonly minConfirmations: number },
): Promise<TransferVerification> {
  const none = { blockNumber: null, blockHash: null, from: null, logIndex: null };
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash });
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError) {
      return { outcome: 'not_found', confirmations: 0, ...none };
    }
    throw error;
  }
  const head = await client.getBlockNumber();
  const confirmations = Number(head - receipt.blockNumber + 1n);
  const at = { blockNumber: receipt.blockNumber, blockHash: receipt.blockHash };
  if (receipt.status !== 'success') {
    return { outcome: 'reverted', confirmations, ...at, from: null, logIndex: null };
  }
  const usdc = getAddress(BASE_SEPOLIA.usdc.address);
  const recipient = getAddress(expected.to);
  const match = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs }).find(
    (log) =>
      getAddress(log.address) === usdc &&
      getAddress(log.args.to) === recipient &&
      log.args.value === expected.amount,
  );
  if (!match) {
    return { outcome: 'no_matching_transfer', confirmations, ...at, from: null, logIndex: null };
  }
  return {
    outcome: confirmations >= expected.minConfirmations ? 'verified' : 'insufficient_confirmations',
    confirmations,
    ...at,
    from: getAddress(match.args.from),
    logIndex: match.logIndex,
  };
}
