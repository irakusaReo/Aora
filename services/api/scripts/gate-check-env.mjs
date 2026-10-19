// Runs the MVP gate check (dist/gate-check.js) against a target.
//   pnpm gate:check                  local: .env.local's database, API on PUBLIC_API_URL
//   pnpm gate:check staging --cron   AORA staging (Vercel "Production"), through the
//                                    branch's pooled platform connection
// Prints pass or fail per line only; no connection string or secret.
import { spawnSync } from 'node:child_process';

const target = String(process.argv[2] ?? 'local');
const env = { ...process.env };
if (target === 'local') {
  env.GATE_API_URL = process.env.PUBLIC_API_URL ?? 'http://127.0.0.1:3000';
} else {
  const prefix = target.toUpperCase();
  const platform = process.env[`${prefix}_DATABASE_URL_PLATFORM`];
  if (!platform) {
    console.error(`FAIL: ${prefix}_DATABASE_URL_PLATFORM is not set.`);
    process.exit(1);
  }
  env.DATABASE_URL_PLATFORM = platform;
  env.GATE_API_URL = target === 'staging' ? 'https://aora-api.vercel.app' : '';
  env.GATE_CRON_SECRET = process.env[`${prefix}_CRON_SECRET`] ?? '';
}
const extra = process.argv.slice(3);
const result = spawnSync('node', ['dist/gate-check.js', ...extra], { stdio: 'inherit', env });
process.exit(result.status ?? 1);
