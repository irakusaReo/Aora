import { existsSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { type GateLine, gateChecks } from './gate.js';
import { BASE_SEPOLIA } from './modules/chain/config.js';

// Runs the MVP gate's checks against a target (phase-10 10B) and prints pass or
// fail per line. Usage, through scripts/gate-check-env.mjs:
//   pnpm gate:check                  local database and API
//   pnpm gate:check staging [--cron] AORA staging; --cron also calls the seven cron jobs
// Read-only, except that --cron runs the (idempotent) jobs. Prints no secret.

const CRON_JOBS = [
  'kelo-provisioning-backfill',
  'outbox',
  'sim-webhooks',
  'settlement',
  'reconciliation',
  'chain',
  'kelo-credit',
];

const apiUrl = process.env['GATE_API_URL'] ?? 'http://127.0.0.1:3000';
const platformUrl = process.env['DATABASE_URL_PLATFORM'];
if (!platformUrl) {
  console.error('FAIL: no platform database connection for this target.');
  process.exit(1);
}
const deploymentFile = new URL('../../../contracts/deployments/base-sepolia.json', import.meta.url);

const pool = new pg.Pool({ connectionString: platformUrl, max: 2 });
const get = async (path: string, headers: Record<string, string> = {}) => {
  const response = await fetch(new URL(path, apiUrl), {
    headers,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: the status alone is reported.
  }
  return { status: response.status, body };
};

const lines: GateLine[] = await gateChecks({
  query: async (sql) => (await pool.query(sql)).rows as Record<string, unknown>[],
  get: (path) => get(path),
  deployment: existsSync(deploymentFile)
    ? (JSON.parse(readFileSync(deploymentFile, 'utf8')) as {
        contracts: Record<string, { address: string }>;
      })
    : null,
  configured: {
    namUsdcVault: BASE_SEPOLIA.contracts.namUsdcVault,
    anchorRegistry: BASE_SEPOLIA.contracts.anchorRegistry,
  },
});
await pool.end();

const secret = process.env['GATE_CRON_SECRET'];
if (process.argv.includes('--cron')) {
  for (const job of CRON_JOBS) {
    try {
      const { status } = await get(`/v1/internal/cron/${job}`, {
        authorization: `Bearer ${secret ?? ''}`,
      });
      lines.push({ name: `cron ${job}`, ok: status === 200, detail: `HTTP ${String(status)}` });
    } catch {
      lines.push({ name: `cron ${job}`, ok: false, detail: 'no answer' });
    }
  }
}

for (const entry of lines) {
  console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}: ${entry.detail}`);
}
const failed = lines.filter((entry) => !entry.ok).length;
console.log(failed === 0 ? 'GATE CHECK: PASS' : `GATE CHECK: FAIL (${String(failed)} lines)`);
process.exit(failed === 0 ? 0 : 1);
