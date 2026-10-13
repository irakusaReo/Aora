# AORA — Security and Tenancy

State after Phase 2 checkpoints 2A to 2F as built. Sandbox only. Clerk and Resend are implemented and tested against local stand-ins; they have **not yet run against a real Clerk instance or Resend account**, which waits for the owner's credentials.

## Tenancy

The tenant is the workspace (`tenancy.workspace`). Every tenant-owned row carries `tenant_id`.

Isolation has two independent layers.

**1. Application.** `WorkspaceGuard` reads the `Aora-Workspace-Id` header and requires the caller to be a member with a role the route allows. "No such workspace" and "not a member" give the same 403.

**2. Database (row-level security).** Three roles, created by `prisma/bootstrap.sql`:

| Role | Used for | Sees |
|---|---|---|
| `aora_owner` | Migrations only | Nothing through RLS: tables use `FORCE ROW LEVEL SECURITY`, so even the owner is bound, except where a trigger policy grants it |
| `aora_app` | A signed-in user's request | Only rows whose `tenant_id` equals the transaction's `app.tenant_id` setting. With no setting: nothing |
| `aora_platform` | Sign-in, worker, webhook intake, reconciliation, operator endpoints | Everything, through explicit policies |

`Database.withTenant(tenantId, …)` is the only way to get an `aora_app` connection. It opens a transaction and sets `app.tenant_id` with transaction scope, so the setting cannot leak to the next user of the pooled connection (tested).

What `aora_app` may do:

| Schema | Rights |
|---|---|
| `identity`, `business`, `sim` | None |
| `tenancy` | Read own workspace and memberships |
| `audit` | Read and insert own tenant's events |
| `ledger` | Read own accounts, entries, postings, balances. No writes |
| `outbox` | Insert events for own tenant. No reads |
| `payments` | Read own intents; insert an intent in status `created`. No access to webhooks or reconciliation |

A test asserts that every table with a `tenant_id` column has row-level security enabled and forced.

## Authentication (ADR 0019)

- **Clerk authenticates; AORA authorizes.** Clients send Clerk's session token as a bearer token. The API verifies it on every request (signature, expiry, not-before, and the `azp` origin against an explicit allow-list), without a network call when the instance's public key is configured. The token is never stored.
- **AORA's database is the only authority** for persons, workspaces, memberships, roles, permissions, consent and row-level-security context. Clerk Organizations, Clerk roles and Clerk metadata are not read for any decision, and nothing is ever written to Clerk.
- **Accounts are linked by Clerk user id.** The first authenticated request from an unknown user creates the person and account in one idempotent statement (safe under concurrent requests and against a racing webhook), with email and name fetched from Clerk. Webhooks (`user.created`, `user.updated`, `user.deleted`) keep the copy fresh: Svix signatures are verified on the raw body, a delivery is handled once, and an update older than the stored one is ignored.
- **A new user has no access to anything** until an AORA membership exists.
- **Phone numbers are held by AORA, not Clerk.** The user sets theirs through `PUT /v1/me/phone`; it is the payment identifier and financial identity, stored **unverified** (open question O-11). A number belongs to one account: a second claim is refused and audited, without revealing who holds it. Replacing a number needs a PIN step-up and clears any verification. Provider sync never touches it.
- **Only test keys.** Configuration refuses a `pk_live_` or `sk_live_` key and names the variable, never the value.
- **No fixed code on a deployed environment:**
  - The **sandbox authenticator** (tests and local work) mints its own tokens. It refuses to be constructed, and configuration refuses to select it, unless no Vercel system variable is present **and** both database URLs point at this machine. Tokens from one instance are not accepted by another.
  - **Clerk's test mode** lets `+clerk_test` addresses sign in with a fixed code. It is turned off on the staging instance, and independently the API **refuses any `+clerk_test` user on a deployed environment**, at first sight and on every request.
  - Both are tested (`deployed-guard.test.ts`, `identity-sync.test.ts`). Neither is a flag.

### User deletion

When Clerk reports a user deleted, the account is marked closed; its Clerk link, email, phone, name and PIN are cleared; step-ups are revoked; and its memberships are removed (a workspace's last admin is left for an operator, because a workspace must keep one). **No ledger, payment, consent or audit record is deleted or changed**, and the person row remains so those records still refer to someone. This is anonymisation of identity data, not erasure of financial history; the retention period and its fit with erasure rights are for counsel (O-12).

## Transaction PIN and step-up

- A six-digit PIN; repeated digits and straight runs are refused. Stored as scrypt over an HMAC with a server-side pepper (`PIN_PEPPER`) and a per-account salt. Never logged, never in audit detail.
- **Setting or changing a PIN requires a recently verified sign-in factor**, read from the session token's factor-verification age. An idle or stolen session cannot set a PIN; a forgotten or locked PIN is replaced by confirming sign-in again (Clerk reverification). A new PIN revokes every existing step-up.
- Wrong PINs are counted under a row lock; at the limit the PIN locks for a period, during which even the correct PIN is refused. PIN attempts are also rate-limited per account.
- A correct PIN marks **that Clerk session** (by session id, so it survives token refresh) as stepped-up for five minutes. Another session of the same user is not stepped-up.
- Step-up protects adding a member, changing a role and removing a member (brief §7.2).

## Notifications and email (ADR 0020)

- Business code calls the notifications module; only its Resend adapter knows the provider. A notification is created in the same transaction as its cause, delivered through the outbox, and sent once per reason: a unique deduplication key in AORA, and the notification id as Resend's idempotency key.
- **Sign-in emails** that Clerk hands over are sent immediately and **stored nowhere**: no notification row, outbox payload, audit event or log line contains the code. A test checks each.
- Emails carry a sandbox banner and a `[SANDBOX]` subject, mask addresses and phone numbers, and contain no link or code that authorises an action (the sign-in code is the one exception, by nature).
- The recipient address is read from the account at send time; the notification row keeps only a masked form.
- Delivery status comes from Resend's signed webhooks, handled once per delivery; a later "sent" never overwrites a bounce.
- A person can list what AORA sent them (`GET /v1/notifications`), and nobody else's.

## Authorization

- Default deny. Routes name a **permission**, never a role; one table (`tenancy/permissions.ts`) maps permissions to roles. A workspace route with no permission admits nobody.

  | Permission | admin | finance | cashier |
  |---|---|---|---|
  | `payment_intent.create`, `payment_intent.read` | ✓ | ✓ | ✓ |
  | `ledger.read`, `member.read` | ✓ | ✓ | – |
  | `member.manage` (with step-up) | ✓ | – | – |

- `test/permissions.test.ts` holds the route × role matrix by hand and fails if a route, a permission or a step-up requirement changes without it. It also pins the list of routes that need no authentication.
- A removed member loses access on their next request. A workspace always keeps one active admin: the database refuses otherwise.
- Operator endpoints require the platform-operator flag. Cron routes require the cron secret; nothing else may call them. Provider webhook routes are authenticated by signature.
- Membership of a workspace grants nothing beyond the listed permissions.

## Rate limiting

Fixed-window counters in PostgreSQL (`ops.rate_limit`), one atomic upsert per check, so every serverless instance counts against the same store. Keys are stored only as SHA-256 digests. AORA limits PIN attempts per account; sign-in attempts are rate-limited by Clerk.

## Consent

`consent.terms_document` holds versioned, immutable terms; `consent.consent_record` is append-only and names the person, the capacity (personal or on behalf of a business), the action, the time and the exact terms version (brief §7.4). Consent must name the version in effect. Business capacity requires membership of the workspace.

## Connection pooling

The runtime connection on Neon is PgBouncer in transaction mode. The application sets **no session state**: the tenant and the time zone are set with transaction scope as the first statement of every transaction. `test/pooler.test.ts` runs isolation, clock and payment tests through a local PgBouncer with a single server connection, so consecutive transactions of different tenants share a backend. `pnpm neon:verify` repeats the essential checks against the real pooler. No AORA role is a superuser or can bypass row-level security, on any environment.

## Secrets

- None in code, migrations, database rows or logs. `bootstrap.sql` sets no passwords.
- Configuration comes from the environment (`.env.local` locally, git-ignored). `.env.example` holds placeholders only, checked by a test.
- A configuration error names the variable, never its value.
- Secrets so far: `SANDBOX_SIM_WEBHOOK_SECRET`, `PIN_PEPPER`, `CRON_SECRET`, the database passwords, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SIGNING_SECRET`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`. Two also exist as GitHub Actions secrets: the staging cron secret and the staging migration connection string. On deployed environments they are Vercel environment variables marked sensitive.
- The migration (owner) connection string is never deployed: the running API cannot change the schema.

## Webhooks

- Authenticated by HMAC-SHA-256 over the raw request body, compared in constant time. An invalid signature is rejected, audited, and nothing is stored.
- The raw payload is stored byte for byte and can never be changed or deleted.
- Deduplicated on the provider's event id, so replays have no further effect.
- A webhook cannot make a payment succeed with a different amount: a mismatch goes to `reconciliation_required`.

## Audit

`audit.audit_event` is append-only (triggers reject update, delete and truncate). Events are written in the same transaction as the action. Recorded so far: session created, code rejected, step-up completed, payment intent created, every payment status change, webhook rejected, reconciliation run. Events never contain codes, tokens or phone numbers.

## Logging

Errors are logged by type and request id only; messages that could quote input, SQL or payloads are not logged. A test drives success and failure paths and asserts that logs contain no tokens, codes, secrets, phone numbers or connection strings.

## Sandbox labelling

Every tenant and financial table has `mode`, with a check that allows only `sandbox`. Every response has the header `Aora-Mode: sandbox`, and every JSON object body has `"mode": "sandbox"`. Configuration accepts no other mode.

## Not built yet, and known gaps

- **Clerk and Resend have not been exercised for real.** In particular the field names of Clerk's email event are assumed (`to_email_address`, `subject`, `body`, `body_plain`) and are confirmed with the first real event.
- Members are still invited by phone number, which creates an account with no sign-in. With email sign-in this should become an invitation by email; planned with onboarding in Phase 3.
- The tables Clerk made redundant (`identity.auth_challenge`, `identity.session`, `sim.sim_sms`) still exist and are dropped in a later release (expand, then contract).
- Merchants cannot yet see notifications sent to their workspace's members; a person sees only their own.
- Templates are plain functions with copy in a dictionary; React Email is adopted with the first rich templates (ADR 0020).
- Dependency and secret scanning in CI. Session binding to a device (now Clerk's concern).
- The local and CI databases use trust authentication, acceptable only because they are throwaway.
