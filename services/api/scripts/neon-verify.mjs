// Checks a Neon branch THROUGH THE POOLED CONNECTION, and reports pass or fail only.
//   pnpm neon:verify staging|development
//
// It proves, against the real pooler, what test/pooler.test.ts proves locally:
// tenant context is transaction-local, no role bypasses row-level security,
// and the ledger's triggers are in place. It writes nothing.
import pg from 'pg';

const target = String(process.argv[2] ?? '');
const prefix = target.toUpperCase();
const appUrl = process.env[`${prefix}_DATABASE_URL_APP`];
const platformUrl = process.env[`${prefix}_DATABASE_URL_PLATFORM`];
if (!appUrl || !platformUrl) {
  console.error(`FAIL: ${prefix}_DATABASE_URL_APP / _PLATFORM not set`);
  process.exit(1);
}

const checks = [];
const check = (name, ok) => checks.push({ name, ok: Boolean(ok) });

for (const [label, value] of [
  ['app', appUrl],
  ['platform', platformUrl],
]) {
  check(`${label} connection uses the pooler`, new URL(value).hostname.includes('-pooler'));
}

const app = new pg.Pool({ connectionString: appUrl, max: 4 });
const platform = new pg.Pool({ connectionString: platformUrl, max: 2 });
const probe = '00000000-0000-4000-8000-000000000001';
try {
  const roles = await platform.query(
    `select bool_or(rolsuper or rolbypassrls) as unsafe from pg_roles
     where rolname in ('aora_owner', 'aora_app', 'aora_platform')`,
  );
  check('no AORA role can bypass row-level security', roles.rows[0].unsafe === false);

  const unforced = await platform.query(
    `select count(*)::int as n from pg_attribute a
     join pg_class c on c.oid = a.attrelid and c.relkind = 'r'
     join pg_namespace n on n.oid = c.relnamespace
     where a.attname = 'tenant_id' and not a.attisdropped
       and n.nspname not in ('pg_catalog', 'information_schema')
       and not (c.relrowsecurity and c.relforcerowsecurity)`,
  );
  check('every tenant table forces row-level security', unforced.rows[0].n === 0);

  // Many interleaved transactions through the pooler: the tenant must never leak.
  let leaked = false;
  await Promise.all(
    Array.from({ length: 40 }, async (_, i) => {
      const client = await app.connect();
      try {
        await client.query('begin');
        if (i % 2 === 0) {
          await client.query(`select set_config('app.tenant_id', $1, true)`, [probe]);
        }
        const seen = await client.query(
          `select nullif(current_setting('app.tenant_id', true), '') as t`,
        );
        if ((i % 2 === 0 ? probe : null) !== seen.rows[0].t) leaked = true;
        const rows = await client.query('select count(*)::int as n from tenancy.membership');
        if (i % 2 === 1 && rows.rows[0].n !== 0) leaked = true;
        await client.query('commit');
      } finally {
        client.release();
      }
    }),
  );
  check('tenant context is transaction-local through the pooler', !leaked);

  const denied = await app.query('select 1 from identity.user_account limit 1').then(
    () => false,
    (error) => error.code === '42501',
  );
  check('the tenant role cannot read identity tables', denied);

  const triggers = await platform.query(
    `select count(*)::int as n from pg_trigger t join pg_class c on c.oid = t.tgrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'ledger' and not t.tgisinternal`,
  );
  check('ledger triggers are installed', triggers.rows[0].n >= 10);

  const zone = await app.query(`select current_setting('TimeZone') as z`);
  check('role time zone is UTC', zone.rows[0].z === 'UTC');
} catch (error) {
  check(`ran without error (${error.code ?? error.name})`, false);
} finally {
  await Promise.all([app.end(), platform.end()]);
}

for (const { name, ok } of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
process.exit(checks.every((entry) => entry.ok) ? 0 : 1);
