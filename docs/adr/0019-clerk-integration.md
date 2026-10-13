# ADR 0019 — Clerk integration

- **Status:** Accepted (owner ruling, 2026-10-13). Clerk facts verified against Clerk's documentation on 2026-10-13; sources at the end as [C1]…[C9]. Points the documentation did not answer are marked "not verified" and are confirmed against a real development instance in checkpoint 2E.
- **Supersedes:** the one-time-code, SMS-sender and session parts of Phase 2 checkpoint 2C. Decides [ADR 0011](0011-production-authentication.md) (managed provider).
- **Related:** ADR 0002, 0013, 0016, 0020; brief §2.1 amendment, §7; CLAUDE.md rules 8–12; open questions O-11, O-12

## Division of responsibility

| Clerk | AORA |
|---|---|
| Proving who is signing in: email code, sessions, session tokens | Everything about what that person may do |
| The user's account profile: email, phone, name | Persons, businesses, workspaces, memberships, roles, permissions |
| Sign-in and account UI components in web and mobile apps | Consent records, audit, tenant context for row-level security |
| | Transaction PIN and step-up policy |
| | Ledger and every financial record |

**Clerk Organizations and Clerk roles are not used as an authority for anything.** Tenant access and permissions are decided only by AORA's database, server-side. Organizations could later drive a workspace switcher in the UI; that is a presentation convenience, not adopted now, and would still be backed by AORA's memberships.

**Data minimisation.** Clerk holds only email, phone and name. Nothing else is ever written to Clerk, including its public, private or unsafe metadata: no KYC or KYB data, no financial or credit data, no roles, permissions or workspace identifiers. A test asserts the code never writes Clerk metadata.

## Decision

### Verifying requests

- Clients send the Clerk **session token** as a bearer token. The API verifies it on every request with `verifyToken()` from `@clerk/backend` [C1][C2]: signature, expiry and not-before, and the `azp` claim against an explicit list of AORA's own origins (`authorizedParties`) [C2].
- Verification is **networkless** when the instance's PEM public key is supplied as `CLERK_JWT_KEY`; otherwise the JWKS is fetched from Clerk [C1]. AORA sets `CLERK_JWT_KEY` on deployed environments so a Clerk outage does not stop already-signed-in users, and because a function should not make a network call per request.
- A session token lives about 60 seconds and is refreshed by Clerk's SDK [C3]; the API never stores it.
- This sits behind the existing `AuthProvider` interface, reshaped from "issue and check a code" to **"authenticate a request token"**: it returns the provider's user id, session id and factor-verification ages, or nothing. `ClerkAuthProvider` is the deployed implementation.

### Mapping to AORA persons

- `identity.user_account` gains `clerk_user_id` (unique). `person` remains AORA's record.
- **Just-in-time provisioning:** on the first authenticated request from an unknown Clerk user, AORA creates the person and account in one idempotent transaction, then fetches email, phone and name from Clerk's Backend API. Webhooks alone are not enough: Clerk says deliveries "are not guaranteed", can arrive late, out of order or more than once, and that syncing is "eventually consistent" [C4].
- **Webhook sync** (`user.created`, `user.updated`, `user.deleted`) keeps the copy fresh. Signatures are verified with `verifyWebhook()` and `CLERK_WEBHOOK_SIGNING_SECRET` [C4]. Processing is idempotent: each delivery's identifier is stored and a repeat is acknowledged without effect; an update older than the stored one is ignored.
- AORA's copy of email and phone exists so that notifications and payments work without calling Clerk; Clerk remains the place a user changes them.

### Phone numbers

Sign-in is by email code. The phone number is still required as the payment identifier and financial identity (brief §2.1), and is **not treated as verified merely because it is in the profile**. How it is verified for the MVP is open question O-11. Until decided, an account's phone is marked unverified, and no money is sent to a number that has not been confirmed.

### User deletion

When Clerk reports `user.deleted`:

- **No ledger, payment, consent or audit record is deleted or altered.** Financial records must stay complete and auditable (brief §8, §16).
- The account is marked `closed`, its Clerk link, email, phone and PIN are cleared, its memberships are set to `removed` (the last-admin rule still applies; a sole admin's workspace is flagged for an operator), and every step-up is revoked.
- The `person` row and its identifier remain, so historic records still point at "a person" who can no longer be contacted or identified from the identity tables.
- This is anonymisation of identity data, not erasure of financial history. The retention period for financial records, and how it squares with data-protection erasure rights in Kenya, is for counsel (O-12). The rule is documented in `security-and-tenancy.md`.

### Step-up

- **AORA's transaction PIN stays** and is bound to the Clerk session: a successful PIN marks that Clerk session id as stepped-up for a few minutes.
- **Setting or changing the PIN requires a fresh first-factor verification**, read from the session token's `fva` claim (minutes since each factor was last verified) [C5]. This replaces the Phase 2 rule "needs a fresh one-time code" with the same guarantee: a stolen, idle session cannot set a PIN.
- **Clerk reverification, recommendation: use it for PIN setup and PIN reset only, not as a second gate on payments.** Reverification makes the user re-enter their sign-in factor within a window of 1 to 10 minutes [C5]. That is exactly the proof wanted before a PIN change. Adding it on top of the PIN for payouts would mean two prompts for one action, on an email round trip that is slow on a poor connection. The PIN is the transaction factor; reverification protects the PIN.

### Environments and keys

- **Development-instance keys only** (`pk_test_…`, `sk_test_…`). Configuration refuses a key that starts `pk_live_` or `sk_live_` (CLAUDE.md rule 10). The exact prefixes are confirmed against the real keys in 2E.
- A development instance is the documented way to run on a host's preview domain such as `*.vercel.app`; production keys cannot be used there [C6]. So staging at `aora-api.vercel.app` and Vercel previews both use the development instance.
- Limits of a development instance to keep in mind: capped at 100 users, emails prefixed with the environment name, a more relaxed security posture [C6].

### Test mode: the new "000000" rule

Clerk development instances have **test mode on by default**: any `+clerk_test` email address or fictional phone number signs in with the fixed code `424242`, and no message is sent [C7]. Test mode can be turned off on the instance's settings page [C7].

- **It must be off on the staging instance.** That is a dashboard setting, so it is a step in `clerk-setup.md`.
- A dashboard setting is not a control AORA can prove, so the API also enforces it: **on a deployed environment, a session whose user has a `+clerk_test` email address is refused**, whatever the instance setting says. A test proves it. Whether the API can also read the instance's test-mode flag at startup is not verified; if it can, a startup check is added in 2E.
- **Local development and CI do not use Clerk at all** for automated tests. They use the sandbox authenticator, which mints signed test tokens in-process and is refused on any deployed environment by the same guard as before (no Vercel variable, local databases only). Clerk's Testing Tokens exist to get browser tests past bot protection [C8]; they become relevant with the web apps' end-to-end tests in Phase 3, against a separate development instance.

### Clients

Web apps use Clerk's Next.js SDK; Expo apps use Clerk's Expo SDK with the session token kept in secure storage (ADR 0016) [C9]. They pass the session token to the API and render AORA's permissions; they never make an authorization decision.

## What is removed

AORA's own one-time-code generation, `auth_challenge` and `session` tables' use, the simulated SMS sender, the simulated SMS inbox route and `SANDBOX_SMS_INBOX_TOKEN`, the sign-in rate limits (Clerk rate-limits sign-in), and the `/v1/auth/challenges`, `/v1/auth/sessions`, `/v1/auth/pin/challenges` and sign-out endpoints.

## Alternatives considered

- **Clerk Organizations as the tenant model:** puts authorization data in a third party and outside row-level security.
- **Trusting webhooks alone for user creation:** races on first sign-in [C4].
- **Fetching the JWKS on every request:** a network dependency per request.
- **Dropping the PIN for Clerk reverification:** an email code is a sign-in factor, not a transaction factor, and is slow on poor connections.

## Consequences

- Sign-in, recovery and account security become Clerk's, with Clerk's uptime and pricing. `AuthProvider` keeps the exit open.
- Personal data (email, phone, name) is processed by Clerk outside Kenya: open question O-12, to be reviewed by counsel before any pilot.
- A development instance caps staging at 100 users.
- The route × role matrix and journey J2 now run with Clerk-shaped identities.

## Sources (read 2026-10-13)

- [C1] Clerk, "verifyToken()" — https://clerk.com/docs/reference/backend/verify-token
- [C2] Clerk, "Manual JWT verification" — https://clerk.com/docs/guides/sessions/manual-jwt-verification
- [C3] Clerk, "Session tokens" — https://clerk.com/docs/guides/sessions/session-tokens
- [C4] Clerk, "Sync Clerk data to your app with webhooks" — https://clerk.com/docs/guides/development/webhooks/syncing
- [C5] Clerk, "Add reverification for sensitive actions" — https://clerk.com/docs/guides/secure/reverification
- [C6] Clerk, "Managing environments" — https://clerk.com/docs/guides/development/managing-environments
- [C7] Clerk, "Test emails and phones" — https://clerk.com/docs/guides/development/testing/test-emails-and-phones
- [C8] Clerk, "Testing with Clerk" — https://clerk.com/docs/guides/development/testing/overview
- [C9] Clerk quickstarts — https://clerk.com/docs/nextjs/getting-started/quickstart and https://clerk.com/docs/expo/getting-started/quickstart
