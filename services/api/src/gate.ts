// The MVP gate's read-only checks (phase-10 10B; mvp-scope §4 G1). Each line is
// pass or fail with a short reason; nothing here writes, and no line ever
// carries a secret or a connection string.

export interface GateLine {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

interface Deployment {
  readonly contracts: Readonly<Record<string, { readonly address: string }>>;
}

export interface GateInput {
  /** Read-only SQL on the target database (the platform connection). */
  readonly query: (sql: string) => Promise<Record<string, unknown>[]>;
  /** A GET on the target API. */
  readonly get: (path: string) => Promise<{ status: number; body: unknown }>;
  /** contracts/deployments/base-sepolia.json, or null when nothing is deployed. */
  readonly deployment: Deployment | null;
  /** The addresses the API is configured with (chain config). */
  readonly configured: { namUsdcVault: string | null; anchorRegistry: string | null };
}

const line = (name: string, ok: boolean, detail: string): GateLine => ({ name, ok, detail });

export async function gateChecks(input: GateInput): Promise<GateLine[]> {
  return [
    await health(input),
    await trialBalance(input),
    await runningBalances(input),
    await openExceptions(input),
    await categories(input),
    contracts(input),
  ];
}

async function health(input: GateInput): Promise<GateLine> {
  const name = 'api health';
  try {
    const { status, body } = await input.get('/v1/health');
    const report = body as { status?: string; database?: string; chain?: string; mode?: string };
    const ok = status === 200 && report.status === 'ok' && report.database === 'ok';
    return line(
      name,
      ok && report.mode === 'sandbox',
      `status ${String(report.status)}, database ${String(report.database)}, chain ${String(report.chain)}, mode ${String(report.mode)}`,
    );
  } catch {
    return line(name, false, 'the API did not answer');
  }
}

async function trialBalance(input: GateInput): Promise<GateLine> {
  const rows = await input.query(`
    select asset_code, sum(case when direction = 'debit' then amount else -amount end)::text as net
      from ledger.posting group by asset_code`);
  const off = rows.filter((row) => row['net'] !== '0').map((row) => String(row['asset_code']));
  return line(
    'trial balance is zero in every asset',
    off.length === 0,
    off.length === 0 ? `${String(rows.length)} assets balanced` : `not zero in ${off.join(', ')}`,
  );
}

async function runningBalances(input: GateInput): Promise<GateLine> {
  const rows = await input.query(`
    select count(*)::text as mismatched from ledger.account a
      left join ledger.account_balance b on b.account_id = a.id
      left join lateral (
        select coalesce(sum(case when p.direction = a.normal_side then p.amount else -p.amount end), 0) as total
          from ledger.posting p where p.account_id = a.id) s on true
     where coalesce(b.balance, 0) <> s.total`);
  const value = rows[0]?.['mismatched'];
  const mismatched = typeof value === 'string' ? value : '0';
  return line(
    'every running balance equals its postings',
    mismatched === '0',
    `${mismatched} accounts differ`,
  );
}

async function openExceptions(input: GateInput): Promise<GateLine> {
  const rows = await input.query(`
    select type, count(*)::text as n from payments.reconciliation_exception
     where status = 'open' group by type order by type`);
  return line(
    'no open reconciliation exception',
    rows.length === 0,
    rows.length === 0
      ? 'none open'
      : rows.map((row) => `${String(row['type'])}: ${String(row['n'])}`).join(', '),
  );
}

async function categories(input: GateInput): Promise<GateLine> {
  // The category version in effect now, and its published listings.
  const rows = await input.query(`
    select c.slug, (select count(*) from kelo.listing l
                     where l.category_slug = c.slug and l.status = 'published')::text as published
      from kelo.category c
     where c.effective_from <= now() and (c.effective_to is null or c.effective_to > now())
     order by c.slug`);
  const empty = rows.filter((row) => row['published'] === '0').map((row) => String(row['slug']));
  return line(
    'every category has a published listing',
    rows.length > 0 && empty.length === 0,
    empty.length === 0 ? `${String(rows.length)} categories` : `none in ${empty.join(', ')}`,
  );
}

function contracts(input: GateInput): GateLine {
  const name = 'contract addresses match contracts/deployments';
  const deployed = input.deployment?.contracts;
  if (!deployed) {
    return line(name, false, 'not deployed: the sandbox wallet must be funded first');
  }
  const pairs: [string, string | null][] = [
    ['NamUsdcVault', input.configured.namUsdcVault],
    ['AnchorRegistry', input.configured.anchorRegistry],
  ];
  const wrong = pairs
    .filter(([contract, configured]) => {
      const recorded = deployed[contract]?.address;
      return !recorded || !configured || recorded.toLowerCase() !== configured.toLowerCase();
    })
    .map(([contract]) => contract);
  return line(
    name,
    wrong.length === 0,
    wrong.length === 0 ? 'both match' : `differs: ${wrong.join(', ')}`,
  );
}
