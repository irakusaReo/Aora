# AORA — Security and Tenancy

State at the end of Phase 1. Sandbox only.

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

- **Phase 1 uses a sandbox authenticator.** Seeded accounts, one fixed code, nothing sent. It refuses to load outside sandbox mode. Real phone and one-time-code sign-in arrives in Phase 2, behind the same `AuthProvider` interface. Production choice: [ADR 0011](../adr/0011-production-authentication.md).
- Sign-in is a challenge then a code. Challenges expire, are single-use, and lock after repeated wrong codes. The endpoint answers the same way for registered and unregistered numbers.
- Session tokens are 256 random bits, returned once, stored only as a SHA-256 hash, with expiry and revocation.
- Codes are stored only as salted HMAC state.

## Authorization

- Default deny. A workspace route with no `@AllowRoles` admits nobody.
- Roles: `admin`, `finance`, `cashier`. In Phase 1 all three may create and read payment intents; they differ from Phase 2 on.
- Operator endpoints require the account's platform-operator flag.
- **Step-up:** `StepUpGuard` requires a second-factor confirmation within the last five minutes. It is implemented and tested, but **no Phase 1 endpoint uses it**, because none is sensitive enough. It is first applied in Phase 2.
- Membership of a workspace grants nothing beyond the listed role permissions.

## Secrets

- None in code, migrations, database rows or logs. `bootstrap.sql` sets no passwords.
- Configuration comes from the environment (`.env.local` locally, git-ignored). `.env.example` holds placeholders only, checked by a test.
- A configuration error names the variable, never its value.
- The only secret in Phase 1 is `SANDBOX_SIM_WEBHOOK_SECRET`, AORA's own simulator signing key.

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

- Rate limiting on any endpoint, including sign-in. The per-challenge lockout exists; per-number and per-address limits do not.
- Session binding to a device; sign-out endpoint.
- Encryption at rest, backups, TLS: these belong to deployment, which does not exist yet.
- Dependency and secret scanning in CI.
- The local and CI databases use trust authentication. That is acceptable only because they are throwaway and hold no data; any shared environment must set role credentials through its secret store.
