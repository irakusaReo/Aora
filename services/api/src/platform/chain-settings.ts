// Base Sepolia settings read from the environment (phase 5). The chain itself,
// and the native USDC address, live only in src/modules/chain/config.ts.

/** A 0x-prefixed hexadecimal string. */
export type Hex = `0x${string}`;

/** Chain settings for this environment. Null in AppConfig: the chain is off. */
export interface ChainSettings {
  readonly rpcUrl: string;
  /** The sandbox development signer's testnet key (ADR 0009 interim). Never logged. */
  readonly signerPrivateKey: Hex | null;
  /** The most blocks one scan reads (P5-11). */
  readonly scanBlockRange: number;
  readonly requestTimeoutMs: number;
  /** How long a status_unknown operation may stay unresolved before a person must look. */
  readonly unknownAfterSeconds: number;
  /**
   * Overrides the AnchorRegistry address recorded in the chain config. Tests
   * only (a registry deployed to the local chain); never read from the environment.
   */
  readonly anchorRegistry?: Hex | null;
}

const KEY = /^0x[0-9a-fA-F]{64}$/;

function invalid(name: string, why: string): never {
  // Names only: a value may be a secret and must never reach a log or an error.
  throw new Error(`Invalid or missing configuration: ${name} (${why})`);
}

/**
 * Reads BASE_SEPOLIA_RPC_URL and SANDBOX_SIGNER_PRIVATE_KEY. The RPC must be
 * https; a plain-http loopback address is a local test chain and is refused on
 * any deployed environment.
 */
export function chainSettings(
  env: Record<string, string | undefined>,
  options: { deployed: boolean },
): ChainSettings | null {
  const rpc = env['BASE_SEPOLIA_RPC_URL']?.trim() ?? '';
  const key = env['SANDBOX_SIGNER_PRIVATE_KEY']?.trim() ?? '';
  if (!rpc) {
    if (key) invalid('BASE_SEPOLIA_RPC_URL', 'a signer key needs an RPC URL');
    return null;
  }
  let url: URL;
  try {
    url = new URL(rpc);
  } catch {
    invalid('BASE_SEPOLIA_RPC_URL', 'not a URL');
  }
  const loopback =
    !options.deployed &&
    url.protocol === 'http:' &&
    (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  if (url.protocol !== 'https:' && !loopback) {
    invalid('BASE_SEPOLIA_RPC_URL', 'must be https');
  }
  if (key && !KEY.test(key)) {
    invalid('SANDBOX_SIGNER_PRIVATE_KEY', 'expected 0x followed by 64 hexadecimal digits');
  }
  return {
    rpcUrl: rpc,
    signerPrivateKey: key ? (key as Hex) : null,
    scanBlockRange: 500,
    requestTimeoutMs: 10_000,
    unknownAfterSeconds: 15 * 60,
  };
}
