# AORA — Domain Boundaries

State after Phase 2 checkpoints 2A to 2F. Implements [ADR 0002](../adr/0002-backend-module-boundaries.md).

## Modules and what they own

Each module owns one PostgreSQL schema of the same name. No module reads or writes another module's tables except through that module's exported service, with the exceptions listed below.

| Module (`src/modules/…`) | Schema | Tables | Responsibility |
|---|---|---|---|
| `identity` | `identity` | `person`, `user_account`, `step_up`, `provider_event` (and the retired `auth_challenge`, `session`) | AORA's person and account records, their link to the identity provider (Clerk), the transaction PIN and step-up |
| `notifications` | `notifications` | `notification`, `delivery_event` | What was sent to whom and what became of it; email channel and Resend adapter |
| `webhooks` | – | – | Intake of identity-provider and email-provider webhooks; composition only |
| `business` | `business` | `business`, `business_identifier` | Canonical business identity ([ADR 0012](../adr/0012-canonical-business-identity.md)) |
| `tenancy` | `tenancy` | `workspace`, `membership` | Workspaces (the tenant), roles |
| `audit` | `audit` | `audit_event` | Append-only record of actions |
| `consent` | `consent` | `terms_document`, `consent_record` | Versioned terms and consent records |
| `jobs` | `ops` | `job_lease` | Scheduler-triggered jobs and the sandbox SMS inbox |
| `ledger` | `ledger` | `asset`, `account`, `journal_entry`, `posting`, `account_balance` | Double-entry accounting ([financial-ledger.md](financial-ledger.md)) |
| `outbox` | `outbox` | `outbox_event` | Durable, at-least-once event delivery |
| `payments` | `payments`, `sim` | `payment_intent`, `payment_intent_transition`, `webhook_event`, `reconciliation_run`, `reconciliation_exception`; `sim_transaction`, `sim_webhook_delivery` | Payment intents, provider adapters, webhook intake, reconciliation, and the simulator provider |

`src/platform/` holds what every module uses: configuration, the deployment guard, the database gateway, the error envelope, HTTP conventions, money parsing and the rate limiter (`ops.rate_limit`).

No product module (`kony`, `kelo`, `chiwo`, `nam`) exists yet. Payment intents live in `payments` because they are platform capability, not KONY-specific.

## Dependency direction

Enforced by lint (`eslint.config.mjs`), and proven by `tests/import-boundaries.test.ts`, which plants violations and checks they are rejected.

| Module | May import |
|---|---|
| `platform` | nothing under `modules` |
| `audit`, `business`, `ledger`, `outbox`, `consent` | `platform` |
| `tenancy` | `audit` |
| `identity` | `audit`, `tenancy` |
| `notifications` | `outbox` |
| `payments` | `audit`, `ledger`, `notifications`, `outbox` |
| `jobs` | `outbox`, `payments` |
| `webhooks` | `identity`, `notifications` |

Two files may be imported from anywhere, so any controller can declare who may call it: `identity/guards.ts` and `tenancy/permissions.ts`. Only `platform/database.ts` may use the database client; modules import its types.

## Rules in force

1. **Only `LedgerService` writes ledger tables.** The database backs this up: application roles have no update or delete on them, and `account_balance` can only be written by a trigger.
2. **Only `Database` hands out connections** (`src/platform/database.ts`), and only inside a transaction, as either the tenant role or the platform role.
3. **Cross-module effects that must be atomic share the caller's transaction.** `payments` passes its transaction to `LedgerService.post`, `AuditService.record` and `OutboxService.enqueue`, so a status change, its journal entry, its audit event and its follow-up event commit together.
4. **Cross-module effects that may lag go through the outbox**, and their handlers are idempotent.
5. **Authorization is decided before a module's service is called** by guards, and tenant scope is enforced again by the database.

## Known exceptions and debts

- `notifications` reads `identity.user_account` directly to find a recipient's address at send time.

- `payments` reconciliation and `tenancy`'s balances endpoint read `ledger` tables directly. Acceptable for read-only checks; revisit if the ledger gains a query API.
- All modules are registered in one NestJS module (`AppModule`). Splitting into one NestJS module per domain is deferred until there are enough providers for it to matter.
- `payments` still carries a `provider` column and one hard-wired simulator adapter. The rail model of [ADR 0014](../adr/0014-multi-rail-multi-country.md) arrives with the first real rail in Phase 3.
