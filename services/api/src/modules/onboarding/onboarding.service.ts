import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { Database, type Tx } from '../../platform/database.js';
import { AppError } from '../../platform/errors.js';
import { AuditService } from '../audit/audit.service.js';
import {
  type BusinessLocation,
  BusinessService,
  NORMALISATION_VERSION,
} from '../business/business.service.js';
import {
  lockMatchKeys,
  locationOf,
  matchBusiness,
  matchInputs,
  type MatchSubject,
} from '../business/matching.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { TenancyService } from '../tenancy/tenancy.service.js';

export type ApplicationStatus = 'submitted' | 'needs_review' | 'approved' | 'rejected';

/** Every legal status change of an application. A decision is final. */
export const APPLICATION_TRANSITIONS: Readonly<
  Record<ApplicationStatus, readonly ApplicationStatus[]>
> = {
  submitted: ['approved', 'needs_review', 'rejected'],
  needs_review: ['approved', 'rejected'],
  approved: [],
  rejected: [],
};

/** What the verification adapter says about the applicant's evidence (open question D-8). */
export type Verification = 'verified' | 'unverified';

export interface ApplicationInput {
  readonly kind: 'registered' | 'unregistered';
  readonly name: string;
  readonly country: string;
  readonly registration: { type: string; value: string } | null;
  readonly location: Omit<BusinessLocation, 'country'> | null;
  /** SANDBOX ONLY: the scripted answer of the sandbox verification adapter. */
  readonly verification: Verification;
}

export interface ApplicationView {
  readonly id: string;
  readonly status: ApplicationStatus;
  readonly kind: string;
  readonly name: string;
  readonly country: string;
  readonly workspace_id: string | null;
  readonly decision_reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ReviewView extends ApplicationView {
  readonly rule: string;
  readonly matched_business_id: string | null;
  readonly applicant_account_id: string;
}

type Application = Prisma.onboarding_applicationGetPayload<object>;

function view(row: Application): ApplicationView {
  return {
    id: row.id,
    status: row.status as ApplicationStatus,
    kind: row.kind,
    name: row.name,
    country: row.country,
    workspace_id: row.tenant_id,
    decision_reason: row.decision_reason,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

/**
 * Merchant onboarding (journey J3). An application is matched against existing
 * businesses by the rules of ADR 0012. A clear new business is onboarded at
 * once; a possible duplicate waits for an operator and creates nothing; an
 * exact match is never handed to a second applicant.
 */
@Injectable()
export class OnboardingService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(BusinessService) private readonly businesses: BusinessService,
    @Inject(TenancyService) private readonly tenancy: TenancyService,
    @Inject(LedgerService) private readonly ledger: LedgerService,
  ) {}

  async apply(
    actor: { accountId: string; requestId: string },
    idempotencyKey: string,
    input: ApplicationInput,
  ): Promise<{ application: ApplicationView; replayed: boolean }> {
    const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return this.db.asPlatform(async (tx) => {
      const account = await tx.user_account.findUniqueOrThrow({ where: { id: actor.accountId } });
      // The phone number is the financial identity (brief §2.1); a business needs one behind it.
      if (!account.phone_e164) {
        throw new AppError(
          'phone_required',
          'Add your phone number before registering a business.',
        );
      }
      if (input.registration) {
        const known = await tx.identifier_type.findUnique({
          where: { type_country: { type: input.registration.type, country: input.country } },
        });
        if (!known) throw new AppError('invalid_request', 'Invalid request: registration.type.');
      }

      const inserted = await tx.$queryRaw<{ id: string }[]>`
        insert into business.onboarding_application
          (applicant_account_id, idempotency_key, request_hash, kind, name, country,
           registration_type, registration_value, location, verification)
        values (${actor.accountId}::uuid, ${idempotencyKey}, ${requestHash}, ${input.kind},
                ${input.name}, ${input.country}, ${input.registration?.type ?? null},
                ${input.registration?.value ?? null},
                ${input.location ? JSON.stringify(input.location) : null}::jsonb,
                ${input.verification})
        on conflict (applicant_account_id, idempotency_key) do nothing
        returning id`;
      if (!inserted[0]) {
        const existing = await tx.onboarding_application.findFirstOrThrow({
          where: { applicant_account_id: actor.accountId, idempotency_key: idempotencyKey },
        });
        if (existing.request_hash !== requestHash) {
          throw new AppError(
            'idempotency_key_reused',
            'This Idempotency-Key was already used with a different request.',
          );
        }
        return { application: view(existing), replayed: true };
      }
      const application = await tx.onboarding_application.findUniqueOrThrow({
        where: { id: inserted[0].id },
      });

      // Applications that could be the same business take turns, so two of them
      // can never both conclude "new".
      const subject = subjectOf(application);
      await lockMatchKeys(tx, subject, account.person_id);
      const match = await matchBusiness(tx, subject, account.person_id);
      await tx.match_decision.create({
        data: {
          application_id: application.id,
          rule: match.rule,
          normalisation_version: NORMALISATION_VERSION,
          inputs: matchInputs(subject),
          outcome: match.outcome,
          matched_business_id: match.matchedBusinessId,
        },
      });

      let decided: Application;
      if (match.outcome === 'new') {
        decided = await this.approve(tx, application, account.person_id, null);
      } else if (match.outcome === 'review') {
        decided = await this.transition(tx, application, 'needs_review', {});
      } else {
        // The business exists. Its workspace belongs to whoever onboarded it; a
        // second applicant joins by invitation from its admin, never by applying.
        const workspace = match.matchedBusinessId
          ? await tx.workspace.findFirst({ where: { business_id: match.matchedBusinessId } })
          : null;
        decided = workspace
          ? await this.transition(tx, application, 'rejected', {
              business_id: match.matchedBusinessId,
              decision_reason: 'business_already_onboarded',
            })
          : await this.transition(tx, application, 'needs_review', {});
      }
      await this.audit.record(tx, {
        tenantId: decided.tenant_id,
        actorKind: 'user',
        actorAccountId: actor.accountId,
        action: `onboarding.application.${decided.status}`,
        subjectType: 'onboarding_application',
        subjectId: decided.id,
        outcome: 'success',
        requestId: actor.requestId,
        detail: { rule: match.rule, kind: decided.kind },
      });
      return { application: view(decided), replayed: false };
    });
  }

  async get(accountId: string, applicationId: string): Promise<ApplicationView> {
    const row = await this.db.asPlatform((tx) =>
      tx.onboarding_application.findFirst({
        where: { id: applicationId, applicant_account_id: accountId },
      }),
    );
    // Someone else's application looks like one that does not exist.
    if (!row) throw new AppError('not_found', 'Application not found.');
    return view(row);
  }

  async list(accountId: string): Promise<ApplicationView[]> {
    const rows = await this.db.asPlatform((tx) =>
      tx.onboarding_application.findMany({
        where: { applicant_account_id: accountId },
        orderBy: { created_at: 'desc' },
        take: 50,
      }),
    );
    return rows.map(view);
  }

  // --- Operator review queue ---

  async reviewQueue(): Promise<ReviewView[]> {
    return this.db.asPlatform(async (tx) => {
      const rows = await tx.onboarding_application.findMany({
        where: { status: 'needs_review' },
        orderBy: { created_at: 'asc' },
        take: 200,
        include: { match_decision: { orderBy: { created_at: 'desc' }, take: 1 } },
      });
      return rows.map((row) => ({
        ...view(row),
        rule: row.match_decision[0]?.rule ?? 'unknown',
        matched_business_id: row.match_decision[0]?.matched_business_id ?? null,
        applicant_account_id: row.applicant_account_id,
      }));
    });
  }

  /**
   * An operator's judgement on a possible duplicate: `distinct` onboards the
   * applicant as a new business, `same` rejects the application. Never a merge.
   */
  async decide(
    actor: { accountId: string; requestId: string },
    applicationId: string,
    decision: { outcome: 'distinct' | 'same'; reason: string },
  ): Promise<ApplicationView> {
    return this.db.asPlatform(async (tx) => {
      await tx.$queryRaw`
        select id from business.onboarding_application where id = ${applicationId}::uuid for update`;
      const application = await tx.onboarding_application.findUnique({
        where: { id: applicationId },
      });
      if (!application) throw new AppError('not_found', 'Application not found.');
      if (application.status !== 'needs_review') {
        throw new AppError(
          'invalid_state_transition',
          'This application has already been decided.',
        );
      }
      const applicant = await tx.user_account.findUniqueOrThrow({
        where: { id: application.applicant_account_id },
      });
      const decided =
        decision.outcome === 'distinct'
          ? await this.approve(tx, application, applicant.person_id, {
              decided_by: actor.accountId,
              decision_reason: decision.reason,
            })
          : await this.transition(tx, application, 'rejected', {
              decided_by: actor.accountId,
              decision_reason: decision.reason,
            });
      await this.audit.record(tx, {
        tenantId: decided.tenant_id,
        actorKind: 'user',
        actorAccountId: actor.accountId,
        action: 'onboarding.review.decided',
        subjectType: 'onboarding_application',
        subjectId: decided.id,
        outcome: 'success',
        requestId: actor.requestId,
        detail: { outcome: decision.outcome, reason: decision.reason, status: decided.status },
      });
      return view(decided);
    });
  }

  // --- Internals ---

  /**
   * Creates the business, its workspace, the applicant's admin membership and
   * the workspace's ledger accounts, in the caller's transaction. Being a
   * workspace admin grants no payout, financing or investment authority by
   * itself: those need their own permissions and a PIN step-up (rule 12).
   */
  private async approve(
    tx: Tx,
    application: Application,
    ownerPersonId: string,
    decision: { decided_by: string; decision_reason: string } | null,
  ): Promise<Application> {
    const verified = application.verification === 'verified';
    const businessId =
      application.kind === 'registered'
        ? await this.businesses.createRegistered(tx, {
            name: application.name,
            country: application.country,
            registrationType: application.registration_type ?? '',
            registrationValue: application.registration_value ?? '',
            verified,
          })
        : await this.businesses.createUnregistered(tx, {
            name: application.name,
            ownerPersonId,
            location: locationOf(subjectOf(application)),
          });
    // Tier follows verification (lessons §7): a verified registration starts higher.
    const tier = application.kind === 'registered' && verified ? 'tier_1' : 'tier_0';
    const tenantId = await this.tenancy.createWorkspace(tx, businessId, tier);
    await this.tenancy.addMember(tx, tenantId, application.applicant_account_id, 'admin');
    await this.ledger.openWorkspaceAccounts(tx, tenantId);
    return this.transition(tx, application, 'approved', {
      business_id: businessId,
      tenant_id: tenantId,
      ...(decision ?? {}),
    });
  }

  private async transition(
    tx: Tx,
    application: Application,
    to: ApplicationStatus,
    data: {
      business_id?: string | null;
      tenant_id?: string;
      decided_by?: string;
      decision_reason?: string;
    },
  ): Promise<Application> {
    const from = application.status as ApplicationStatus;
    if (!APPLICATION_TRANSITIONS[from].includes(to)) {
      throw new AppError(
        'invalid_state_transition',
        `Cannot move an application from ${from} to ${to}.`,
      );
    }
    const updated = await tx.onboarding_application.updateMany({
      where: { id: application.id, status: from },
      data: { status: to, ...data },
    });
    if (updated.count !== 1) {
      throw new AppError('invalid_state_transition', 'Application status changed concurrently.');
    }
    return tx.onboarding_application.findUniqueOrThrow({ where: { id: application.id } });
  }
}

function subjectOf(application: Application): MatchSubject {
  return {
    kind: application.kind as MatchSubject['kind'],
    name: application.name,
    country: application.country,
    registrationType: application.registration_type,
    registrationValue: application.registration_value,
    location: application.location,
    verification: application.verification as MatchSubject['verification'],
  };
}
