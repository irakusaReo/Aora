import { Inject, Injectable } from '@nestjs/common';
import { Database } from '../../../platform/database.js';
import { AuditService } from '../../audit/audit.service.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import { FeatureFlagsService } from '../../ops/feature-flags.js';
import { effective } from '../purchase-common.js';
import { addDays, nairobiToday } from '../schedule.js';
import { lateChargeFor } from './repayment.js';

/** Agreements whose parts can fall late, default or be reminded about. */
const COLLECTING = ['active', 'defaulted'];

export interface CollectionsRun {
  readonly late_marked: number;
  readonly charges_minor: string;
  readonly defaulted: number;
  readonly reminders: number;
  readonly in_contact_window: boolean;
}

/** Nairobi's hour of the day (UTC+3 all year). */
function nairobiHour(now: Date): number {
  return new Date(now.getTime() + 3 * 3_600_000).getUTCHours();
}

/**
 * KELO credit collections (phase 8B), run by the `kelo-credit` cron job.
 * Idempotent and safe to run late or twice: each step is a conditional update
 * or a deduplicated notification.
 *
 * - A part unpaid after its grace period becomes `late`, charged once, within
 *   the agreement's cap (r. 29, r. 30(2)).
 * - An agreement with a part overdue beyond its default period is marked
 *   non-performing (`defaulted`, r. 57). Nothing is ever reported to a bureau.
 * - Reminders go by email to the borrower only, before each due date and once
 *   after a missed one, only inside the contact window (r. 30(1)). They carry
 *   no link that acts and no threat.
 */
@Injectable()
export class CreditCollectionsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
    @Inject(FeatureFlagsService) private readonly flags: FeatureFlagsService,
  ) {}

  async run(now: Date = new Date()): Promise<CollectionsRun> {
    const today = nairobiToday(now);
    const late = await this.markLate(today);
    const defaulted = await this.markDefaulted(today);
    const policy = await this.db.asPlatform((tx) =>
      tx.reminder_policy.findFirst({ where: effective(now), orderBy: { version: 'desc' } }),
    );
    const hour = nairobiHour(now);
    const inWindow =
      policy !== null && hour >= policy.window_start_hour && hour < policy.window_end_hour;
    // Credit switched off sends nothing new; charges and default marking still follow the agreements.
    const reminders =
      policy && inWindow && (await this.flags.isEnabled('kelo_credit'))
        ? await this.remind(today, policy.days_before)
        : 0;
    return {
      late_marked: late.marked,
      charges_minor: late.charged.toString(),
      defaulted,
      reminders,
      in_contact_window: inWindow,
    };
  }

  private async markLate(today: string): Promise<{ marked: number; charged: bigint }> {
    const candidates = await this.db.asPlatform(
      (tx) => tx.$queryRaw<{ id: string; agreement_id: string }[]>`
        select i.id, i.agreement_id from kelo.credit_instalment i
          join kelo.credit_agreement a on a.id = i.agreement_id
         where i.status = 'due' and a.status = any(${COLLECTING}::text[])
           -- A part resumed after a pause counts from the day it resumed (8C).
           and greatest(i.due_on, coalesce(i.grace_from, i.due_on)) + a.grace_days < ${today}::date
         order by i.agreement_id, i.seq`,
    );
    let marked = 0;
    let charged = 0n;
    for (const candidate of candidates) {
      const charge = await this.db.asPlatform(async (tx) => {
        await tx.$queryRaw`select id from kelo.credit_agreement where id = ${candidate.agreement_id}::uuid for update`;
        const agreement = await tx.credit_agreement.findUniqueOrThrow({
          where: { id: candidate.agreement_id },
        });
        const line = await tx.credit_instalment.findUniqueOrThrow({ where: { id: candidate.id } });
        // Paid, paused or in flight since the scan: nothing to do.
        if (line.status !== 'due' || !COLLECTING.includes(agreement.status)) return null;
        const so = await tx.credit_instalment.aggregate({
          where: { agreement_id: agreement.id },
          _sum: { late_charges_minor: true },
        });
        const fee = lateChargeFor({
          feeMinor: agreement.late_fee_minor,
          capMinor: agreement.late_fee_total_cap_minor,
          chargedSoFarMinor: so._sum.late_charges_minor ?? 0n,
        });
        await tx.credit_instalment.update({
          where: { id: line.id },
          data: {
            status: 'late',
            late_on: new Date(`${today}T00:00:00Z`),
            late_charges_minor: line.late_charges_minor + fee,
          },
        });
        await this.audit.record(tx, {
          actorKind: 'system',
          action: 'kelo.credit.instalment_late',
          subjectType: 'kelo_credit_instalment',
          subjectId: line.id,
          outcome: 'success',
          detail: { seq: line.seq, late_charge_minor: fee.toString() },
        });
        return fee;
      });
      if (charge !== null) {
        marked += 1;
        charged += charge;
      }
    }
    return { marked, charged };
  }

  private async markDefaulted(today: string): Promise<number> {
    const agreements = await this.db.asPlatform(
      (tx) => tx.$queryRaw<{ id: string }[]>`
        select distinct a.id from kelo.credit_agreement a
          join kelo.credit_instalment i on i.agreement_id = a.id
         where a.status = 'active' and i.status in ('due', 'late')
           and greatest(i.due_on, coalesce(i.grace_from, i.due_on)) + a.default_after_days < ${today}::date`,
    );
    let count = 0;
    for (const { id } of agreements) {
      const moved = await this.db.asPlatform(async (tx) => {
        const updated = await tx.credit_agreement.updateMany({
          where: { id, status: 'active' },
          data: { status: 'defaulted' },
        });
        if (updated.count !== 1) return false;
        const agreement = await tx.credit_agreement.findUniqueOrThrow({ where: { id } });
        await tx.credit_agreement_event.create({
          data: {
            agreement_id: id,
            consumer_account_id: agreement.consumer_account_id,
            from_status: 'active',
            to_status: 'defaulted',
            actor_kind: 'system',
          },
        });
        await this.audit.record(tx, {
          actorKind: 'system',
          action: 'kelo.credit.agreement_defaulted',
          subjectType: 'kelo_credit_agreement',
          subjectId: id,
          outcome: 'success',
          detail: { default_after_days: agreement.default_after_days },
        });
        return true;
      });
      if (moved) count += 1;
    }
    return count;
  }

  private async remind(today: string, daysBefore: number[]): Promise<number> {
    const upcomingDates = daysBefore.map((days) => addDays(today, days));
    return this.db.asPlatform(async (tx) => {
      const rows = await tx.$queryRaw<
        {
          id: string;
          seq: number;
          due_on: Date;
          status: string;
          owed: bigint;
          late_charges_minor: bigint;
          consumer_account_id: string;
          purchase_id: string;
          currency: string;
          late_fee_total_cap_minor: bigint;
          title: string;
          exponent: number;
        }[]
      >`
        select i.id, i.seq, i.due_on, i.status,
               (i.principal_minor - i.paid_principal_minor + i.interest_minor - i.paid_interest_minor
                 - i.interest_waived_minor + i.late_charges_minor - i.paid_charges_minor)::bigint as owed,
               i.late_charges_minor, a.consumer_account_id, a.purchase_id, a.currency,
               a.late_fee_total_cap_minor, l.title, x.exponent
          from kelo.credit_instalment i
          join kelo.credit_agreement a on a.id = i.agreement_id
          join kelo.purchase p on p.id = a.purchase_id
          join kelo.listing l on l.id = p.listing_id
          join ledger.asset x on x.code = a.currency
         where a.status = any(${COLLECTING}::text[])
           and ((i.status = 'due' and i.due_on = any(${upcomingDates}::date[]))
                or i.status = 'late')`;
      let sent = 0;
      for (const row of rows) {
        const dueOn = row.due_on.toISOString().slice(0, 10);
        const kind = row.status === 'late' ? 'overdue' : 'upcoming';
        // One upcoming reminder per part per configured day; one overdue reminder per part.
        const dedupeKey =
          kind === 'overdue'
            ? `kelo.credit.reminder:${row.id}:overdue`
            : `kelo.credit.reminder:${row.id}:upcoming:${today}`;
        const before = await tx.notification.findUnique({ where: { dedupe_key: dedupeKey } });
        if (before) continue;
        await this.notifications.notify(tx, {
          dedupeKey,
          accountId: row.consumer_account_id,
          tenantId: null,
          type: 'kelo.credit.reminder',
          params: {
            kind,
            purchase_id: row.purchase_id,
            item: row.title,
            seq: row.seq,
            due_on: dueOn,
            amount_minor: row.owed.toString(),
            currency: row.currency,
            exponent: row.exponent,
            ...(kind === 'overdue'
              ? {
                  late_charge_minor: row.late_charges_minor.toString(),
                  late_charge_cap_minor: row.late_fee_total_cap_minor.toString(),
                }
              : {}),
          },
        });
        sent += 1;
      }
      return sent;
    });
  }
}
