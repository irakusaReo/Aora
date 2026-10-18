// Generates the AORA sandbox testnet signer (owner approval 3, 2026-10-18).
// Writes the private key into the repository's .env.local only, refuses to
// replace a key that is already set, and prints the public address and nothing
// else. The wallet is for Base Sepolia (84532) only: never fund it on mainnet.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const envPath = resolve(import.meta.dirname, '../../../.env.local');
const name = 'SANDBOX_SIGNER_PRIVATE_KEY';
const text = readFileSync(envPath, 'utf8');
const line = new RegExp(`^${name}=(.*)$`, 'm');
const current = text.match(line);

if (current && current[1].replace(/^"|"$/g, '').trim() !== '') {
  console.error(`${name} is already set in .env.local; not replacing it.`);
  process.exit(1);
}

const key = generatePrivateKey();
const entry = `${name}="${key}"`;
writeFileSync(
  envPath,
  current ? text.replace(line, entry) : `${text.replace(/\n?$/, '\n')}${entry}\n`,
  {
    mode: 0o600,
  },
);
console.log(privateKeyToAccount(key).address);
