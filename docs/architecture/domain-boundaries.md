# AORA — Domain Boundaries

State at the end of Phase 1. Implements [ADR 0002](../adr/0002-backend-module-boundaries.md).

## Modules and what they own

Each module owns one PostgreSQL schema of the same name. No module reads or writes another module's tables except through that module's exported service, with the exceptions listed below.

| Module (`src/modules/…`) | Schema | Tables | Responsibility |
|---|---|---|---|
| `identity` | `identity` | `person`, `user_account`, `auth_challenge`, `session` | Who a person is, how they prove it, sessions, step-up |
| `business` | `business` | `business`, `business_identifier` | Canonical business identity ([ADR 0012](../adr/0012-canonical-business-identity.md)) |
| `tenancy` | `tenancy` | `workspace`, `membership` | Workspaces (the tenant), roles |
| `audit` | `audit` | `audit_event` | Append-only record of actions |
| `ledger` | `ledger` | `asset`, `account`, `journal_entry`, `posting`, `account_balance` | Double-entry accounting ([financial-ledger.md](financial-ledger.md)) |
| `outbox` | `outbox` | `outbox_event` | Durable, at-least-once event delivery |
| `payments` | `payments`, `sim` | `payment_intent`, `payment_intent_transition`, `webhook_event`, `reconciliation_run`, `reconciliation_exception`; `sim_transaction`, `sim_webhook_delivery` | Payment intents, provider adapters, webhook intake, reconciliation, and the simulator provider |

`src/platform/` holds what every module uses: configuration, the database gateway, the error envelope, HTTP conventions and money parsing.

No product module (`kony`, `kelo`, `chiwo`, `nam`) exists yet. Payment intents live in `payments` because they are platform capability, not KONY-specific.

## Dependency direction

```text
payments ──▶ ledger, outbox, audit
identity ──▶ audit, tenancy (reads memberships)
tenancy, business, ledger, outbox, audit ──▶ platform only
```

Nothing depends on `payments`. `ledger` depends on no other module.

## Rules in force

1. **Only `LedgerService` writes ledger tables.** The database backs this up: application roles have no update or delete on them, and `account_balance` can only be written by a trigger.
2. **Only `Database` hands out connections** (`src/platform/database.ts`), and only inside a transaction, as either the tenant role or the platform role.
3. **Cross-module effects that must be atomic share the caller's transaction.** `payments` passes its transaction to `LedgerService.post`, `AuditService.record` and `OutboxService.enqueue`, so a status change, its journal entry, its audit event and its follow-up event commit together.
4. **Cross-module effects that may lag go through the outbox**, and their handlers are idempotent.
5. **Authorization is decided before a module's service is called** by guards, and tenant scope is enforced again by the database.

## Known exceptions and debts

- `identity` reads `tenancy.membership` directly when it loads a session. It should call a tenancy service method.
- `payments` reconciliation reads `ledger` tables directly to compare amounts. Acceptable for a read-only check; revisit if the ledger gains a query API.
- Module boundaries are a convention plus database grants. **The lint rule that enforces import direction (ADR 0002 rule 3) is not in place yet**; it is the first task of Phase 2.
- All modules are registered in one NestJS module (`AppModule`). Splitting into one NestJS module per domain is deferred until there are enough providers for it to matter.
