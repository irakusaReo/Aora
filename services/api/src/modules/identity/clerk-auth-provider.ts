import { createClerkClient, verifyToken } from '@clerk/backend';
import type { AppConfig } from '../../platform/config.js';
import type { AuthenticatedToken, AuthProvider, ProviderProfile } from './auth-provider.js';

/**
 * Clerk's test mode lets any `+clerk_test` address sign in with a fixed code.
 * Such identities are refused on a deployed environment, whatever the Clerk
 * instance's own setting is (ADR 0019).
 */
export function isClerkTestIdentity(email: string | null | undefined): boolean {
  return typeof email === 'string' && /\+clerk_test@/i.test(email);
}

/**
 * Verifies Clerk session tokens (ADR 0019). With the instance's public key
 * configured, verification makes no network call. Nothing is ever written to
 * Clerk, and nothing about roles or tenants is ever read from it.
 */
export class ClerkAuthProvider implements AuthProvider {
  readonly name = 'clerk';

  constructor(private readonly config: AppConfig) {
    if (!config.clerk.secretKey)
      throw new Error('Invalid or missing configuration: CLERK_SECRET_KEY');
  }

  async authenticate(token: string): Promise<AuthenticatedToken | null> {
    try {
      const { clerk } = this.config;
      const claims = await verifyToken(
        token,
        clerk.jwtKey ? { jwtKey: clerk.jwtKey } : { secretKey: clerk.secretKey ?? '' },
      );
      // Origin check (the `azp` claim). A token issued to a browser always names
      // the origin that asked for it, and that origin must be one of ours. A token
      // with no `azp` did not come from a browser: it was issued to a native app or
      // by Clerk's Backend API, and the claim cannot be removed without breaking the
      // signature. Clerk's own option rejects those, so the check is done here.
      const azp = (claims as { azp?: unknown }).azp;
      if (
        azp !== undefined &&
        (typeof azp !== 'string' || !clerk.authorizedParties.includes(azp))
      ) {
        return null;
      }
      const sessionId = (claims as { sid?: unknown }).sid;
      if (typeof claims.sub !== 'string' || typeof sessionId !== 'string' || sessionId === '') {
        return null;
      }
      // fva: minutes since the first and second factors were verified; -1 means never.
      const fva = (claims as { fva?: unknown }).fva;
      const first = Array.isArray(fva) && typeof fva[0] === 'number' ? fva[0] : -1;
      return {
        subject: claims.sub,
        sessionId,
        firstFactorAgeMinutes: first >= 0 ? first : null,
      };
    } catch {
      // Any verification failure is simply "not authenticated". The reason is not logged:
      // it can quote the token.
      return null;
    }
  }

  async fetchProfile(subject: string): Promise<ProviderProfile | null> {
    const client = createClerkClient({ secretKey: this.config.clerk.secretKey ?? '' });
    try {
      const user = await client.users.getUser(subject);
      const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
      return {
        email: user.primaryEmailAddress?.emailAddress ?? null,
        phoneE164: user.primaryPhoneNumber?.phoneNumber ?? null,
        displayName: name === '' ? null : name,
      };
    } catch {
      return null;
    }
  }
}
