import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { Database, type Tx } from '../../platform/database.js';
import { AppError } from '../../platform/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import type { RestrictionKind } from '../tenancy/tenancy.service.js';

export const EVENT_STORE_APPROVED = 'kelo.store.approved';

export type StoreStatus = 'submitted' | 'approved' | 'rejected';

export type StoreBusiness =
  | { readonly workspaceId: string }
  | {
      readonly kind: 'registered' | 'unregistered';
      readonly name: string;
      readonly country: string;
      readonly registration: { type: string; value: string } | null;
      readonly location: { area: string; locality: string; place: string } | null;
      /** SANDBOX ONLY: the scripted answer of the sandbox verification adapter (D-8). */
      readonly verification: 'verified' | 'unverified';
    };

export interface StoreInput {
  readonly displayName: string;
  readonly categories: readonly string[];
  readonly business: StoreBusiness;
}

export interface StoreView {
  readonly id: string;
  readonly status: StoreStatus;
  readonly display_name: string;
  readonly categories: readonly string[];
  readonly workspace_id: string | null;
  readonly provisioning_status: string | null;
  readonly decision_reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

type Store = Prisma.storeGetPayload<{ include: { provisioning: true } }>;

function view(row: Store): StoreView {
  return {
    id: row.id,
    status: row.status as StoreStatus,
    display_name: row.display_name,
    categories: row.category_slugs,
    workspace_id: row.tenant_id,
    provisioning_status: row.provisioning?.status ?? null,
    decision_reason: row.status === 'rejected' ? row.decision_reason : null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

/** The version of a category in effect now, or null if it has none. */
export async function currentCategory(
  tx: Tx,
  slug: string,
): Promise<Prisma.categoryGetPayload<object> | null> {
  const now = new Date();
  return tx.category.findFirst({
    where: {
      slug,
      effective_from: { lte: now },
      OR: [{ effective_to: null }, { effective_to: { gt: now } }],
    },
    orderBy: { version: 'desc' },
  });
}

/**
 * KELO store enlistment and vetting (ADR 0017). Approval starts the ADR 0008
 * provisioning workflow through the outbox, in the same transaction.
 */
@Injectable()
export class StoresService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  async enlist(
    actor: { accountId: string; requestId: string },
    idempotencyKey: string,
    input: StoreInput,
  ): Promise<{ store: StoreView; replayed: boolean }> {
    const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return this.db.asPlatform(async (tx) => {
      const earlier = await tx.store.findUnique({
        where: {
          applicant_account_id_idempotency_key: {
            applicant_account_id: actor.accountId,
            idempotency_key: idempotencyKey,
          },
        },
        include: { provisioning: true },
      });
      if (earlier) {
        if (earlier.request_hash !== requestHash) {
          throw new AppError(
            'idempotency_key_reused',
            'This Idempotency-Key was already used with a different request.',
          );
        }
        return { store: view(earlier), replayed: true };
      }

      const account = await tx.user_account.findUniqueOrThrow({ where: { id: actor.accountId } });
      // The phone number is the financial identity (brief §2.1); a business needs one behind it.
      if (!account.phone_e164) {
        throw new AppError('phone_required', 'Add your phone number before enlisting a store.');
      }
      const categories = [...new Set(input.categories)];
      for (const slug of categories) {
        if (!(await currentCategory(tx, slug))) {
          throw new AppError('invalid_request', 'Invalid request: categories.');
        }
      }

      const business = input.business;
      let data: Prisma.storeUncheckedCreateInput;
      if ('workspaceId' in business) {
        // Enlisting an existing KONY workspace is for its administrators only.
        const membership = await tx.membership.findFirst({
          where: {
            tenant_id: business.workspaceId,
            account_id: actor.accountId,
            role: 'admin',
            status: 'active',
          },
        });
        if (!membership) {
          throw new AppError('forbidden', 'You do not have access to this workspace or action.');
        }
        data = {
          applicant_account_id: actor.accountId,
          idempotency_key: idempotencyKey,
          request_hash: requestHash,
          display_name: input.displayName,
          category_slugs: categories,
          existing_tenant_id: business.workspaceId,
        };
      } else {
        if (business.registration) {
          const known = await tx.identifier_type.findUnique({
            where: {
              type_country: { type: business.registration.type, country: business.country },
            },
          });
          if (!known) throw new AppError('invalid_request', 'Invalid request: registration.type.');
        }
        data = {
          applicant_account_id: actor.accountId,
          idempotency_key: idempotencyKey,
          request_hash: requestHash,
          display_name: input.displayName,
          category_slugs: categories,
          kind: business.kind,
          name: business.name,
          country: business.country,
          registration_type: business.registration?.type ?? null,
          registration_value: business.registration?.value ?? null,
          ...(business.location ? { location: business.location } : {}),
          verification: business.verification,
        };
      }
      const created = await tx.store.create({ data, include: { provisioning: true } });
      await this.audit.record(tx, {
        tenantId: null,
        actorKind: 'user',
        actorAccountId: actor.accountId,
        action: 'kelo.store.submitted',
        subjectType: 'kelo_store',
        subjectId: created.id,
        outcome: 'success',
        requestId: actor.requestId,
        detail: { categories, existing_workspace: created.existing_tenant_id !== null },
      });
      return { store: view(created), replayed: false };
    });
  }

  async get(accountId: string, storeId: string): Promise<StoreView> {
    const row = await this.db.asPlatform((tx) =>
      tx.store.findFirst({
        where: { id: storeId, applicant_account_id: accountId },
        include: { provisioning: true },
      }),
    );
    // Someone else's store looks like one that does not exist.
    if (!row) throw new AppError('not_found', 'Store not found.');
    return view(row);
  }

  async list(accountId: string): Promise<StoreView[]> {
    const rows = await this.db.asPlatform((tx) =>
      tx.store.findMany({
        where: { applicant_account_id: accountId },
        orderBy: { created_at: 'desc' },
        include: { provisioning: true },
        take: 50,
      }),
    );
    return rows.map(view);
  }

  /** The store linked to a workspace, for its members. */
  async forWorkspace(tenantId: string): Promise<StoreView | null> {
    const row = await this.db.withTenant(tenantId, (tx) =>
      tx.store.findFirst({ where: { tenant_id: tenantId } }),
    );
    if (!row) return null;
    return view({ ...row, provisioning: null });
  }

  // --- Operator vetting ---

  async operatorList(status: StoreStatus): Promise<StoreView[]> {
    const rows = await this.db.asPlatform((tx) =>
      tx.store.findMany({
        where: { status },
        orderBy: { created_at: 'asc' },
        include: { provisioning: true },
        take: 200,
      }),
    );
    return rows.map(view);
  }

  async operatorGet(storeId: string): Promise<
    Omit<StoreView, 'categories'> & {
      applicant_account_id: string;
      business: { kind: string | null; name: string | null; country: string | null };
      existing_workspace_id: string | null;
      verification: string | null;
      restrictions: string[];
      categories: { slug: string; name: string; version: number; requirements: string[] }[];
    }
  > {
    return this.db.asPlatform(async (tx) => {
      const row = await tx.store.findUnique({
        where: { id: storeId },
        include: { provisioning: true },
      });
      if (!row) throw new AppError('not_found', 'Store not found.');
      const categories = [];
      for (const slug of row.category_slugs) {
        const category = await currentCategory(tx, slug);
        if (category) {
          categories.push({
            slug,
            name: category.name,
            version: category.version,
            requirements: category.vetting_requirements,
          });
        }
      }
      return {
        ...view(row),
        applicant_account_id: row.applicant_account_id,
        business: { kind: row.kind, name: row.name, country: row.country },
        existing_workspace_id: row.existing_tenant_id,
        verification: row.verification,
        restrictions: row.restrictions,
        categories,
      };
    });
  }

  /**
   * An operator's vetting decision. Approval needs every requirement of every
   * category attested, and starts provisioning in the same transaction.
   */
  async decide(
    actor: { accountId: string; requestId: string },
    storeId: string,
    decision: {
      outcome: 'approved' | 'rejected';
      reason: string;
      attestations: Record<string, readonly string[]>;
      restrictions: readonly RestrictionKind[];
    },
  ): Promise<StoreView> {
    return this.db.asPlatform(async (tx) => {
      await tx.$queryRaw`select id from kelo.store where id = ${storeId}::uuid for update`;
      const store = await tx.store.findUnique({ where: { id: storeId } });
      if (!store) throw new AppError('not_found', 'Store not found.');
      if (store.status !== 'submitted') {
        throw new AppError('invalid_state_transition', 'This store has already been decided.');
      }

      if (decision.outcome === 'approved') {
        for (const slug of store.category_slugs) {
          const category = await currentCategory(tx, slug);
          const attested = new Set(decision.attestations[slug] ?? []);
          if (!category || !category.vetting_requirements.every((key) => attested.has(key))) {
            throw new AppError(
              'invalid_request',
              `Invalid request: attestations.${slug} must cover every vetting requirement.`,
            );
          }
          await tx.store_category.create({
            data: {
              store_id: store.id,
              category_slug: slug,
              category_version: category.version,
              attested: [...attested].sort(),
            },
          });
        }
      }
      const updated = await tx.store.updateMany({
        where: { id: store.id, status: 'submitted' },
        data: {
          status: decision.outcome,
          restrictions: decision.outcome === 'approved' ? [...new Set(decision.restrictions)] : [],
          decided_by: actor.accountId,
          decision_reason: decision.reason,
          decided_at: new Date(),
        },
      });
      if (updated.count !== 1) {
        throw new AppError('invalid_state_transition', 'Store status changed concurrently.');
      }
      if (decision.outcome === 'approved') {
        await tx.provisioning.create({ data: { store_id: store.id } });
        await this.outbox.enqueue(tx, {
          tenantId: null,
          type: EVENT_STORE_APPROVED,
          payload: { store_id: store.id },
        });
      }
      await this.audit.record(tx, {
        tenantId: store.existing_tenant_id,
        actorKind: 'user',
        actorAccountId: actor.accountId,
        action: `kelo.store.${decision.outcome}`,
        subjectType: 'kelo_store',
        subjectId: store.id,
        outcome: 'success',
        requestId: actor.requestId,
        detail: { reason: decision.reason, restrictions: [...decision.restrictions] },
      });
      return view(
        await tx.store.findUniqueOrThrow({
          where: { id: store.id },
          include: { provisioning: true },
        }),
      );
    });
  }
}
