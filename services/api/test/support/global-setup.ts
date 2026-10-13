import { applyMigrations, TEMPLATE, withClient } from './pg.js';

/** Builds one migrated template database; each test file clones it. */
export default async function setup(): Promise<void> {
  // Database housekeeping needs a superuser: pooled connections of other roles may still be open.
  await withClient('postgres', 'postgres', async (client) => {
    const stale = await client.query<{ datname: string }>(
      `select datname from pg_database where datname like 'aora_test\\_%'`,
    );
    for (const row of stale.rows) {
      await client.query(`drop database if exists "${row.datname}" with (force)`);
    }
    await client.query(`create database "${TEMPLATE}" owner aora_owner`);
  });
  await applyMigrations(TEMPLATE);
}
