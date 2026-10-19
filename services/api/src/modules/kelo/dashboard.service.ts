import { Inject, Injectable } from '@nestjs/common';
import { Database } from '../../platform/database.js';

export interface KeloDashboard {
  readonly currency: string;
  readonly orders_needing_action: {
    confirm: number;
    fulfil: number;
    respond_to_return: number;
    total: number;
  };
  /** Credit orders delivered (and so settled by KELO), whatever happened after. */
  readonly bnpl_sales: { count: number; gross_minor: string };
  readonly settlements: {
    /** Orders KELO will pay on delivery: credit in force, or layaway paid in full. */
    due: { count: number; net_minor: string };
    paid: {
      count: number;
      gross_minor: string;
      fees_minor: string;
      clawback_netted_minor: string;
      to_available_minor: string;
    };
  };
  readonly returns: {
    open: number;
    accepted: number;
    clawed_back_minor: string;
    clawback_outstanding_minor: string;
  };
  readonly fees: { charged_minor: string; refunded_minor: string; net_minor: string };
}

const SETTLEMENTS = ['kelo_layaway_settlement', 'kelo_credit_settlement'];

/**
 * The KELO section's dashboard in KONY (phase 8D; kelo-experience §3). Every
 * money figure is read from the ledger entries that name this workspace, so it
 * equals the ledger by construction; order counts come from the order machine.
 * Nothing about any buyer or their credit is read or returned.
 */
@Injectable()
export class KeloDashboardService {
  constructor(@Inject(Database) private readonly db: Database) {}

  async forWorkspace(tenantId: string, currency = 'KES'): Promise<KeloDashboard> {
    // The platform role, with the workspace named in every statement: the
    // ledger rows involved include KELO's platform accounts.
    return this.db.asPlatform(async (tx) => {
      const [orders] = await tx.$queryRaw<
        { confirm: number; fulfil: number; respond: number; due_count: number; due_net: bigint }[]
      >`
        select
          count(*) filter (where p.status = 'payment_ready')::int as confirm,
          count(*) filter (where p.status = 'merchant_confirmed'
                            and (p.plan_type <> 'layaway' or p.plan_status = 'paid_in_full'))::int as fulfil,
          (select count(*)::int from kelo.purchase_claim c
            where c.tenant_id = ${tenantId}::uuid and c.kind = 'return' and c.status = 'open') as respond,
          count(*) filter (where p.status in ('payment_ready', 'merchant_confirmed')
                            and (p.plan_type <> 'layaway' or p.plan_status = 'paid_in_full'))::int as due_count,
          coalesce(sum(p.total_minor - p.merchant_fee_minor)
                     filter (where p.status in ('payment_ready', 'merchant_confirmed')
                              and (p.plan_type <> 'layaway' or p.plan_status = 'paid_in_full')), 0)::bigint as due_net
        from kelo.purchase p
        where p.tenant_id = ${tenantId}::uuid and p.currency = ${currency}`;
      const [paid] = await tx.$queryRaw<
        {
          count: number;
          credit_count: number;
          credit_gross: bigint;
          to_available: bigint;
          netted: bigint;
          fees: bigint;
        }[]
      >`
        select
          count(distinct e.id)::int as count,
          count(distinct e.id) filter (where e.entry_type = 'kelo_credit_settlement')::int as credit_count,
          coalesce(sum(p.amount) filter (where e.entry_type = 'kelo_credit_settlement'
                                            and p.direction = 'credit'), 0)::bigint as credit_gross,
          coalesce(sum(p.amount) filter (where a.type = 'merchant_available' and p.direction = 'credit'), 0)::bigint as to_available,
          coalesce(sum(p.amount) filter (where a.type = 'merchant_kelo_clawback_receivable'
                                            and p.direction = 'credit'), 0)::bigint as netted,
          coalesce(sum(p.amount) filter (where a.type = 'kelo_fee_revenue' and p.direction = 'credit'), 0)::bigint as fees
        from ledger.journal_entry e
        join ledger.posting p on p.entry_id = e.id
        join ledger.account a on a.id = p.account_id
        where e.tenant_id = ${tenantId}::uuid and e.entry_type = any(${SETTLEMENTS}::text[])
          and a.asset_code = ${currency}`;
      const [returned] = await tx.$queryRaw<
        { accepted: number; open: number; clawed_back: bigint; fees_refunded: bigint }[]
      >`
        select
          (select count(*)::int from kelo.purchase_claim c
            where c.tenant_id = ${tenantId}::uuid and c.status = 'accepted') as accepted,
          (select count(*)::int from kelo.purchase_claim c
            where c.tenant_id = ${tenantId}::uuid and c.status = 'open') as open,
          coalesce(sum(p.amount) filter (where a.type = 'merchant_kelo_clawback_receivable'
                                            and p.direction = 'debit'), 0)::bigint as clawed_back,
          coalesce(sum(p.amount) filter (where a.type = 'kelo_fee_revenue' and p.direction = 'debit'), 0)::bigint as fees_refunded
        from ledger.journal_entry e
        join ledger.posting p on p.entry_id = e.id
        join ledger.account a on a.id = p.account_id
        where e.tenant_id = ${tenantId}::uuid and e.entry_type = 'kelo_credit_return'
          and a.asset_code = ${currency}`;
      const [outstanding] = await tx.$queryRaw<{ balance: bigint }[]>`
        select coalesce(sum(b.balance), 0)::bigint as balance
          from ledger.account a join ledger.account_balance b on b.account_id = a.id
         where a.tenant_id = ${tenantId}::uuid and a.type = 'merchant_kelo_clawback_receivable'
           and a.asset_code = ${currency}`;
      const o = orders ?? { confirm: 0, fulfil: 0, respond: 0, due_count: 0, due_net: 0n };
      const s = paid ?? {
        count: 0,
        credit_count: 0,
        credit_gross: 0n,
        to_available: 0n,
        netted: 0n,
        fees: 0n,
      };
      const r = returned ?? { accepted: 0, open: 0, clawed_back: 0n, fees_refunded: 0n };
      const gross = s.to_available + s.netted + s.fees;
      return {
        currency,
        orders_needing_action: {
          confirm: o.confirm,
          fulfil: o.fulfil,
          respond_to_return: o.respond,
          total: o.confirm + o.fulfil + o.respond,
        },
        bnpl_sales: { count: s.credit_count, gross_minor: s.credit_gross.toString() },
        settlements: {
          due: { count: o.due_count, net_minor: o.due_net.toString() },
          paid: {
            count: s.count,
            gross_minor: gross.toString(),
            fees_minor: s.fees.toString(),
            clawback_netted_minor: s.netted.toString(),
            to_available_minor: s.to_available.toString(),
          },
        },
        returns: {
          open: r.open,
          accepted: r.accepted,
          clawed_back_minor: r.clawed_back.toString(),
          clawback_outstanding_minor: (outstanding?.balance ?? 0n).toString(),
        },
        fees: {
          charged_minor: s.fees.toString(),
          refunded_minor: r.fees_refunded.toString(),
          net_minor: (s.fees - r.fees_refunded).toString(),
        },
      };
    });
  }
}
