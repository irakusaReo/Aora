import type { Address, Hex, TransactionSerializableEIP1559 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { BASE_SEPOLIA } from './config.js';

/**
 * Everything that signs for AORA sits behind this interface (ADR 0004, ADR 0009).
 * Domain code never sees key material, and a signature is never completion.
 */
export interface Signer {
  readonly address: Address;
  signTransaction(transaction: TransactionSerializableEIP1559): Promise<Hex>;
  signMessage(message: string): Promise<Hex>;
}

/**
 * SANDBOX DEVELOPMENT SIGNER (ADR 0009 interim ruling, owner decision 2026-10-18).
 * Holds one testnet key from the environment. It refuses to exist outside
 * sandbox mode or on any chain other than Base Sepolia, and the chain ID it is
 * given must be the one the RPC reported at startup, not the configured one.
 * The key lives in a closure, so no property, log or serialisation reveals it.
 */
export class DevelopmentSigner implements Signer {
  readonly address: Address;
  readonly signTransaction: (transaction: TransactionSerializableEIP1559) => Promise<Hex>;
  readonly signMessage: (message: string) => Promise<Hex>;

  private constructor(key: Hex) {
    const account = privateKeyToAccount(key);
    this.address = account.address;
    this.signTransaction = (transaction) => {
      if (transaction.chainId !== BASE_SEPOLIA.chainId) {
        return Promise.reject(new Error('The sandbox signer signs for Base Sepolia only.'));
      }
      return account.signTransaction(transaction);
    };
    this.signMessage = (message) => account.signMessage({ message });
  }

  static create(
    key: Hex,
    context: { readonly mode: 'sandbox'; readonly verifiedChainId: number },
  ): DevelopmentSigner {
    if ((context.mode as string) !== 'sandbox') {
      throw new Error('The development signer runs in sandbox mode only.');
    }
    if (context.verifiedChainId !== BASE_SEPOLIA.chainId) {
      throw new Error('The development signer runs on Base Sepolia (84532) only.');
    }
    return new DevelopmentSigner(key);
  }

  toJSON(): { address: Address; kind: 'sandbox_development_signer' } {
    return { address: this.address, kind: 'sandbox_development_signer' };
  }

  toString(): string {
    return `DevelopmentSigner(${this.address})`;
  }
}
