import { applyMigrations, TEMPLATE, withClient } from './pg.js';

/** Builds one migrated template database; each test file clones it. */
export default async function setup(): Promise<void> {
  await withClient('aora_owner', 'postgres', async (client) => {
    const stale = await client.query<{ datname: string }>(
      `select datname from pg_database where datname like 'aora_test\\_%'`,
    );
    for (const row of stale.rows) {
      await client.query(`drop database if exists "${row.datname}" with (force)`);
    }
    await client.query(`create database "${TEMPLATE}"`);
  });
  await applyMigrations(TEMPLATE);
}
