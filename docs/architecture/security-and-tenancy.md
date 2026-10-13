# AORA — Security and Tenancy

State after Phase 2 checkpoints 2A, 2C and 2D. Sandbox only. Deployment (2B) and the real SMS adapter (2E) are not done yet; where that matters it is said.

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

## Authentication

- **Sign-in is a phone number plus a random six-digit one-time code**, behind the `AuthProvider` interface. The code is generated per challenge, exists in memory only long enough to be sent, and is stored as a salted HMAC. Challenges expire, are single-use, lock after repeated wrong codes, and the endpoint answers the same way for registered and unregistered numbers.
- **Delivery:** through an `SmsSender`. Until the Africa's Talking sandbox is connected (2E), the **simulated sender** stores messages in `sim.sim_sms`. On a deployed environment an operator can read them only through `/v1/internal/sandbox/sms` with the `SANDBOX_SMS_INBOX_TOKEN` secret; with no token configured the route returns 404. This is a sandbox stop-gap and is removed once SMS works.
- **The fixed code `000000` cannot run on a deployed environment.** `SandboxAuthProvider` refuses to be constructed, and configuration refuses to load with `AUTH_PROVIDER=fixed`, unless no Vercel system variable is present **and** both database URLs point at this machine. The rule is derived from where the process runs and what it talks to; it is not a flag. `test/deployed-guard.test.ts` covers each condition. The default provider is the one-time code.
- Session tokens are 256 random bits, returned once, stored only as a SHA-256 hash, with expiry, revocation and sign-out.
- Production choice of authentication: [ADR 0011](../adr/0011-production-authentication.md), still pending.

## Transaction PIN and step-up

- A six-digit PIN; repeated digits and straight runs are refused.
- Stored as scrypt over an HMAC with a server-side pepper (`PIN_PEPPER`) and a per-account salt. A database leak alone cannot test PINs. Never logged, never in audit detail.
- **Setting or changing a PIN always needs a fresh one-time code**, so a stolen session cannot set one and a forgotten PIN can be replaced.
- Wrong PINs are counted under a row lock; at the limit the PIN locks for a period, during which even the correct PIN is refused. Resetting with a one-time code clears the lock.
- A correct PIN marks **that session** as stepped-up for five minutes. `StepUpGuard` requires it.
- **Step-up now protects real endpoints:** adding a member, changing a role and removing a member (brief §7.2).

## Authorization

- Default deny. Routes name a **permission**, never a role; one table (`tenancy/permissions.ts`) maps permissions to roles. A workspace route with no permission admits nobody.

  | Permission | admin | finance | cashier |
  |---|---|---|---|
  | `payment_intent.create`, `payment_intent.read` | ✓ | ✓ | ✓ |
  | `ledger.read`, `member.read` | ✓ | ✓ | – |
  | `member.manage` (with step-up) | ✓ | – | – |

- `test/permissions.test.ts` holds the route × role matrix by hand and fails if a route, a permission or a step-up requirement changes without it. It also pins the list of routes that need no authentication.
- A removed member loses access on their next request. A workspace always keeps one active admin: the database refuses otherwise.
- Operator endpoints require the platform-operator flag. Cron routes require the cron secret; nothing else may call them.
- Membership of a workspace grants nothing beyond the listed permissions.

## Rate limiting

Fixed-window counters in PostgreSQL (`ops.rate_limit`), one atomic upsert per check, so every serverless instance counts against the same store. Keys (phone number, client address, account) are stored only as SHA-256 digests. Limits are configuration: sign-in start per phone and per address, code verification per address, PIN step-up and PIN code requests per account. A test runs concurrent requests across two application instances and checks that exactly the limit succeeds.

## Consent

`consent.terms_document` holds versioned, immutable terms; `consent.consent_record` is append-only and names the person, the capacity (personal or on behalf of a business), the action, the time and the exact terms version (brief §7.4). Consent must name the version in effect. Business capacity requires membership of the workspace.

## Connection pooling

The runtime connection on Neon is PgBouncer in transaction mode. The application sets **no session state**: the tenant and the time zone are set with transaction scope as the first statement of every transaction. `test/pooler.test.ts` runs isolation, clock and payment tests through a local PgBouncer with a single server connection, so consecutive transactions of different tenants share a backend. `pnpm neon:verify` repeats the essential checks against the real pooler. No AORA role is a superuser or can bypass row-level security, on any environment.

## Secrets

- None in code, migrations, database rows or logs. `bootstrap.sql` sets no passwords.
- Configuration comes from the environment (`.env.local` locally, git-ignored). `.env.example` holds placeholders only, checked by a test.
- A configuration error names the variable, never its value.
- Secrets so far: `SANDBOX_SIM_WEBHOOK_SECRET`, `PIN_PEPPER`, `CRON_SECRET`, `SANDBOX_SMS_INBOX_TOKEN`, the database passwords, and later the SMS API key. On deployed environments they are Vercel environment variables marked sensitive.
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

- Nothing is deployed yet, so TLS, encryption at rest, backups and the behaviour of the platform's forwarded client address are unverified.
- The Africa's Talking adapter (2E). Until then one-time codes go to the simulated sender.
- Session binding to a device.
- Dependency and secret scanning in CI.
- The local and CI databases use trust authentication. That is acceptable only because they are throwaway and hold no data; Neon roles have generated passwords.
