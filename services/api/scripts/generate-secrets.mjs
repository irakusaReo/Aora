// Generates the AORA-owned sandbox secrets a phase needs and appends them to
// .env.local. Existing values are kept. Prints variable NAMES only, never values.
//
//   pnpm secrets:generate
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('../../../.env.local', import.meta.url));

const GENERATORS = {
  // Authenticates Daraja callbacks: each callback URL carries an HMAC made with it (ADR 0022).
  DARAJA_CALLBACK_SECRET: () => randomBytes(32).toString('hex'),
  // Ed25519 key that signs outbound developer webhooks (ADR 0023): PKCS#8 DER, base64.
  WEBHOOK_SIGNING_PRIVATE_KEY: () =>
    generateKeyPairSync('ed25519')
      .privateKey.export({ type: 'pkcs8', format: 'der' })
      .toString('base64'),
};

const present = new Set(
  (existsSync(path) ? readFileSync(path, 'utf8') : '')
    .split('\n')
    .map((line) => /^\s*([A-Z][A-Z0-9_]*)=(.+)$/.exec(line)?.[1])
    .filter(Boolean),
);

for (const [name, generate] of Object.entries(GENERATORS)) {
  if (present.has(name)) {
    console.log(`${name}: already set, left unchanged`);
    continue;
  }
  appendFileSync(path, `\n${name}=${generate()}\n`, { mode: 0o600 });
  console.log(`${name}: generated and written to .env.local`);
}
