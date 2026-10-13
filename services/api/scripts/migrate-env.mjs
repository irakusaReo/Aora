// Runs the SQL migrations on a Neon branch through the DIRECT owner connection.
//   pnpm db:migrate:staging | pnpm db:migrate:development
import { spawnSync } from 'node:child_process';

const target = process.argv[2];
const url = process.env[`${String(target).toUpperCase()}_DATABASE_URL_OWNER`];
if (!url) {
  console.error(
    `${String(target).toUpperCase()}_DATABASE_URL_OWNER is not set. Run pnpm neon:bootstrap ${target} first.`,
  );
  process.exit(1);
}
if (new URL(url).hostname.includes('-pooler')) {
  console.error('Migrations must use the direct connection, not the pooler.');
  process.exit(1);
}
const result = spawnSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL_OWNER: url },
});
process.exit(result.status ?? 1);
