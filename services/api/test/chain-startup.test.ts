import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exactInteger } from '../src/modules/chain/amounts.js';
import { BASE_SEPOLIA } from '../src/modules/chain/config.js';
import { chainSettings } from '../src/platform/chain-settings.js';
import { DevelopmentSigner } from '../src/modules/chain/signer.js';
import { ChainVerificationError, verifyChain } from '../src/modules/chain/startup.js';
import { loadConfig } from '../src/platform/config.js';
import { TEST_KEYS, type Anvil, startAnvil, startBaseSepoliaStandIn } from './support/anvil.js';

const BASE_ENV = {
  AORA_MODE: 'sandbox',
  DATABASE_URL_APP: 'postgresql://aora_app@127.0.0.1:54329/aora_dev',
  DATABASE_URL_PLATFORM: 'postgresql://aora_platform@127.0.0.1:54329/aora_dev',
  SANDBOX_SIM_WEBHOOK_SECRET: 'x'.repeat(32),
  PIN_PEPPER: 'p'.repeat(64),
  AUTH_PROVIDER: 'sandbox',
};

describe('chain configuration', () => {
  it('leaves the chain off when no RPC URL is configured', () => {
    expect(loadConfig(BASE_ENV).chain).toBeNull();
  });

  it('accepts an https RPC URL and a well-formed testnet signer key', () => {
    const config = loadConfig({
      ...BASE_ENV,
      BASE_SEPOLIA_RPC_URL: 'https://sepolia.base.org',
      SANDBOX_SIGNER_PRIVATE_KEY: TEST_KEYS[0],
    });
    expect(config.chain?.rpcUrl).toBe('https://sepolia.base.org');
    expect(config.chain?.signerPrivateKey).toBe(TEST_KEYS[0]);
  });

  it('refuses a plain-http RPC URL unless it is a loopback stand-in on a developer machine', () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, BASE_SEPOLIA_RPC_URL: 'http://rpc.example.com' }),
    ).toThrow(/BASE_SEPOLIA_RPC_URL/);
    expect(
      loadConfig({ ...BASE_ENV, BASE_SEPOLIA_RPC_URL: 'http://127.0.0.1:8545' }).chain?.rpcUrl,
    ).toBe('http://127.0.0.1:8545');
    expect(() =>
      chainSettings({ BASE_SEPOLIA_RPC_URL: 'http://127.0.0.1:8545' }, { deployed: true }),
    ).toThrow(/BASE_SEPOLIA_RPC_URL/);
  });

  it('refuses a malformed signer key without repeating it', () => {
    const bad = `0x${'zz'.repeat(32)}`;
    let message = '';
    try {
      loadConfig({
        ...BASE_ENV,
        BASE_SEPOLIA_RPC_URL: 'https://sepolia.base.org',
        SANDBOX_SIGNER_PRIVATE_KEY: bad,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/SANDBOX_SIGNER_PRIVATE_KEY/);
    expect(message).not.toContain(bad);
  });

  it('refuses a signer key without an RPC URL', () => {
    expect(() => loadConfig({ ...BASE_ENV, SANDBOX_SIGNER_PRIVATE_KEY: TEST_KEYS[0] })).toThrow(
      /BASE_SEPOLIA_RPC_URL/,
    );
  });

  it('holds Base Sepolia only, with the USDC address and its provenance in one place', () => {
    expect(BASE_SEPOLIA.chainId).toBe(84532);
    expect(BASE_SEPOLIA.usdc.address).toBe('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
    expect(BASE_SEPOLIA.usdc.provenance.source).toMatch(/^https:\/\/developers\.circle\.com\//);
    expect(BASE_SEPOLIA.usdc.provenance.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('has no mainnet chain ID or mainnet USDC address anywhere in the API source', () => {
    const root = fileURLToPath(new URL('../src', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (name === 'generated') continue;
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith('.ts')) files.push(path);
      }
    };
    walk(root);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/\b8453\b/);
      expect(text.toLowerCase(), file).not.toContain('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
    }
  });

  it('keeps the USDC address out of every other source file (ADR 0005 point 2)', () => {
    const root = fileURLToPath(new URL('../src', import.meta.url));
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (name === 'generated') continue;
        if (statSync(path).isDirectory()) walk(path);
        else if (
          path.endsWith('.ts') &&
          readFileSync(path, 'utf8').toLowerCase().includes(BASE_SEPOLIA.usdc.address.toLowerCase())
        ) {
          hits.push(path.slice(root.length));
        }
      }
    };
    walk(root);
    expect(hits).toEqual(['/modules/chain/config.ts']);
  });
});

describe('exact amounts from the database', () => {
  it('converts numeric values to bigint exactly, including exponent notation', () => {
    expect(exactInteger({ toString: () => '5000000' })).toBe(5_000_000n);
    expect(
      exactInteger({
        toString: () =>
          '1.15792089237316195423570985008687907853269984665640564039457584007913129639935e+77',
      }),
    ).toBe(2n ** 256n - 1n);
    expect(exactInteger({ toString: () => '1.5e+1' })).toBe(15n);
    expect(() => exactInteger({ toString: () => '1.25e+1' })).toThrow();
    expect(() => exactInteger({ toString: () => '-1' })).toThrow();
    expect(() => exactInteger({ toString: () => '0.5' })).toThrow();
  });
});

describe('startup verification against the chain', () => {
  let standIn: Anvil;
  beforeAll(async () => {
    standIn = await startBaseSepoliaStandIn();
  });
  afterAll(async () => {
    await standIn.stop();
  });

  it('passes on Base Sepolia with native USDC at the configured address and 6 decimals', async () => {
    const result = await verifyChain(standIn.client, 6);
    expect(result.chainId).toBe(84532);
    expect(result.headBlock).toBeGreaterThanOrEqual(0n);
  });

  it('refuses when the ledger exponent differs from the configured decimals', async () => {
    await expect(verifyChain(standIn.client, 2)).rejects.toMatchObject({
      code: 'ledger_exponent_mismatch',
    });
  });

  it('refuses a chain whose ID is not Base Sepolia', async () => {
    const other = await startAnvil({ chainId: 31337 });
    try {
      await other.setToken(BASE_SEPOLIA.usdc.address, 'TestUsdc');
      const failure = await verifyChain(other.client, 6).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ChainVerificationError);
      expect(failure).toMatchObject({ code: 'wrong_chain' });
    } finally {
      await other.stop();
    }
  });

  it('refuses when there is no contract code at the USDC address', async () => {
    const empty = await startAnvil();
    try {
      await expect(verifyChain(empty.client, 6)).rejects.toMatchObject({ code: 'no_token_code' });
    } finally {
      await empty.stop();
    }
  });

  it('refuses when the token at the USDC address reports other decimals', async () => {
    const wrong = await startAnvil();
    try {
      await wrong.setToken(BASE_SEPOLIA.usdc.address, 'TestOtherToken');
      await expect(verifyChain(wrong.client, 6)).rejects.toMatchObject({ code: 'wrong_decimals' });
    } finally {
      await wrong.stop();
    }
  });
});

describe('sandbox development signer (ADR 0009 interim ruling)', () => {
  it('starts only in sandbox mode on a verified Base Sepolia chain', () => {
    const signer = DevelopmentSigner.create(TEST_KEYS[0], {
      mode: 'sandbox',
      verifiedChainId: 84532,
    });
    expect(signer.address).toBe(privateKeyToAccount(TEST_KEYS[0]).address);
  });

  it('refuses any chain other than Base Sepolia', () => {
    expect(() =>
      DevelopmentSigner.create(TEST_KEYS[0], { mode: 'sandbox', verifiedChainId: 31337 }),
    ).toThrow(/Base Sepolia/);
  });

  it('refuses any mode other than sandbox', () => {
    expect(() =>
      DevelopmentSigner.create(TEST_KEYS[0], {
        mode: 'live' as 'sandbox',
        verifiedChainId: 84532,
      }),
    ).toThrow(/sandbox/);
  });

  it('never exposes the key through its properties or serialisation', () => {
    const signer = DevelopmentSigner.create(TEST_KEYS[0], {
      mode: 'sandbox',
      verifiedChainId: 84532,
    });
    const shown = `${JSON.stringify(signer)} ${String(signer)} ${Object.keys(signer).join(',')}`;
    expect(shown).not.toContain(TEST_KEYS[0].slice(2));
  });
});
