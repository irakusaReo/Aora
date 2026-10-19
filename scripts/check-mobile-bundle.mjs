// Checks an exported Expo app (phase-9 P9-14): the Android JavaScript bundle
// stays under its budget, and nothing in it looks like a secret.
// Usage: node scripts/check-mobile-bundle.mjs <app-dir> [budget-bytes]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const [appDir, budgetArg] = process.argv.slice(2);
if (!appDir) {
  console.error('Usage: node scripts/check-mobile-bundle.mjs <app-dir> [budget-bytes]');
  process.exit(2);
}
// Hermes bytecode of the first app measured 4.3 MB (2026-10-19).
const budget = Number(budgetArg ?? 6_000_000);
const dir = join(appDir, 'dist/_expo/static/js/android');
const bundles = readdirSync(dir).filter((name) => /\.(hbc|js)$/.test(name));
if (bundles.length === 0) {
  console.error(`No Android bundle in ${dir}`);
  process.exit(1);
}

const SECRET = [
  /sk_(test|live)_[A-Za-z0-9]{20,}/,
  /pk_live_[A-Za-z0-9]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /postgres(ql)?:\/\/[^:@/\s]+:[^@/\s]+@/,
  /\b0x[0-9a-fA-F]{64}\b/,
];

let failed = false;
for (const name of bundles) {
  const path = join(dir, name);
  const size = statSync(path).size;
  const text = readFileSync(path).toString('latin1');
  const hits = SECRET.filter((pattern) => pattern.test(text)).map(String);
  console.log(`${appDir}: ${name} ${String(size)} bytes (budget ${String(budget)})`);
  if (size > budget) {
    console.error(`  over budget by ${String(size - budget)} bytes`);
    failed = true;
  }
  if (hits.length > 0) {
    // Which pattern matched, never the match itself.
    console.error(`  secret-shaped text found: ${hits.join(', ')}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
