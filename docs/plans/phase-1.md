# Phase 1 Plan — Foundation and ledger core, via the first vertical slice

- **Status:** scope approved by the owner on 2026-10-13 (checkpoints 1A → 1B → 1C). Proceeding without further approval.
- **Scope source:** [delivery-plan.md](../architecture/delivery-plan.md) §3. Nothing outside §3.1 is built.
- **ADRs applied:** 0001, 0002, 0003, 0007, 0008 (outbox part), 0012 (tables and exact-match constraints only).

Everything is sandbox. The only provider is the AORA simulator. No chain code, no UI, no deployment.

## 1. Layout

One workspace package, `services/api` (`@aora/api`), with two entry points: the HTTP API and the worker.

```text
services/api/
  prisma/migrations/NNNN_name/migration.sql   reviewed SQL, the schema's source of truth
  prisma/schema.prisma                        generated from the database by introspection
  src/main.ts            API process
  src/worker.ts          worker process
  src/app.module.ts
  src/platform/          config, database (two pools), errors, http conventions, money
  src/modules/identity/  persons, accounts, AuthProvider, sessions, step-up
  src/modules/business/  businesses, identifiers
  src/modules/tenancy/   workspaces, memberships, roles, guards
  src/modules/audit/     append-only events
  src/modules/ledger/    assets, accounts, journal, postings, balances
  src/modules/outbox/    outbox table, worker loop, handler registry
  src/modules/payments/  intents, adapter interfaces, simulator, webhooks, reconciliation
  src/seed.ts            sandbox seed data
  test/                  integration tests against PostgreSQL
docs/api/openapi.yaml    API contract; a test fails if routes and spec differ
```

Schema workflow: SQL migrations are hand-written and reviewed (brief §11.1) and applied with `prisma migrate deploy`. `schema.prisma` is regenerated with `prisma db pull`; CI fails if it is stale.

## 2. Database

### 2.1 Roles and tenant isolation (E-1)

| Role | Used by | Rights |
|---|---|---|
| `aora_owner` | migrations only | owns all objects |
| `aora_app` | API requests for a signed-in user | tenant tables only through row-level security; no `UPDATE`/`DELETE` on ledger or audit |
| `aora_platform` | worker, webhook intake, reconciliation, operator endpoints, sign-in | cross-tenant read and write through explicit policies; same ledger and audit immutability |

- Every tenant-owned table has `tenant_id uuid not null`, `ENABLE` and `FORCE ROW LEVEL SECURITY`, and a policy for `aora_app`: `tenant_id = current_setting('app.tenant_id', true)::uuid`. With the setting absent the comparison is null, so no row is visible or writable.
- The setting is applied with `set_config('app.tenant_id', $1, true)` as the first statement of each transaction, by one helper (`Database.withTenant`). No other code path hands out an `aora_app` connection.
- The tenant is the workspace: `tenant_id = tenancy.workspace.id`.

### 2.2 Mode (E-2)

Every tenant and financial table has `mode text not null default 'sandbox' check (mode = 'sandbox')`. Every API response body carries `"mode": "sandbox"`, and every response has the header `Aora-Mode: sandbox`.

### 2.3 Tables

One PostgreSQL schema per module.

**identity**
- `person(id, created_at)` — a natural person. No personal attributes in Phase 1 beyond what sign-in needs.
- `account(id, person_id, phone_e164 unique, is_platform_operator bool, created_at)`
- `auth_challenge(id, account_id, code_hash, expires_at, attempts, consumed_at)`
- `session(id, account_id, token_hash unique, created_at, expires_at, revoked_at, step_up_until)`

**business** (ADR 0012)
- `business(id, kind 'registered'|'unregistered', name, name_normalised, country, owner_person_id, location jsonb, mode)`
- `business_identifier(id, business_id, type, country, value_normalised, verified_at, unique(type, country, value_normalised))`
- Unique index on (`owner_person_id`, `name_normalised`, location key) where `kind = 'unregistered'`.

**tenancy**
- `workspace(id, business_id, product 'kony', mode, unique(business_id, product))`
- `membership(id, tenant_id, account_id, role 'admin'|'finance'|'cashier', unique(tenant_id, account_id))`

**audit**
- `event(id, occurred_at, tenant_id null, actor_account_id null, actor_kind 'user'|'system'|'provider', action, subject_type, subject_id, outcome, detail jsonb, mode)` — insert-only (trigger).

**ledger** (ADR 0003)
- `asset(code pk, kind 'fiat'|'token', exponent smallint)` — Phase 1 row: `KES`; the exponent is seeded data.
- `account(id, tenant_id null, asset_code, type, normal_side 'debit'|'credit', allow_negative bool, mode, unique(tenant_id, type, asset_code))`. `tenant_id` null means a platform account.
- `journal_entry(id, tenant_id, idempotency_key unique, entry_type, operation_type, operation_id, reverses_entry_id null, mode, posted_at)`
- `posting(id, entry_id, account_id, tenant_id, direction 'debit'|'credit', amount bigint check (amount > 0), asset_code)`
- `account_balance(account_id pk, balance bigint, updated_at)` — maintained only by a trigger on `posting`.

Phase 1 chart of accounts (sandbox assumption, M-4):

| Type | Owner | Normal side | Meaning |
|---|---|---|---|
| `provider_clearing` | platform | debit | Money the sandbox provider holds for AORA |
| `merchant_collections_pending` | tenant | credit | Collected for the merchant, not yet settled |

Journal for a successful collection of amount *a*: debit `provider_clearing` *a*, credit `merchant_collections_pending` *a*. Idempotency key `payment_intent:<id>:collection`.

Database-enforced invariants:

1. Deferred constraint trigger on `posting`: at commit, for each entry and asset, debits = credits, and the entry has ≥ 2 postings.
2. `BEFORE UPDATE OR DELETE` triggers on `journal_entry` and `posting` raise; `TRUNCATE` is revoked.
3. `posting.asset_code` must equal the account's asset; `posting.tenant_id` must equal the entry's.
4. Balance trigger applies the signed amount by normal side and raises if the result is negative and `allow_negative` is false.
5. `idempotency_key` unique.

**outbox**
- `event(id, tenant_id null, type, payload jsonb, status 'pending'|'processing'|'done'|'dead', attempts, available_at, locked_at, last_error, created_at, processed_at)`

**payments**
- `payment_intent(id, tenant_id, idempotency_key, request_hash, amount bigint, asset_code, status, provider, provider_reference null, scenario null, failure_code null, status_inquiries int, created_by, mode, created_at, updated_at, unique(tenant_id, idempotency_key))`
- `payment_intent_transition(id, intent_id, tenant_id, from_status, to_status, reason, source 'api'|'adapter'|'webhook'|'inquiry'|'reconciliation', created_at)` — insert-only history.
- `webhook_event(id, provider, provider_event_id, signature_valid, payload_raw text, received_at, processed_at, outcome, unique(provider, provider_event_id))`
- `reconciliation_run(id, provider, started_at, finished_at, lines_checked, exceptions_opened, mode)`
- `reconciliation_exception(id, run_id, tenant_id null, type, subject_type, subject_ref, detail jsonb, status 'open', mode, created_at, unique(type, subject_ref) where status = 'open')`

**sim** (the simulator's own side of the world; not AORA's books)
- `transaction(id, operation_ref unique, amount bigint, asset_code, scenario, status 'pending'|'succeeded'|'failed', inquiry_count, created_at)`
- `webhook_delivery(id, transaction_id, event_id, payload jsonb, deliver_after, delivered_at)`

## 3. State machines

### 3.1 Payment intent

```text
created ──▶ submitting ──▶ pending_provider ──▶ succeeded
                │                │        └───▶ failed
                │                └───────────▶ reconciliation_required
                ├──▶ failed                    (provider rejected)
                └──▶ status_unknown ──▶ succeeded | failed | reconciliation_required
failed ──▶ reconciliation_required             (late success after a recorded failure)
succeeded ──▶ reconciliation_required          (contradicting provider result)
```

- `succeeded` and `failed` change only to `reconciliation_required`. `reconciliation_required` is terminal in Phase 1 (operators can see it; resolution is Phase 3).
- `submitting` is committed **before** the provider is called. If a worker dies mid-call, the retry finds `submitting`, does not call again, and moves to `status_unknown`.
- Provider timeout or ambiguous response → `status_unknown`, no posting, no resubmission. A status inquiry is scheduled through the outbox with backoff; after the configured number of inquiries without an answer → `reconciliation_required`.
- A success result with an amount different from the intent → `reconciliation_required` plus an `amount_mismatch` exception, no posting.
- The transition and its journal entry commit in one transaction. The transition table (`from`, `to`) is a constant; anything not in it is rejected.

### 3.2 Outbox event

`pending → processing → done`; on handler error `processing → pending` with backoff until the attempt limit, then `dead`. Rows are claimed with `FOR UPDATE SKIP LOCKED`. Handlers are idempotent; each has a test that runs it twice.

### 3.3 Sign-in (sandbox authenticator)

`challenge issued → verified (session created)` or `expired` / `locked` after too many attempts. Step-up: `POST /v1/auth/step-up` with a code sets `session.step_up_until`; a `RequiresStepUp` guard checks it. No Phase 1 endpoint is sensitive enough to need it, so the guard is tested on its own and first applied in Phase 2.

The sandbox authenticator accepts one fixed code for seeded accounts and refuses to load unless `AORA_MODE=sandbox`.

## 4. Endpoints

All under `/v1`. Errors are `{ "error": { "code", "message", "request_id" }, "mode": "sandbox" }` with stable codes. Amounts are strings of digits in minor units (`"amount_minor": "15000"`); numbers, decimals, exponents and signs are rejected.

| Method and path | Auth | Purpose |
|---|---|---|
| `GET /v1/health` | none | liveness and database check |
| `POST /v1/auth/challenges` | none | start sign-in for a phone number |
| `POST /v1/auth/sessions` | none | exchange challenge and code for a session token |
| `POST /v1/auth/step-up` | session | simulated second factor |
| `GET /v1/me` | session | account and memberships |
| `POST /v1/payment-intents` | session + workspace; `admin`, `finance`, `cashier` | create a collection intent. `Idempotency-Key` required. Optional `sandbox_scenario` |
| `GET /v1/payment-intents/{id}` | session + workspace; same roles | status lookup |
| `POST /v1/webhooks/sandbox` | signature | simulator webhook intake |
| `POST /v1/ops/reconciliation-runs` | operator | run reconciliation now |
| `GET /v1/ops/reconciliation-exceptions` | operator | list |
| `GET /v1/ops/reconciliation-exceptions/{id}` | operator | inspect |

The workspace is named by the `Aora-Workspace-Id` header and checked against the caller's memberships. Authorization is checked in application services as well as guards.

Idempotency: same key and same body → the original response; same key and different body → `409 idempotency_key_reused`; concurrent duplicates resolve to one row through the unique constraint.

## 5. Provider adapter and simulator (ADR 0007)

Interfaces: `CollectCapability`, `StatusInquiryCapability`, `WebhookCapability`, `SettlementReportCapability`, plus a static capability declaration. Outcomes: `accepted | rejected | unknown`.

Simulator scenarios (accepted only in sandbox): `success`, `decline`, `timeout_then_success`, `timeout_then_failure`, `duplicate_webhook`, `late_webhook`, `amount_mismatch`, `missing_settlement_line`.

Webhooks are signed with HMAC-SHA-256 over the raw body using `SANDBOX_SIM_WEBHOOK_SECRET` (tests generate a random one). The worker delivers due simulator webhooks to the API over HTTP, so the real intake path is exercised.

## 6. Reconciliation

A run fetches the simulator's settlement report and compares it with intents and journal entries. Exception types: `missing_internal`, `missing_at_provider`, `amount_mismatch`, `duplicate_reference`, `stuck_status_unknown`, `ledger_mismatch`. It only records; it never corrects. Re-running does not duplicate an open exception.

## 7. Tests (written before the code they test)

The list in delivery-plan §3.4, organised as:

| File | Covers |
|---|---|
| `test/tooling.spike.test.ts` | 1A: NestJS dependency injection under the test runner; Prisma with row-level security |
| `test/tenant-isolation.test.ts` | cross-tenant read and write denied at API and at database; no setting → no rows |
| `test/auth.test.ts` | challenge, session, expiry, lockout, unauthenticated rejection, step-up guard, role matrix |
| `test/audit.test.ts` | insert-only; events written for sign-in and intent creation |
| `test/ledger.invariants.test.ts` | balance (including a property test), immutability, precision, idempotent posting, negative-balance rule, mode |
| `test/outbox.test.ts` | atomic enqueue, claim under concurrency, retry, dead, handler twice |
| `test/payment-intent.test.ts` | idempotency, state machine, amount validation |
| `test/payment-flow.test.ts` | each simulator scenario end to end, including unknown state and late webhook |
| `test/webhook.test.ts` | bad signature, duplicate, raw payload stored |
| `test/reconciliation.test.ts` | each exception type; clean run; no auto-correction; re-run stable |
| `test/openapi.test.ts` | routes and spec agree |
| `test/hygiene.test.ts` | no secret patterns in captured logs |

Tests run against a real PostgreSQL 16. Locally: a throwaway user-level cluster started by `pnpm db:start`. CI: a PostgreSQL service container.

## 8. Checkpoints

1. **1A** — package, tooling spike (Vitest with NestJS, else Jest; Prisma with RLS), database roles, identity, business, tenancy, audit, API conventions, seed, OpenAPI. Commit.
2. **1B** — ledger core and outbox. Tests first. Commit.
3. **1C** — payment intent, simulator, webhook, reconciliation, operator endpoints. Commit.

Then: architecture documents (`system-overview`, `domain-boundaries`, `financial-ledger`, `security-and-tenancy`), end-of-phase report, stop.

## 9. Not in this phase

Fees and tariffs, payouts, refunds, settlement, real providers, SMS, PIN, KYC, branches, any chain code, KELO, CHIWO, NAM, any UI, deployment, USDC as a ledger asset.
