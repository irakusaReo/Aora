import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HOST = process.env['AORA_TEST_PG_HOST'] ?? '127.0.0.1';
const PORT = process.env['AORA_TEST_PG_PORT'] ?? '54329';
export const TEMPLATE = 'aora_test_template';

export function url(role: string, database: string): string {
  return `postgresql://${role}@${HOST}:${PORT}/${database}`;
}

export async function withClient<T>(
  role: string,
  database: string,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: url(role, database) });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** Applies every reviewed SQL migration, in order, as the schema owner. */
export async function applyMigrations(database: string): Promise<void> {
  const root = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));
  const names = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  await withClient('aora_owner', database, async (client) => {
    for (const name of names) {
      await client.query(readFileSync(`${root}${name}/migration.sql`, 'utf8'));
    }
  });
}
