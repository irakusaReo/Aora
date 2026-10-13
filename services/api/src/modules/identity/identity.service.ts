import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../platform/config.js';
import { Database } from '../../platform/database.js';
import { AppError } from '../../platform/errors.js';
import type { Role, SessionContext } from '../../platform/http.js';
import { AuditService } from '../audit/audit.service.js';
import { AUTH_PROVIDER, type AuthProvider, type ChallengePurpose } from './auth-provider.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class IdentityService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AUTH_PROVIDER) private readonly provider: AuthProvider,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * Always returns a challenge id, whether or not the phone number has an
   * account, so the endpoint cannot be used to discover who is registered.
   */
  async startChallenge(phoneE164: string, purpose: ChallengePurpose): Promise<string> {
    return this.db.asPlatform(async (tx) => {
      const account = await tx.user_account.findUnique({ where: { phone_e164: phoneE164 } });
      if (!account) return randomUUID();
      const state = await this.provider.startChallenge({ phoneE164, purpose });
      const challenge = await tx.auth_challenge.create({
        data: {
          account_id: account.id,
          purpose,
          code_hash: state,
          expires_at: new Date(Date.now() + this.config.auth.challengeTtlSeconds * 1000),
        },
      });
      return challenge.id;
    });
  }

  async startStepUpFor(accountId: string): Promise<string> {
    return this.db.asPlatform(async (tx) => {
      const account = await tx.user_account.findUniqueOrThrow({ where: { id: accountId } });
      const state = await this.provider.startChallenge({
        phoneE164: account.phone_e164,
        purpose: 'step_up',
      });
      const challenge = await tx.auth_challenge.create({
        data: {
          account_id: account.id,
          purpose: 'step_up',
          code_hash: state,
          expires_at: new Date(Date.now() + this.config.auth.challengeTtlSeconds * 1000),
        },
      });
      return challenge.id;
    });
  }

  /** Exchanges a sign-in challenge and code for a session token. The token is returned once. */
  async createSession(
    challengeId: string,
    code: string,
    requestId: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    const accountId = await this.consumeChallenge(challengeId, code, 'sign_in', null, requestId);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.config.auth.sessionTtlSeconds * 1000);
    await this.db.asPlatform(async (tx) => {
      const session = await tx.session.create({
        data: { account_id: accountId, token_hash: hashToken(token), expires_at: expiresAt },
      });
      await this.audit.record(tx, {
        actorKind: 'user',
        actorAccountId: accountId,
        action: 'identity.session.created',
        subjectType: 'session',
        subjectId: session.id,
        outcome: 'success',
        requestId,
      });
    });
    return { token, expiresAt };
  }

  async stepUp(
    session: SessionContext,
    challengeId: string,
    code: string,
    requestId: string,
  ): Promise<Date> {
    await this.consumeChallenge(challengeId, code, 'step_up', session.accountId, requestId);
    const until = new Date(Date.now() + this.config.auth.stepUpTtlSeconds * 1000);
    await this.db.asPlatform(async (tx) => {
      await tx.session.update({ where: { id: session.sessionId }, data: { step_up_until: until } });
      await this.audit.record(tx, {
        actorKind: 'user',
        actorAccountId: session.accountId,
        action: 'identity.step_up.completed',
        subjectType: 'session',
        subjectId: session.sessionId,
        outcome: 'success',
        requestId,
      });
    });
    return until;
  }

  async authenticate(token: string): Promise<SessionContext | null> {
    return this.db.asPlatform(async (tx) => {
      const session = await tx.session.findUnique({
        where: { token_hash: hashToken(token) },
        include: { user_account: true },
      });
      if (!session || session.revoked_at || session.expires_at <= new Date()) return null;
      const memberships = await tx.membership.findMany({
        where: { account_id: session.account_id },
      });
      return {
        sessionId: session.id,
        accountId: session.account_id,
        isPlatformOperator: session.user_account.is_platform_operator,
        stepUpUntil: session.step_up_until,
        memberships: memberships.map((row) => ({
          tenantId: row.tenant_id,
          role: row.role as Role,
        })),
      };
    });
  }

  private async consumeChallenge(
    challengeId: string,
    code: string,
    purpose: ChallengePurpose,
    expectedAccountId: string | null,
    requestId: string,
  ): Promise<string> {
    const failure = new AppError('unauthenticated', 'The code is incorrect or has expired.');
    if (!UUID.test(challengeId)) throw failure;

    const result = await this.db.asPlatform(async (tx) => {
      // Lock the row so concurrent guesses cannot exceed the attempt limit.
      const rows = await tx.$queryRaw<{ id: string }[]>`
        select id from identity.auth_challenge where id = ${challengeId}::uuid for update`;
      if (rows.length === 0) return { ok: false as const, locked: false };
      const challenge = await tx.auth_challenge.findUniqueOrThrow({ where: { id: challengeId } });
      if (
        challenge.purpose !== purpose ||
        challenge.consumed_at ||
        challenge.expires_at <= new Date() ||
        (expectedAccountId !== null && challenge.account_id !== expectedAccountId)
      ) {
        return { ok: false as const, locked: false };
      }
      if (challenge.attempts >= this.config.auth.maxChallengeAttempts) {
        return { ok: false as const, locked: true };
      }
      const valid = await this.provider.verifyChallenge({ state: challenge.code_hash, code });
      await tx.auth_challenge.update({
        where: { id: challengeId },
        data: valid ? { consumed_at: new Date() } : { attempts: { increment: 1 } },
      });
      if (!valid) {
        await this.audit.record(tx, {
          actorKind: 'user',
          actorAccountId: challenge.account_id,
          action: `identity.${purpose}.code_rejected`,
          subjectType: 'auth_challenge',
          subjectId: challenge.id,
          outcome: 'denied',
          requestId,
        });
        return { ok: false as const, locked: false };
      }
      return { ok: true as const, accountId: challenge.account_id };
    });

    if (result.ok) return result.accountId;
    if (result.locked) {
      throw new AppError('too_many_attempts', 'Too many incorrect codes. Start again.');
    }
    throw failure;
  }
}
