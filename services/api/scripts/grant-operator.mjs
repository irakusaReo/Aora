// Marks an existing account as a platform operator on a Neon environment and
// records an audit event for it. Prints ids only, never connection strings.
//
//   pnpm ops:grant-operator staging|development <email> "<reason>"
//
// The schema owner changes the flag (the platform role has no right to); the
// platform role writes the audit event (the audit table admits no other writer).
// Run by the owner, by hand: granting operator access is the owner's decision.
import pg from 'pg';

const [environment, email, reason] = process.argv.slice(2);
const prefix = { staging: 'STAGING', development: 'DEVELOPMENT' }[environment ?? ''];
if (!prefix || !email || !reason || reason.trim().length < 10) {
  console.error('Usage: grant-operator staging|development <email> "<reason of 10+ characters>"');
  process.exit(2);
}
const ownerUrl = process.env[`${prefix}_DATABASE_URL_OWNER`];
const platformUrl = process.env[`${prefix}_DATABASE_URL_PLATFORM`];
if (!ownerUrl || !platformUrl) {
  console.error(
    `Missing ${prefix}_DATABASE_URL_OWNER or ${prefix}_DATABASE_URL_PLATFORM in .env.local`,
  );
  process.exit(2);
}

const owner = new pg.Client({ connectionString: ownerUrl });
const platform = new pg.Client({ connectionString: platformUrl });
await owner.connect();
await platform.connect();
try {
  const found = await owner.query(
    `select id, is_platform_operator from identity.user_account
     where lower(email) = lower($1) and status = 'active'`,
    [email],
  );
  if (found.rows.length !== 1) {
    console.log(`FAIL: expected one active account with that email, found ${found.rows.length}`);
    process.exitCode = 1;
  } else if (found.rows[0].is_platform_operator) {
    console.log(`account ${found.rows[0].id} is already a platform operator; nothing changed`);
  } else {
    const id = found.rows[0].id;
    await owner.query('begin');
    await owner.query(
      `update identity.user_account set is_platform_operator = true where id = $1`,
      [id],
    );
    try {
      await platform.query(
        `insert into audit.audit_event (actor_kind, action, subject_type, subject_id, outcome, detail)
         values ('system', 'identity.operator.granted', 'user_account', $1, 'success', $2::jsonb)`,
        [id, JSON.stringify({ method: 'scripts/grant-operator.mjs', reason: reason.trim() })],
      );
      await owner.query('commit');
      console.log(`PASS: account ${id} is now a platform operator; audit event recorded`);
    } catch (error) {
      await owner.query('rollback');
      throw error;
    }
  }
} finally {
  await owner.end();
  await platform.end();
}
