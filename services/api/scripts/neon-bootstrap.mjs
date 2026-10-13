// Creates AORA's three database roles on a Neon branch. Sandbox only.
//
//   pnpm neon:bootstrap staging|development
//
// Why a script: roles created in the Neon Console, CLI or API join
// neon_superuser, which can bypass row-level security. Roles created with SQL
// do not (ADR 0013). So these are created with SQL, by the project's default
// role, using the direct admin connection string in .env.local.
//
// Passwords are generated here, written only to .env.local, and never printed.
import { randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const target = process.argv[2];
if (target !== 'staging' && target !== 'development') {
  console.error('usage: pnpm neon:bootstrap staging|development');
  process.exit(2);
}
const prefix = target.toUpperCase();
const adminUrl = process.env[`NEON_ADMIN_URL_${prefix}`];
if (!adminUrl) {
  console.error(
    `NEON_ADMIN_URL_${prefix} is not set in .env.local (see docs/operations/neon-setup.md).`,
  );
  process.exit(1);
}
const admin = new URL(adminUrl);
if (!admin.hostname.endsWith('.neon.tech')) {
  console.error('The admin URL does not point at Neon. Refusing to continue.');
  process.exit(1);
}
if (admin.hostname.includes('-pooler')) {
  console.error('The admin URL is a pooled connection string. Use the direct one (pooling off).');
  process.exit(1);
}

const roles = ['aora_owner', 'aora_app', 'aora_platform'];
const passwords = Object.fromEntries(
  roles.map((role) => [role, randomBytes(24).toString('base64url')]),
);
const database = admin.pathname.slice(1);

const client = new pg.Client({ connectionString: adminUrl });
await client.connect();
try {
  for (const role of roles) {
    const exists = await client.query('select 1 from pg_roles where rolname = $1', [role]);
    const literal = (await client.query('select quote_literal($1) as q', [passwords[role]])).rows[0]
      .q;
    await client.query(
      exists.rowCount
        ? `alter role ${role} login password ${literal}`
        : `create role ${role} login password ${literal}`,
    );
    await client.query(`alter role ${role} set timezone = 'UTC'`);
  }
  // The owner runs migrations: it needs to create schemas, and Prisma's bookkeeping table in public.
  await client.query(`grant create on database "${database}" to aora_owner`);
  await client.query('grant usage, create on schema public to aora_owner');

  const check = await client.query(
    `select rolname, rolsuper, rolbypassrls,
            pg_has_role(rolname, 'neon_superuser', 'member') as neon_superuser
     from pg_roles where rolname = any($1)`,
    [roles],
  );
  const unsafe = check.rows.filter((row) => row.rolsuper || row.rolbypassrls || row.neon_superuser);
  if (unsafe.length > 0) {
    console.error(
      `FAIL: these roles can bypass row-level security: ${unsafe.map((row) => row.rolname).join(', ')}`,
    );
    process.exit(1);
  }
} finally {
  await client.end();
}

const direct = admin.hostname;
const [endpoint, ...rest] = direct.split('.');
const pooled = [`${endpoint}-pooler`, ...rest].join('.');
const url = (role, host) => {
  const built = new URL(adminUrl);
  built.username = role;
  built.password = passwords[role];
  built.hostname = host;
  return built.toString();
};
const lines = {
  [`${prefix}_DATABASE_URL_OWNER`]: url('aora_owner', direct),
  [`${prefix}_DATABASE_URL_APP`]: url('aora_app', pooled),
  [`${prefix}_DATABASE_URL_PLATFORM`]: url('aora_platform', pooled),
};

const envPath = fileURLToPath(new URL('../../../.env.local', import.meta.url));
const kept = readFileSync(envPath, 'utf8')
  .split('\n')
  .filter((line) => !Object.keys(lines).some((key) => line.startsWith(`${key}=`)));
writeFileSync(envPath, kept.join('\n').replace(/\n+$/, '\n'));
appendFileSync(
  envPath,
  Object.entries(lines)
    .map(([key, value]) => `${key}=${value}\n`)
    .join(''),
);

console.log(`PASS: roles created on ${target}; no role can bypass row-level security.`);
console.log(`Wrote ${Object.keys(lines).join(', ')} to .env.local (values not shown).`);
