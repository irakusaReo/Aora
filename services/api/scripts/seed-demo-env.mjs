// Runs the SANDBOX demo seed (dist/seed-demo.js) against a target database.
//   pnpm db:seed:demo            local database, from .env.local
//   pnpm db:seed:demo staging    the Neon branch behind AORA staging
//
// For a Neon branch it uses that branch's pooled application connections and
// forces Clerk as the authenticator, so the test-only sandbox authenticator can
// never be enabled against it. It prints no connection string.
import { spawnSync } from 'node:child_process';

const target = String(process.argv[2] ?? 'local');
const env = { ...process.env };
if (target !== 'local') {
  const prefix = target.toUpperCase();
  for (const kind of ['APP', 'PLATFORM', 'OWNER']) {
    const value = process.env[`${prefix}_DATABASE_URL_${kind}`];
    if (!value) {
      console.error(`FAIL: ${prefix}_DATABASE_URL_${kind} is not set.`);
      process.exit(1);
    }
    env[`DATABASE_URL_${kind}`] = value;
  }
  env.AUTH_PROVIDER = 'clerk';
}
const result = spawnSync('node', ['dist/seed-demo.js'], { stdio: 'inherit', env });
process.exit(result.status ?? 1);
