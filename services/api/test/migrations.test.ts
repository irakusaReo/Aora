import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Data backfills in migrations run against databases that already hold rows
// (staging), while the test template is migrated empty. A backfill that reads
// a table must therefore be readable by the role that runs migrations.

const root = fileURLToPath(new URL('../prisma/migrations/', import.meta.url));
const migrations = readdirSync(root)
  .sort()
  .map((name) => ({ name, sql: readFileSync(`${root}${name}/migration.sql`, 'utf8') }));

describe('migrations', () => {
  it('give the migration role read access to tenancy.workspace before any backfill reads it', () => {
    let readable = false;
    for (const { name, sql } of migrations) {
      if (/create policy \w+ on tenancy\.workspace for select to aora_owner/.test(sql))
        readable = true;
      const backfill = /insert into[\s\S]{0,400}?from tenancy\.workspace/i.test(sql);
      // 20261014000300 is the release that hit this; it is fixed forward by 20261014000400.
      if (backfill && name !== '20261014000300_settlement_payouts_refunds') {
        expect(readable, `${name} backfills from tenancy.workspace`).toBe(true);
      }
    }
  });
});
