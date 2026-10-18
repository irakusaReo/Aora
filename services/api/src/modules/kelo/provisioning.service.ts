import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { Database, type Tx } from '../../platform/database.js';
import { AppError } from '../../platform/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { BusinessService } from '../business/business.service.js';
import {
  lockMatchKeys,
  locationOf,
  matchBusiness,
  type MatchSubject,
} from '../business/matching.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { OutboxService, type OutboxEvent } from '../outbox/outbox.service.js';
import { type RestrictionKind, TenancyService } from '../tenancy/tenancy.service.js';
import { EVENT_STORE_APPROVED } from './stores.service.js';

export type ProvisioningStatus =
  | 'requested'
  | 'business_resolved'
  | 'workspace_linked'
  | 'admin_assigned'
  | 'completed'
  | 'failed_retryable'
  | 'failed_needs_review'
  | 'reconciliation_required';

type Step = 'requested' | 'business_resolved' | 'workspace_linked' | 'admin_assigned' | 'completed';

/** The step after each committed step: the workflow is linear (ADR 0008). */
const NEXT: Record<Exclude<Step, 'completed'>, Step> = {
  requested: 'business_resolved',
  business_resolved: 'workspace_linked',
  workspace_linked: 'admin_assigned',
  admin_assigned: 'completed',
};

/** States a step will not move on from by itself. */
const STOPPED: readonly ProvisioningStatus[] = [
  'completed',
  'failed_needs_review',
  'reconciliation_required',
];

/** A non-terminal record untouched for this long is picked up again by the backfill. */
const STALE_MINUTES = 10;

export interface ProvisioningView {
  readonly id: string;
  readonly store_id: string;
  readonly status: ProvisioningStatus;
  readonly last_step: Step;
  readonly reason: string | null;
  readonly business_id: string | null;
  readonly workspace_id: string | null;
  readonly attempts: number;
  readonly updated_at: string;
}

type Record_ = Prisma.provisioningGetPayload<object>;
type Store = Prisma.storeGetPayload<object>;

/** The outcome of one step: the next state, or a stop with a reason code. */
type Outcome =
  | { readonly to: Step; readonly data?: Prisma.provisioningUncheckedUpdateInput }
  | { readonly stop: 'failed_needs_review' | 'reconciliation_required'; readonly reason: string };

function view(row: Record_): ProvisioningView {
  return {
    id: row.id,
    store_id: row.store_id,
    status: row.status as ProvisioningStatus,
    last_step: row.last_step as Step,
    reason: row.reason,
    business_id: row.business_id,
    workspace_id: row.tenant_id,
    attempts: row.attempts,
    updated_at: row.updated_at.toISOString(),
  };
}

function subjectOf(store: Store): MatchSubject {
  return {
    kind: store.kind as MatchSubject['kind'],
    name: store.name ?? '',
    country: store.country ?? '',
    registrationType: store.registration_type,
    registrationValue: store.registration_value,
    location: store.location,
    verification: (store.verification ?? 'unverified') as MatchSubject['verification'],
  };
}

/**
 * KELO-to-KONY provisioning (ADR 0008). Each step is its own transaction that
 * locks the record, checks where it stands and commits one move, so a crash
 * resumes from the last committed step and a duplicate delivery does nothing.
 * Exactly one workspace is guaranteed by constraints: one record per store,
 * one store per workspace, one workspace per business and product.
 * Provisioning grants workspace administration only: no payment, payout,
 * financing or investment authority (brief §4.5).
 */
@Injectable()
export class ProvisioningService implements OnModuleInit {
  private readonly logger = new Logger('Provisioning');

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(BusinessService) private readonly businesses: BusinessService,
    @Inject(TenancyService) private readonly tenancy: TenancyService,
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.outbox.register(EVENT_STORE_APPROVED, (event) => this.handle(event));
  }

  private async handle(event: OutboxEvent): Promise<void> {
    const payload = event.payload as { store_id?: unknown };
    if (typeof payload.store_id !== 'string') return;
    // A linear workflow of four steps; the bound only guards against a bug looping.
    for (let i = 0; i < 8; i += 1) {
      if (await this.stepByStore(payload.store_id)) return;
    }
  }

  /**
   * Runs at most one step for the store's provisioning record. Returns true when
   * the record is in a state that does not move on by itself.
   */
  async stepByStore(storeId: string): Promise<boolean> {
    // Set once a step has started, so a failure can be pinned to it.
    const progress: { from: Step | null } = { from: null };
    try {
      return await this.db.asPlatform(async (tx) => {
        await tx.$executeRaw`
          insert into kelo.provisioning (store_id)
          select id from kelo.store where id = ${storeId}::uuid and status = 'approved'
          on conflict (store_id) do nothing`;
        const locked = await tx.$queryRaw<{ id: string }[]>`
          select id from kelo.provisioning where store_id = ${storeId}::uuid for update`;
        if (!locked[0]) return true; // Not approved: nothing to provision.
        const record = await tx.provisioning.findUniqueOrThrow({ where: { id: locked[0].id } });
        if (STOPPED.includes(record.status as ProvisioningStatus)) return true;
        const store = await tx.store.findUniqueOrThrow({ where: { id: storeId } });

        const from = record.last_step as Exclude<Step, 'completed'>;
        progress.from = from;
        const outcome = await this.runStep(tx, NEXT[from], record, store);
        if ('stop' in outcome) {
          await tx.provisioning.update({
            where: { id: record.id },
            data: { status: outcome.stop, reason: outcome.reason, attempts: { increment: 1 } },
          });
          await this.record(tx, record, outcome.stop, { reason: outcome.reason });
          return true;
        }
        await tx.provisioning.update({
          where: { id: record.id },
          data: {
            ...outcome.data,
            status: outcome.to,
            last_step: outcome.to,
            reason: null,
            attempts: { increment: 1 },
          },
        });
        await this.record(tx, record, outcome.to, {});
        return outcome.to === 'completed';
      });
    } catch (error) {
      if (progress.from === null) throw error;
      // The step's transaction rolled back; the record still names the last
      // committed step. Mark it retryable and let the outbox try again later.
      const reason = error instanceof AppError ? error.code : 'step_failed';
      await this.db.asPlatform(async (tx) => {
        const record = await tx.provisioning.findUnique({ where: { store_id: storeId } });
        if (!record || STOPPED.includes(record.status as ProvisioningStatus)) return;
        await tx.provisioning.update({
          where: { id: record.id },
          data: { status: 'failed_retryable', reason, attempts: { increment: 1 } },
        });
        await this.record(tx, record, 'failed_retryable', { reason });
      });
      this.logger.warn(`provisioning step after ${progress.from} failed (${reason}); will retry`);
      throw error;
    }
  }

  private runStep(tx: Tx, step: Step, record: Record_, store: Store): Promise<Outcome> {
    switch (step) {
      case 'business_resolved':
        return this.resolveBusiness(tx, store);
      case 'workspace_linked':
        return this.linkWorkspace(tx, record, store);
      case 'admin_assigned':
        return this.assignAdmin(tx, record, store);
      case 'completed':
        return this.complete(tx, record, store);
      case 'requested':
        throw new Error('requested is never a target step');
    }
  }

  /** Step 1: which canonical business is this store? ADR 0012 matching; never a merge. */
  private async resolveBusiness(tx: Tx, store: Store): Promise<Outcome> {
    if (store.existing_tenant_id) {
      const workspace = await tx.workspace.findUniqueOrThrow({
        where: { id: store.existing_tenant_id },
      });
      return this.resolved(tx, store, workspace.business_id);
    }
    const applicant = await tx.user_account.findUniqueOrThrow({
      where: { id: store.applicant_account_id },
    });
    const subject = subjectOf(store);
    await lockMatchKeys(tx, subject, applicant.person_id);
    const match = await matchBusiness(tx, subject, applicant.person_id);
    if (match.outcome === 'review') return { stop: 'failed_needs_review', reason: match.rule };
    if (match.outcome === 'same' && match.matchedBusinessId) {
      return this.resolved(tx, store, match.matchedBusinessId);
    }
    const businessId =
      subject.kind === 'registered'
        ? await this.businesses.createRegistered(tx, {
            name: subject.name,
            country: subject.country,
            registrationType: subject.registrationType ?? '',
            registrationValue: subject.registrationValue ?? '',
            verified: subject.verification === 'verified',
          })
        : await this.businesses.createUnregistered(tx, {
            name: subject.name,
            ownerPersonId: applicant.person_id,
            location: locationOf(subject),
          });
    return this.resolved(tx, store, businessId);
  }

  private async resolved(tx: Tx, store: Store, businessId: string): Promise<Outcome> {
    if (store.business_id && store.business_id !== businessId) {
      return { stop: 'reconciliation_required', reason: 'store_business_mismatch' };
    }
    if (!store.business_id) {
      await tx.store.update({ where: { id: store.id }, data: { business_id: businessId } });
    }
    return { to: 'business_resolved', data: { business_id: businessId } };
  }

  /**
   * Step 2: link the business's KONY workspace, creating it if there is none.
   * An existing workspace is linked only for someone who already administers it.
   */
  private async linkWorkspace(tx: Tx, record: Record_, store: Store): Promise<Outcome> {
    const businessId = record.business_id;
    if (!businessId) return { stop: 'reconciliation_required', reason: 'business_missing' };
    // Stores of one business take turns here, so only one can create its workspace.
    await tx.$executeRaw`select pg_advisory_xact_lock(hashtextextended(${`kelo:business:${businessId}`}::text, 0))`;

    if (store.tenant_id) return { to: 'workspace_linked', data: { tenant_id: store.tenant_id } };
    const existing = await tx.workspace.findFirst({
      where: { business_id: businessId, product: 'kony' },
    });
    if (existing) {
      const linked = await tx.store.findFirst({ where: { tenant_id: existing.id } });
      if (linked) return { stop: 'failed_needs_review', reason: 'workspace_has_store' };
      const admin = await tx.membership.findFirst({
        where: {
          tenant_id: existing.id,
          account_id: store.applicant_account_id,
          role: 'admin',
          status: 'active',
        },
      });
      if (!admin) {
        return { stop: 'failed_needs_review', reason: 'workspace_belongs_to_another_admin' };
      }
      await tx.store.update({ where: { id: store.id }, data: { tenant_id: existing.id } });
      return { to: 'workspace_linked', data: { tenant_id: existing.id } };
    }
    if (store.existing_tenant_id) {
      return { stop: 'reconciliation_required', reason: 'named_workspace_missing' };
    }
    // Tier follows verification (lessons §7), as for KONY onboarding.
    const tier =
      store.kind === 'registered' && store.verification === 'verified' ? 'tier_1' : 'tier_0';
    const tenantId = await this.tenancy.createWorkspace(tx, businessId, tier);
    await this.ledger.openWorkspaceAccounts(tx, tenantId);
    await tx.store.update({ where: { id: store.id }, data: { tenant_id: tenantId } });
    return { to: 'workspace_linked', data: { tenant_id: tenantId } };
  }

  /** Step 3: the applicant as administrator, and the store's restrictions on the workspace. */
  private async assignAdmin(tx: Tx, record: Record_, store: Store): Promise<Outcome> {
    const tenantId = record.tenant_id;
    if (!tenantId) return { stop: 'reconciliation_required', reason: 'workspace_missing' };
    const membership = await tx.membership.findFirst({
      where: { tenant_id: tenantId, account_id: store.applicant_account_id },
    });
    if (!membership) {
      await this.tenancy.addMember(tx, tenantId, store.applicant_account_id, 'admin');
    } else if (membership.role !== 'admin' || membership.status !== 'active') {
      return { stop: 'failed_needs_review', reason: 'applicant_has_other_role' };
    }
    for (const kind of store.restrictions as RestrictionKind[]) {
      await this.tenancy.addRestriction(tx, {
        tenantId,
        kind,
        source: 'kelo.vetting',
        sourceId: store.id,
      });
    }
    return { to: 'admin_assigned', data: { admin_account_id: store.applicant_account_id } };
  }

  /** Step 4: done. The merchant is told, and telling them never blocks completion. */
  private async complete(tx: Tx, record: Record_, store: Store): Promise<Outcome> {
    await this.notifications.notify(tx, {
      dedupeKey: `kelo.store.ready:${store.id}`,
      accountId: store.applicant_account_id,
      tenantId: record.tenant_id,
      type: 'kelo.store.ready',
      params: { store_name: store.display_name },
    });
    return { to: 'completed' };
  }

  private async record(
    tx: Tx,
    record: Record_,
    status: ProvisioningStatus,
    detail: { reason?: string },
  ): Promise<void> {
    const current = await tx.provisioning.findUniqueOrThrow({ where: { id: record.id } });
    await this.audit.record(tx, {
      tenantId: current.tenant_id,
      actorKind: 'system',
      action: `kelo.provisioning.${status}`,
      subjectType: 'kelo_provisioning',
      subjectId: record.id,
      outcome: STOPPED.includes(status) && status !== 'completed' ? 'failure' : 'success',
      detail: { store_id: record.store_id, ...detail },
    });
  }

  // --- Backfill (the migration path, ADR 0008) and operator tools ---

  /**
   * Finds approved stores whose provisioning never ran, or stalled before
   * finishing, and starts them again. Idempotent: a second run finds nothing.
   */
  async backfill(): Promise<{ enqueued: number }> {
    return this.db.asPlatform(async (tx) => {
      const due = await tx.$queryRaw<{ id: string }[]>`
        select s.id
          from kelo.store s
          left join kelo.provisioning p on p.store_id = s.id
         where s.status = 'approved'
           and (p.id is null
                or (p.status not in ('completed', 'failed_needs_review', 'reconciliation_required')
                    and p.updated_at < now() - make_interval(mins => ${STALE_MINUTES})))
         order by s.created_at
         limit 200`;
      for (const row of due) {
        await tx.$executeRaw`
          insert into kelo.provisioning (store_id) values (${row.id}::uuid)
          on conflict (store_id) do nothing`;
        await this.outbox.enqueue(tx, {
          tenantId: null,
          type: EVENT_STORE_APPROVED,
          payload: { store_id: row.id },
        });
      }
      return { enqueued: due.length };
    });
  }

  async list(status: ProvisioningStatus): Promise<ProvisioningView[]> {
    const rows = await this.db.asPlatform((tx) =>
      tx.provisioning.findMany({ where: { status }, orderBy: { updated_at: 'desc' }, take: 200 }),
    );
    return rows.map(view);
  }

  /**
   * An operator sends a stopped or failing record back to its last committed
   * step. Retrying changes no facts: the same rules decide again.
   */
  async retry(
    actor: { accountId: string; requestId: string },
    id: string,
    reason: string,
  ): Promise<ProvisioningView> {
    return this.db.asPlatform(async (tx) => {
      await tx.$queryRaw`select id from kelo.provisioning where id = ${id}::uuid for update`;
      const record = await tx.provisioning.findUnique({ where: { id } });
      if (!record) throw new AppError('not_found', 'Provisioning record not found.');
      if (record.status === 'completed' || record.status === record.last_step) {
        throw new AppError('invalid_state_transition', 'This record is not stopped or failing.');
      }
      const updated = await tx.provisioning.update({
        where: { id },
        data: { status: record.last_step, reason: null },
      });
      await this.outbox.enqueue(tx, {
        tenantId: null,
        type: EVENT_STORE_APPROVED,
        payload: { store_id: record.store_id },
      });
      await this.audit.record(tx, {
        tenantId: record.tenant_id,
        actorKind: 'user',
        actorAccountId: actor.accountId,
        action: 'kelo.provisioning.retried',
        subjectType: 'kelo_provisioning',
        subjectId: id,
        outcome: 'success',
        requestId: actor.requestId,
        detail: { store_id: record.store_id, from: record.status, reason },
      });
      return view(updated);
    });
  }
}
