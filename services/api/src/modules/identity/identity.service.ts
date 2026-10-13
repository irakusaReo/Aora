import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../platform/config.js';
import { Database } from '../../platform/database.js';
import { AppError } from '../../platform/errors.js';
import type { SessionContext } from '../../platform/http.js';
import { AuditService } from '../audit/audit.service.js';
import { TenancyService } from '../tenancy/tenancy.service.js';
import { AUTH_PROVIDER, type AuthProvider, type ChallengePurpose } from './auth-provider.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const scryptAsync = promisify(scrypt) as (
  password: Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Six digits, not all the same, not a straight run up or down. */
export function isAcceptablePin(pin: string): boolean {
  if (!/^[0-9]{6}$/.test(pin)) return false;
  const digits = Array.from({ length: pin.length }, (_, index) => Number(pin.charAt(index)));
  const steps = digits.slice(1).map((digit, index) => digit - (digits[index] ?? 0));
  return !steps.every((step) => step === steps[0] && Math.abs(step) <= 1);
}

@Injectable()
export class IdentityService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AUTH_PROVIDER) private readonly provider: AuthProvider,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(TenancyService) private readonly tenancy: TenancyService,
  ) {}

  /**
   * Always returns a challenge id, whether or not the phone number has an
   * account, so the endpoint cannot be used to discover who is registered.
   */
  async startChallenge(phoneE164: string, purpose: ChallengePurpose): Promise<string> {
    const account = await this.db.asPlatform((tx) =>
      tx.user_account.findUnique({ where: { phone_e164: phoneE164 } }),
    );
    if (!account) return randomUUID();
    // The provider may call an SMS service; that happens outside any transaction.
    const state = await this.provider.startChallenge({ phoneE164, purpose });
    const challenge = await this.db.asPlatform((tx) =>
      tx.auth_challenge.create({
        data: {
          account_id: account.id,
          purpose,
          code_hash: state,
          expires_at: new Date(Date.now() + this.config.auth.challengeTtlSeconds * 1000),
        },
      }),
    );
    return challenge.id;
  }

  async startPinChallenge(accountId: string): Promise<string> {
    const account = await this.db.asPlatform((tx) =>
      tx.user_account.findUniqueOrThrow({ where: { id: accountId } }),
    );
    return this.startChallenge(account.phone_e164, 'pin_setup');
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

  async signOut(session: SessionContext, requestId: string): Promise<void> {
    await this.db.asPlatform(async (tx) => {
      await tx.session.update({
        where: { id: session.sessionId },
        data: { revoked_at: new Date() },
      });
      await this.audit.record(tx, {
        actorKind: 'user',
        actorAccountId: session.accountId,
        action: 'identity.session.revoked',
        subjectType: 'session',
        subjectId: session.sessionId,
        outcome: 'success',
        requestId,
      });
    });
  }

  /**
   * Sets or changes the PIN. Always needs a fresh one-time code, so a stolen
   * session cannot set a PIN, and a forgotten or locked PIN can be replaced.
   */
  async setPin(
    session: SessionContext,
    input: { pin: string; challengeId: string; code: string },
    requestId: string,
  ): Promise<void> {
    if (!isAcceptablePin(input.pin)) {
      throw new AppError(
        'invalid_request',
        'Choose a 6-digit PIN that is not a repeated digit or a simple sequence.',
      );
    }
    await this.consumeChallenge(
      input.challengeId,
      input.code,
      'pin_setup',
      session.accountId,
      requestId,
    );
    const pinHash = await this.hashPin(input.pin, randomBytes(16));
    await this.db.asPlatform(async (tx) => {
      await tx.user_account.update({
        where: { id: session.accountId },
        data: {
          pin_hash: pinHash,
          pin_set_at: new Date(),
          pin_failed_attempts: 0,
          pin_locked_until: null,
        },
      });
      await this.pinAudit(tx, session, 'set', 'success', requestId);
    });
  }

  /** Confirms a sensitive action with the PIN. See the state machine in docs/plans/phase-2.md §5. */
  async stepUp(session: SessionContext, pin: string, requestId: string): Promise<Date> {
    const account = await this.db.asPlatform((tx) =>
      tx.user_account.findUniqueOrThrow({ where: { id: session.accountId } }),
    );
    if (!account.pin_hash) {
      throw new AppError('pin_not_set', 'Set a PIN before confirming this action.');
    }
    // Hashing is deliberately slow; do it before taking the row lock.
    const [, , saltHex] = account.pin_hash.split('$');
    const candidate = await this.hashPin(pin, Buffer.from(saltHex ?? '', 'hex'));

    const outcome = await this.db.asPlatform(async (tx) => {
      await tx.$queryRaw`select id from identity.user_account where id = ${session.accountId}::uuid for update`;
      const current = await tx.user_account.findUniqueOrThrow({ where: { id: session.accountId } });
      const now = new Date();
      if (current.pin_locked_until && current.pin_locked_until > now) return 'locked' as const;

      const stored = Buffer.from(current.pin_hash ?? '');
      const given = Buffer.from(candidate);
      const correct = stored.length === given.length && timingSafeEqual(stored, given);
      if (correct) {
        const until = new Date(now.getTime() + this.config.auth.stepUpTtlSeconds * 1000);
        await tx.user_account.update({
          where: { id: current.id },
          data: { pin_failed_attempts: 0, pin_locked_until: null },
        });
        await tx.session.update({
          where: { id: session.sessionId },
          data: { step_up_until: until },
        });
        await this.pinAudit(tx, session, 'verified', 'success', requestId);
        return until;
      }

      // An expired lock starts a fresh count.
      const previous = current.pin_locked_until ? 0 : current.pin_failed_attempts;
      const attempts = previous + 1;
      const lock = attempts >= this.config.auth.maxPinAttempts;
      await tx.user_account.update({
        where: { id: current.id },
        data: {
          pin_failed_attempts: lock ? 0 : attempts,
          pin_locked_until: lock
            ? new Date(now.getTime() + this.config.auth.pinLockSeconds * 1000)
            : null,
        },
      });
      await this.pinAudit(tx, session, 'rejected', 'denied', requestId);
      if (lock) await this.pinAudit(tx, session, 'locked', 'denied', requestId);
      return 'wrong' as const;
    });

    if (outcome === 'locked') {
      throw new AppError(
        'too_many_attempts',
        'PIN locked after too many wrong attempts. Try later or reset it.',
      );
    }
    if (outcome === 'wrong') throw new AppError('unauthenticated', 'Incorrect PIN.');
    return outcome;
  }

  async authenticate(token: string): Promise<SessionContext | null> {
    return this.db.asPlatform(async (tx) => {
      const session = await tx.session.findUnique({
        where: { token_hash: hashToken(token) },
        include: { user_account: true },
      });
      if (!session || session.revoked_at || session.expires_at <= new Date()) return null;
      return {
        sessionId: session.id,
        accountId: session.account_id,
        isPlatformOperator: session.user_account.is_platform_operator,
        stepUpUntil: session.step_up_until,
        memberships: await this.tenancy.membershipsOf(tx, session.account_id),
      };
    });
  }

  /** scrypt over an HMAC with a server-side pepper, so a database leak alone cannot test PINs. */
  private async hashPin(pin: string, salt: Buffer): Promise<string> {
    const peppered = createHmac('sha256', this.config.pinPepper).update(pin).digest();
    const derived = await scryptAsync(peppered, salt, 32, SCRYPT);
    return `scrypt$15$${salt.toString('hex')}$${derived.toString('hex')}`;
  }

  private pinAudit(
    tx: Parameters<AuditService['record']>[0],
    session: SessionContext,
    event: 'set' | 'verified' | 'rejected' | 'locked',
    outcome: 'success' | 'denied',
    requestId: string,
  ): Promise<void> {
    return this.audit.record(tx, {
      actorKind: 'user',
      actorAccountId: session.accountId,
      action: `identity.pin.${event}`,
      subjectType: 'user_account',
      subjectId: session.accountId,
      outcome,
      requestId,
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
