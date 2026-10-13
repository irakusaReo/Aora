import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../../platform/config.js';

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

export type ChallengePurpose = 'sign_in' | 'step_up';

export const AUTH_PROVIDER = Symbol('AUTH_PROVIDER');

/**
 * SANDBOX ONLY. Accepts one fixed code and sends nothing. It exists so the
 * slice can prove sessions, roles and the step-up policy without an SMS
 * provider. It refuses to be constructed outside sandbox mode.
 */
export class SandboxAuthProvider implements AuthProvider {
  static readonly FIXED_CODE = '000000';
  readonly name = 'sandbox';

  constructor(config: AppConfig) {
    // The config type only admits 'sandbox'; this guards against a cast or a future widening.
    if ((config.mode as string) !== 'sandbox') {
      throw new Error('SandboxAuthProvider is forbidden outside sandbox mode.');
    }
  }

  startChallenge(): Promise<string> {
    const salt = randomBytes(16).toString('hex');
    return Promise.resolve(`${salt}:${digest(salt, SandboxAuthProvider.FIXED_CODE)}`);
  }

  verifyChallenge(input: { state: string; code: string }): Promise<boolean> {
    const [salt, expected] = input.state.split(':');
    if (!salt || !expected) return Promise.resolve(false);
    const actual = Buffer.from(digest(salt, input.code), 'hex');
    const wanted = Buffer.from(expected, 'hex');
    return Promise.resolve(actual.length === wanted.length && timingSafeEqual(actual, wanted));
  }
}

function digest(salt: string, code: string): string {
  return createHmac('sha256', salt).update(code).digest('hex');
}
