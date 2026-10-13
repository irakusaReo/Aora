import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../../platform/config.js';
import { sandboxAuthAllowed } from '../../platform/deployment.js';

/** What a verified request token says. Nothing about roles or tenants: those are AORA's alone. */
export interface AuthenticatedToken {
  /** The identity provider's id for the user. */
  readonly subject: string;
  /** The provider's session id. Step-ups are bound to it. */
  readonly sessionId: string;
  /** Minutes since the sign-in factor was last verified on this session, or null if unknown. */
  readonly firstFactorAgeMinutes: number | null;
}

export interface ProviderProfile {
  readonly email: string | null;
  readonly phoneE164: string | null;
  readonly displayName: string | null;
}

/**
 * Proves who is calling. Only authentication sits behind this interface;
 * persons, tenants, roles, permissions, consent and the step-up policy stay in
 * AORA (ADR 0019).
 */
export interface AuthProvider {
  readonly name: string;
  /** Verifies a request token. Returns null for anything that is not a valid, current token. */
  authenticate(token: string): Promise<AuthenticatedToken | null>;
  /** The user's contact profile, for the first time AORA meets them. */
  fetchProfile(subject: string): Promise<ProviderProfile | null>;
}

export const AUTH_PROVIDER = Symbol('AUTH_PROVIDER');

/**
 * TESTS AND LOCAL WORK ONLY. Mints and verifies its own signed tokens so
 * automated tests need no identity provider. It refuses to exist anywhere but
 * a developer machine with a local database: the check looks at the real
 * process environment and cannot be switched off by configuration.
 */
export class SandboxAuthProvider implements AuthProvider {
  readonly name = 'sandbox';
  private readonly secret = randomBytes(32);
  private readonly profiles = new Map<string, ProviderProfile>();

  constructor(config: AppConfig, env: Record<string, string | undefined> = process.env) {
    const local = sandboxAuthAllowed({
      ...env,
      DATABASE_URL_APP: config.databaseUrlApp,
      DATABASE_URL_PLATFORM: config.databaseUrlPlatform,
    });
    if ((config.mode as string) !== 'sandbox' || config.deployed || !local) {
      throw new Error(
        'The sandbox authenticator is forbidden outside a local development machine.',
      );
    }
  }

  issue(
    subject: string,
    options: {
      sessionId?: string;
      firstFactorAgeMinutes?: number | null;
      expiresInSeconds?: number;
    } = {},
  ): string {
    const body = Buffer.from(
      JSON.stringify({
        sub: subject,
        sid: options.sessionId ?? `sess_${randomUUID()}`,
        fva: options.firstFactorAgeMinutes === undefined ? 0 : options.firstFactorAgeMinutes,
        exp: Date.now() + (options.expiresInSeconds ?? 3600) * 1000,
        jti: randomUUID(),
      }),
    ).toString('base64url');
    return `sbx.${body}.${this.sign(body)}`;
  }

  setProfile(subject: string, profile: ProviderProfile): void {
    this.profiles.set(subject, profile);
  }

  authenticate(token: string): Promise<AuthenticatedToken | null> {
    const [prefix, body, signature] = token.split('.');
    if (prefix !== 'sbx' || !body || !signature) return Promise.resolve(null);
    const expected = Buffer.from(this.sign(body));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      return Promise.resolve(null);
    }
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as {
      sub: string;
      sid: string;
      fva: number | null;
      exp: number;
    };
    if (claims.exp <= Date.now()) return Promise.resolve(null);
    return Promise.resolve({
      subject: claims.sub,
      sessionId: claims.sid,
      firstFactorAgeMinutes: claims.fva,
    });
  }

  fetchProfile(subject: string): Promise<ProviderProfile | null> {
    return Promise.resolve(this.profiles.get(subject) ?? null);
  }

  private sign(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url');
  }
}
