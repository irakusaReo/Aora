import type { Harness } from './harness.js';

/** A workspace's balance of one account type, read past row-level security. */
export async function balanceOf(
  h: Harness,
  tenantId: string | null,
  type: string,
): Promise<bigint> {
  return h.owner(async (client) => {
    const result = await client.query<{ balance: string }>(
      `select coalesce(sum(b.balance), 0)::text as balance from ledger.account a
       left join ledger.account_balance b on b.account_id = a.id
       where a.type = $2 and ($1::uuid is null and a.tenant_id is null or a.tenant_id = $1::uuid)`,
      [tenantId, type],
    );
    return BigInt(result.rows[0]?.balance ?? '0');
  });
}

/** Sum of debits minus credits across the whole ledger: zero when every entry balances. */
export async function trialBalance(h: Harness): Promise<bigint> {
  return h.owner(async (client) => {
    const result = await client.query<{ net: string }>(
      `select coalesce(sum(case when direction = 'debit' then amount else -amount end), 0)::text as net
       from ledger.posting`,
    );
    return BigInt(result.rows[0]?.net ?? '0');
  });
}
