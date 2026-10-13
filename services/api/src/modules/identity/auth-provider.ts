import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../../platform/config.js';
import { fixedCodeAllowed } from '../../platform/deployment.js';

/**
 * Verifies that a person controls a phone number. Only credential verification
 * sits behind this interface; accounts, sessions, roles and the step-up policy
 * stay in AORA (ADR 0011).
 */
export interface AuthProvider {
  readonly name: string;
  /** Starts a challenge and returns opaque state to store with it. Never the code itself. */
  startChallenge(input: { phoneE164: string; purpose: ChallengePurpose }): Promise<string>;
  verifyChallenge(input: { state: string; code: string }): Promise<boolean>;
}

export type ChallengePurpose = 'sign_in' | 'pin_setup';

export const AUTH_PROVIDER = Symbol('AUTH_PROVIDER');

/**
 * DEVELOPMENT ONLY. Accepts one fixed code and sends nothing, so automated
 * tests and local work need no SMS. It refuses to exist anywhere but a
 * developer machine with a local database: the check below looks at the real
 * process environment and cannot be switched off by configuration.
 */
export class SandboxAuthProvider implements AuthProvider {
  static readonly FIXED_CODE = '000000';
  readonly name = 'fixed';

  constructor(config: AppConfig, env: Record<string, string | undefined> = process.env) {
    const local = fixedCodeAllowed({
      ...env,
      DATABASE_URL_APP: config.databaseUrlApp,
      DATABASE_URL_PLATFORM: config.databaseUrlPlatform,
    });
    if ((config.mode as string) !== 'sandbox' || config.deployed || !local) {
      throw new Error('The fixed sign-in code is forbidden outside a local development machine.');
    }
  }

  startChallenge(): Promise<string> {
    return Promise.resolve(sealCode(SandboxAuthProvider.FIXED_CODE));
  }

  verifyChallenge(input: { state: string; code: string }): Promise<boolean> {
    return Promise.resolve(codeMatches(input.state, input.code));
  }
}

/** Delivers a text message. Implementations: the simulated sender, and one per SMS provider. */
export interface SmsSender {
  readonly name: string;
  send(phoneE164: string, body: string): Promise<void>;
}

export const SMS_SENDER = Symbol('SMS_SENDER');

/**
 * Phone number plus a random one-time code delivered by SMS. The code exists
 * in memory only long enough to be sent; what is stored is a salted HMAC.
 */
export class OtpAuthProvider implements AuthProvider {
  readonly name = 'otp';

  constructor(private readonly sms: SmsSender) {}

  async startChallenge(input: { phoneE164: string; purpose: ChallengePurpose }): Promise<string> {
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const what = input.purpose === 'sign_in' ? 'sign-in' : 'PIN';
    await this.sms.send(
      input.phoneE164,
      `AORA SANDBOX: your ${what} code is ${code}. It expires in 5 minutes. Never share it.`,
    );
    return sealCode(code);
  }

  verifyChallenge(input: { state: string; code: string }): Promise<boolean> {
    return Promise.resolve(codeMatches(input.state, input.code));
  }
}

function sealCode(code: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${digest(salt, code)}`;
}

function codeMatches(state: string, code: string): boolean {
  const [salt, expected] = state.split(':');
  if (!salt || !expected) return false;
  const actual = Buffer.from(digest(salt, code), 'hex');
  const wanted = Buffer.from(expected, 'hex');
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function digest(salt: string, code: string): string {
  return createHmac('sha256', salt).update(code).digest('hex');
}
