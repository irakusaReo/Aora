import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Database } from '../../platform/database.js';
import { AppError } from '../../platform/errors.js';
import { sessionOf } from '../../platform/http.js';
import { AuditService } from '../audit/audit.service.js';
import { ConsentService } from '../consent/consent.service.js';

export const CHIWO_TERMS = 'chiwo_terms';

export interface ChiwoMeView {
  readonly signed_up: boolean;
  readonly phone_on_file: boolean;
  readonly terms: { key: string; version: string };
}

/**
 * The personal context (phase-7 P7-1). A CHIWO consumer is one person acting
 * for themself. Nothing here reads or writes a workspace.
 */
@Injectable()
export class ConsumerService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ConsentService) private readonly consent: ConsentService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async me(accountId: string): Promise<ChiwoMeView> {
    const terms = await this.consent.currentTerms(CHIWO_TERMS);
    const [consumer, account] = await Promise.all([
      this.db.withConsumer(accountId, (tx) =>
        tx.consumer.findUnique({ where: { account_id: accountId } }),
      ),
      this.db.asPlatform((tx) =>
        tx.user_account.findUniqueOrThrow({
          where: { id: accountId },
          select: { phone_e164: true },
        }),
      ),
    ]);
    return {
      signed_up: consumer?.status === 'active',
      phone_on_file: account.phone_e164 !== null,
      terms: { key: terms.key, version: terms.version },
    };
  }

  /** Creates the consumer with personal-capacity consent to the current terms. Idempotent. */
  async signUp(
    accountId: string,
    requestId: string,
    termsVersion: string,
  ): Promise<{ view: ChiwoMeView; created: boolean }> {
    const created = await this.db.asPlatform(async (tx) => {
      await tx.$queryRaw`select id from identity.user_account where id = ${accountId}::uuid for update`;
      const existing = await tx.consumer.findUnique({ where: { account_id: accountId } });
      if (existing) return false;
      const account = await tx.user_account.findUniqueOrThrow({ where: { id: accountId } });
      // The phone number is the financial identity (brief §2.1): no CHIWO account without one.
      if (account.phone_e164 === null) {
        throw new AppError('phone_required', 'Add your phone number before signing up.');
      }
      const consent = await this.consent.recordIn(tx, accountId, requestId, {
        termsKey: CHIWO_TERMS,
        termsVersion,
        action: 'chiwo.sign_up',
        capacity: 'personal',
        tenantId: null,
      });
      await tx.consumer.create({ data: { account_id: accountId, consent_id: consent.id } });
      await this.audit.record(tx, {
        tenantId: null,
        actorKind: 'user',
        actorAccountId: accountId,
        action: 'chiwo.consumer.signed_up',
        subjectType: 'chiwo_consumer',
        subjectId: accountId,
        outcome: 'success',
        requestId,
      });
      return true;
    });
    return { view: await this.me(accountId), created };
  }

  async isActive(accountId: string): Promise<boolean> {
    const consumer = await this.db.withConsumer(accountId, (tx) =>
      tx.consumer.findUnique({ where: { account_id: accountId }, select: { status: true } }),
    );
    return consumer?.status === 'active';
  }
}

const BEFORE_SIGN_UP = 'chiwo:before_sign_up';
/** Marks a CHIWO route that a signed-in person may use before signing up. */
export const BeforeSignUp = (): MethodDecorator => SetMetadata(BEFORE_SIGN_UP, true);

/**
 * The personal-context barrier (P7-1). Use after SessionGuard. A request that
 * names a workspace is refused outright, so a business context can never leak
 * into a personal action; every other CHIWO route needs a signed-up consumer.
 */
@Injectable()
export class ConsumerGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ConsumerService) private readonly consumers: ConsumerService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    if (request.header('aora-workspace-id') !== undefined) {
      throw new AppError(
        'context_mismatch',
        'CHIWO is personal. Do not send a workspace with a CHIWO request.',
      );
    }
    if (this.reflector.get<boolean | undefined>(BEFORE_SIGN_UP, context.getHandler())) return true;
    if (!(await this.consumers.isActive(sessionOf(request).accountId))) {
      throw new AppError('sign_up_required', 'Sign up to CHIWO first.');
    }
    return true;
  }
}
