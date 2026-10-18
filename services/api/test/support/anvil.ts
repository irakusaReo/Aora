import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type Address,
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
  http,
  keccak256,
  parseAbi,
  type PublicClient,
  type TestClient,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { BASE_SEPOLIA } from '../../src/modules/chain/config.js';

// The local chain impersonates Base Sepolia (phase-5 plan P5-2): anvil runs with
// chain ID 84532 and the TEST-ONLY 6-decimal token's code sits at the configured
// native USDC address, so the production config entry is exercised unchanged.

const tokens = JSON.parse(readFileSync(new URL('./test-tokens.json', import.meta.url), 'utf8')) as {
  TestUsdc: Hex;
  TestOtherToken: Hex;
  AnchorRegistryCreation: Hex;
};

/** Compiled code from the exported test artifact (see contracts/scripts/export-test-tokens.mjs). */
export function testContractCode(name: 'AnchorRegistryCreation'): Hex {
  return tokens[name];
}

// Throwaway keys generated for this test run, funded with local ETH when anvil
// starts. Nothing is hard-coded, and they exist only on the local process.
export const TEST_KEYS = [
  generatePrivateKey(),
  generatePrivateKey(),
  generatePrivateKey(),
  generatePrivateKey(),
] as const;

export const TOKEN_ABI = parseAbi([
  'function mint(address to, uint256 amount)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

/** Where the test suite puts "some other token" (stands in for USDbC, USDT and the like). */
export const OTHER_TOKEN: Address = '0x00000000000000000000000000000000000a0a0a';

function anvilBinary(): string {
  const local = join(homedir(), '.foundry', 'bin', 'anvil');
  return existsSync(local) ? local : 'anvil';
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });
  });
}

export interface Anvil {
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly client: PublicClient;
  readonly test: TestClient;
  /** Places the TEST-ONLY token code at an address (no constructor state). */
  setToken(address: Address, kind: 'TestUsdc' | 'TestOtherToken'): Promise<void>;
  setCode(address: Address, code: Hex): Promise<void>;
  mint(token: Address, to: Address, amount: bigint): Promise<Hex>;
  /** Sends a token transfer from one of anvil's keys and mines it. */
  transfer(token: Address, fromKey: Hex, to: Address, amount: bigint): Promise<Hex>;
  /** Overwrites a token balance in storage (mapping at slot 0). */
  setTokenBalance(token: Address, holder: Address, amount: bigint): Promise<void>;
  fundEth(address: Address, wei: bigint): Promise<void>;
  mine(blocks: number): Promise<void>;
  snapshot(): Promise<Hex>;
  revert(id: Hex): Promise<void>;
  stop(): Promise<void>;
}

export async function startAnvil(options: { chainId?: number } = {}): Promise<Anvil> {
  const chainId = options.chainId ?? BASE_SEPOLIA.chainId;
  const port = await freePort();
  const child: ChildProcess = spawn(
    anvilBinary(),
    ['--port', String(port), '--chain-id', String(chainId), '--silent', '--no-mining'],
    { stdio: 'ignore' },
  );
  const rpcUrl = `http://127.0.0.1:${String(port)}`;
  const client = createPublicClient({ cacheTime: 0, transport: http(rpcUrl) });
  const test = createTestClient({ mode: 'anvil', transport: http(rpcUrl) });

  for (let attempt = 0; ; attempt += 1) {
    try {
      await client.getChainId();
      break;
    } catch (error) {
      if (attempt > 100) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  for (const key of TEST_KEYS) {
    await test.setBalance({ address: privateKeyToAccount(key).address, value: 10n ** 21n });
  }

  const mineOne = (): Promise<void> => test.mine({ blocks: 1 });

  const sendFrom = async (key: Hex, to: Address, data: Hex): Promise<Hex> => {
    const account = privateKeyToAccount(key);
    const wallet = createWalletClient({ account, transport: http(rpcUrl) });
    const hash = await wallet.sendTransaction({
      to,
      data,
      chain: null,
      gas: 200_000n,
    });
    await mineOne();
    return hash;
  };

  const anvil: Anvil = {
    rpcUrl,
    chainId,
    client,
    test,
    async setToken(address, kind) {
      await test.setCode({ address, bytecode: tokens[kind] });
    },
    async setCode(address, code) {
      await test.setCode({ address, bytecode: code });
    },
    mint(token, to, amount) {
      return sendFrom(
        TEST_KEYS[3],
        token,
        encodeFunctionData({ abi: TOKEN_ABI, functionName: 'mint', args: [to, amount] }),
      );
    },
    transfer(token, fromKey, to, amount) {
      return sendFrom(
        fromKey,
        token,
        encodeFunctionData({ abi: TOKEN_ABI, functionName: 'transfer', args: [to, amount] }),
      );
    },
    async setTokenBalance(token, holder, amount) {
      const slot = keccak256(
        encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [holder, 0n]),
      );
      await test.setStorageAt({
        address: token,
        index: slot,
        value: encodeAbiParameters([{ type: 'uint256' }], [amount]),
      });
    },
    async fundEth(address, wei) {
      await test.setBalance({ address, value: wei });
    },
    async mine(blocks) {
      await test.mine({ blocks });
    },
    snapshot: () => test.snapshot(),
    async revert(id) {
      await test.revert({ id });
    },
    stop() {
      return new Promise((resolve) => {
        child.once('exit', () => {
          resolve();
        });
        child.kill('SIGTERM');
      });
    },
  };
  return anvil;
}

/** Anvil with the TEST-ONLY 6-decimal token at the configured native USDC address. */
export async function startBaseSepoliaStandIn(): Promise<Anvil> {
  const anvil = await startAnvil();
  await anvil.setToken(BASE_SEPOLIA.usdc.address, 'TestUsdc');
  await anvil.setToken(OTHER_TOKEN, 'TestOtherToken');
  return anvil;
}
