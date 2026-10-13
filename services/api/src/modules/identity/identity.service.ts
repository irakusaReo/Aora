import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../platform/config.js';
import { Database, type Tx } from '../../platform/database.js';
import { AppError } from '../../platform/errors.js';
import type { SessionContext } from '../../platform/http.js';
import { AuditService } from '../audit/audit.service.js';
import { TenancyService } from '../tenancy/tenancy.service.js';
import { AUTH_PROVIDER, type AuthProvider, type ProviderProfile } from './auth-provider.js';
import { isClerkTestIdentity } from './clerk-auth-provider.js';

const scryptAsync = promisify(scrypt) as (
  password: Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const E164 = /^\+[1-9][0-9]{7,14}$/;

/** Six digits, not all the same, not a straight run up or down. */
export function isAcceptablePin(pin: string): boolean {
  if (!/^[0-9]{6}$/.test(pin)) return false;
  const digits = Array.from({ length: pin.length }, (_, index) => Number(pin.charAt(index)));
  const steps = digits.slice(1).map((digit, index) => digit - (digits[index] ?? 0));
  return !steps.every((step) => step === steps[0] && Math.abs(step) <= 1);
}

/** A user as the identity provider describes them in a webhook. */
export interface ProviderUser extends ProviderProfile {
  readonly subject: string;
  /** The provider's last-updated time for the user; an older event never overwrites a newer one. */
  readonly updatedAt: number;
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
   * Verifies a request token and resolves it to an AORA account, creating the
   * person and account the first time a user is seen. Webhooks keep the copy
   * fresh but cannot be relied on to arrive first (ADR 0019).
   */
  async authenticate(token: string): Promise<SessionContext | null> {
    const verified = await this.provider.authenticate(token);
    if (!verified) return null;

    let account = await this.db.asPlatform((tx) =>
      tx.user_account.findUnique({ where: { clerk_user_id: verified.subject } }),
    );
    if (!account) {
      const profile = await this.provider.fetchProfile(verified.subject);
      if (this.config.deployed && isClerkTestIdentity(profile?.email)) return null;
      await this.upsertFromProvider({
        subject: verified.subject,
        updatedAt: 0,
        email: profile?.email ?? null,
        phoneE164: profile?.phoneE164 ?? null,
        displayName: profile?.displayName ?? null,
      });
      account = await this.db.asPlatform((tx) =>
        tx.user_account.findUnique({ where: { clerk_user_id: verified.subject } }),
      );
    }
    if (!account || account.status !== 'active') return null;
    // Clerk's test mode accepts a fixed code for these addresses; never on a deployed environment.
    if (this.config.deployed && isClerkTestIdentity(account.email)) return null;

    const accountId = account.id;
    return this.db.asPlatform(async (tx) => {
      const stepUp = await tx.step_up.findUnique({ where: { session_ref: verified.sessionId } });
      return {
        sessionId: verified.sessionId,
        accountId,
        isPlatformOperator: account.is_platform_operator,
        stepUpUntil: stepUp?.account_id === accountId ? stepUp.until : null,
        firstFactorAgeMinutes: verified.firstFactorAgeMinutes,
        memberships: await this.tenancy.membershipsOf(tx, accountId),
      };
    });
  }

  /**
   * Creates or updates AORA's copy of a provider user. Idempotent and safe
   * under concurrency: the unique provider id decides, and an event older than
   * what is stored changes nothing. Only email, phone and name are taken;
   * provider metadata is never read.
   */
  async upsertFromProvider(user: ProviderUser): Promise<void> {
    if (this.config.deployed && isClerkTestIdentity(user.email)) return;
    // The phone number is NOT taken from the provider: AORA holds it as the
    // financial identity, and the user sets it through `setPhone`. A provider
    // update therefore never touches it.
    await this.db.asPlatform(async (tx) => {
      const inserted = await tx.$queryRaw<{ id: string }[]>`
        with new_person as (
          insert into identity.person default values returning id
        )
        insert into identity.user_account
          (person_id, clerk_user_id, email, display_name, provider_updated_at)
        select id, ${user.subject}, ${user.email}, ${user.displayName}, ${user.updatedAt}
        from new_person
        on conflict (clerk_user_id) do nothing
        returning id`;
      if (inserted[0]) {
        await this.audit.record(tx, {
          actorKind: 'system',
          action: 'identity.account.created',
          subjectType: 'user_account',
          subjectId: inserted[0].id,
          outcome: 'success',
        });
        return;
      }
      await tx.$executeRaw`
        update identity.user_account
        set email = ${user.email},
            display_name = ${user.displayName},
            provider_updated_at = ${user.updatedAt}
        where clerk_user_id = ${user.subject} and status = 'active'
          and provider_updated_at <= ${user.updatedAt} and ${user.updatedAt} > 0`;
    });
  }

  /**
   * Sets the account's phone number: its payment identifier and financial
   * identity (brief §2.1). It is stored unverified (open question O-11). A
   * number belongs to one account; a second claim is refused and recorded.
   * Replacing an existing number is a sensitive change and needs a step-up.
   */
  async setPhone(
    session: SessionContext,
    phoneE164: string,
    requestId: string,
  ): Promise<{ phone_hint: string; phone_verified: boolean }> {
    if (!E164.test(phoneE164)) {
      throw new AppError(
        'invalid_request',
        'Enter the phone number in international format, for example +254712345678.',
      );
    }
    return this.db
      .asPlatform(async (tx) => {
        await tx.$queryRaw`select id from identity.user_account where id = ${session.accountId}::uuid for update`;
        const account = await tx.user_account.findUniqueOrThrow({
          where: { id: session.accountId },
        });
        const changing = account.phone_e164 !== null && account.phone_e164 !== phoneE164;
        if (changing && (!session.stepUpUntil || session.stepUpUntil <= new Date())) {
          throw new AppError('step_up_required', 'Confirm this change with your PIN.');
        }
        if (account.phone_e164 !== phoneE164) {
          const holder = await tx.user_account.findUnique({ where: { phone_e164: phoneE164 } });
          if (holder) {
            // Recorded for an operator; the caller learns only that the number cannot be used.
            await this.audit.record(tx, {
              actorKind: 'user',
              actorAccountId: account.id,
              action: 'identity.phone.conflict',
              subjectType: 'user_account',
              subjectId: account.id,
              outcome: 'denied',
              requestId,
              detail: { held_by_account: holder.id },
            });
            return null;
          }
          await tx.user_account.update({
            where: { id: account.id },
            data: { phone_e164: phoneE164, phone_verified_at: null },
          });
          await this.audit.record(tx, {
            actorKind: 'user',
            actorAccountId: account.id,
            action: changing ? 'identity.phone.changed' : 'identity.phone.set',
            subjectType: 'user_account',
            subjectId: account.id,
            outcome: 'success',
            requestId,
          });
        }
        return { phone_hint: `•••${phoneE164.slice(-3)}`, phone_verified: false };
      })
      .then((result) => {
        if (!result) throw new AppError('conflict', 'This phone number cannot be used.');
        return result;
      });
  }

  /**
   * The user was deleted at the identity provider. Identity data is cleared and
   * access removed; **no ledger, payment, consent or audit record is touched**.
   * The person row stays so historic records still refer to someone (ADR 0019).
   */
  async closeFromProvider(subject: string): Promise<void> {
    await this.db.asPlatform(async (tx) => {
      const account = await tx.user_account.findUnique({ where: { clerk_user_id: subject } });
      if (!account) return;
      await tx.step_up.deleteMany({ where: { account_id: account.id } });
      await this.tenancy.removeAllMemberships(tx, account.id);
      await tx.user_account.update({
        where: { id: account.id },
        data: {
          status: 'closed',
          closed_at: new Date(),
          clerk_user_id: null,
          email: null,
          phone_e164: null,
          phone_verified_at: null,
          display_name: null,
          pin_hash: null,
          pin_set_at: null,
          pin_failed_attempts: 0,
          pin_locked_until: null,
        },
      });
      await this.audit.record(tx, {
        actorKind: 'provider',
        action: 'identity.account.closed',
        subjectType: 'user_account',
        subjectId: account.id,
        outcome: 'success',
        detail: { reason: 'deleted_at_identity_provider' },
      });
    });
  }

  /**
   * Sets or changes the PIN. The session's sign-in factor must have been
   * verified recently, so a stolen idle session cannot set a PIN, and a
   * forgotten or locked PIN can be replaced by signing in again.
   */
  async setPin(session: SessionContext, pin: string, requestId: string): Promise<void> {
    const age = session.firstFactorAgeMinutes;
    if (age === null || age > this.config.auth.pinSetupMaxFactorAgeMinutes) {
      throw new AppError(
        'reverification_required',
        'Confirm it is you by signing in again before setting a PIN.',
      );
    }
    if (!isAcceptablePin(pin)) {
      throw new AppError(
        'invalid_request',
        'Choose a 6-digit PIN that is not a repeated digit or a simple sequence.',
      );
    }
    const pinHash = await this.hashPin(pin, randomBytes(16));
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
      // A new PIN invalidates every step-up granted with the old one.
      await tx.step_up.deleteMany({ where: { account_id: session.accountId } });
      await this.pinAudit(tx, session, 'set', 'success', requestId);
    });
  }

  /** Confirms a sensitive action with the PIN and marks this provider session as stepped-up. */
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
      if (stored.length === given.length && timingSafeEqual(stored, given)) {
        const until = new Date(now.getTime() + this.config.auth.stepUpTtlSeconds * 1000);
        await tx.user_account.update({
          where: { id: current.id },
          data: { pin_failed_attempts: 0, pin_locked_until: null },
        });
        await tx.step_up.upsert({
          where: { session_ref: session.sessionId },
          create: { session_ref: session.sessionId, account_id: current.id, until },
          update: { account_id: current.id, until },
        });
        await this.pinAudit(tx, session, 'verified', 'success', requestId);
        return until;
      }

      // An expired lock starts a fresh count.
      const attempts = (current.pin_locked_until ? 0 : current.pin_failed_attempts) + 1;
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

  /** scrypt over an HMAC with a server-side pepper, so a database leak alone cannot test PINs. */
  private async hashPin(pin: string, salt: Buffer): Promise<string> {
    const peppered = createHmac('sha256', this.config.pinPepper).update(pin).digest();
    const derived = await scryptAsync(peppered, salt, 32, SCRYPT);
    return `scrypt$15$${salt.toString('hex')}$${derived.toString('hex')}`;
  }

  private pinAudit(
    tx: Tx,
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
}
