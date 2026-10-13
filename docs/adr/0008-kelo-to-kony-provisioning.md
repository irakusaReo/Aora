# ADR 0008 — KELO-to-KONY provisioning with a transactional outbox

- **Status:** Proposed
- **Date:** 2026-10-13
- **Related:** brief §4.5, §10.1, §13.4; CLAUDE.md rules 7, 12; open questions [G-2](../architecture/open-questions.md#g-2), [R-2](../architecture/open-questions.md#r-2), [R-4](../architecture/open-questions.md#r-4), [D-7](../architecture/open-questions.md#d-7)

## Context

A qualifying KELO merchant must get exactly one linked KONY workspace, automatically, idempotently and recoverably. The brief requires a durable event-driven workflow backed by database transactions and a transactional outbox. There is no KELO system yet (R-2), and "migration of existing merchants" is read as a backfill (G-2). The same outbox is needed earlier for webhook processing (R-4).

## Decision

**Outbox (general mechanism, built in Phase 1):**

- An `outbox` table in the same database. A module writes its state change and its outbox row in **one transaction**.
- A worker claims rows with row locking that skips rows held by other workers, handles each, and marks it done. Delivery is **at least once**; every handler is idempotent.
- Failed rows retry with backoff up to a limit, then become `dead` and raise an alert. Dead rows are visible to operators and can be replayed.
- No message broker. Events are in-process contracts between modules, versioned by name.

**Provisioning workflow (Phase 4):**

- **Trigger:** the `kelo` module moves a merchant to its approved state and writes `kelo.merchant.approved` in the same transaction. A minimal KELO merchant domain (record, link to canonical business, approval state machine) is built for this; no credit logic.
- **State machine** on a `provisioning` record, unique per KELO merchant: `requested` → `business_resolved` → `workspace_linked` → `admin_assigned` → `completed`, with `failed_retryable`, `failed_needs_review` and `reconciliation_required`. Each step is a separate idempotent transaction so a crash resumes from the last completed step.
- **Exactly one workspace** is guaranteed by database unique constraints: one provisioning record per KELO merchant, one KELO link per workspace, one workspace per canonical business per product. Not by application checks alone.
- **Business resolution** matches on verified external identifiers (D-7). An ambiguous match stops at `failed_needs_review`; the workflow never auto-merges two businesses.
- **Initial administrator** is the verified authorized representative on the KELO record. If that person cannot be resolved, the workflow stops for review rather than guessing.
- **Authority granted:** workspace administration only. No payment, payout, financing, investment or settlement-instruction authority is granted by provisioning (brief §4.5; CLAUDE.md rule 12).
- **Restricted merchants stay restricted:** KELO restrictions are copied to the workspace as restrictions, never dropped.
- **Backfill:** an idempotent job that finds approved KELO merchants with no completed provisioning record and enqueues the same workflow. This is the "migration" path.
- **Visibility:** an operator endpoint lists provisioning records by state and reason and allows an audited retry. Each transition writes an audit event. Merchant notification is the last step and never blocks completion.
- **Event names** follow brief §10.1 and are published only when the code that emits them exists.

## Alternatives considered

- **Create the workspace synchronously inside the KELO approval request:** couples KELO approval to KONY availability and leaves partial state on failure.
- **Message broker (Kafka, RabbitMQ, cloud queue):** a second system to operate and a dual-write problem unless an outbox is used anyway.
- **Workflow engine:** strong recovery semantics, but a significant new dependency for one linear workflow. Revisit if workflows multiply.
- **Redis-backed job queue:** jobs are not committed atomically with the business transaction.
- **Database notifications alone:** not durable; lost if no listener is connected.

## Consequences

- No distributed transaction and no new infrastructure.
- At-least-once delivery makes idempotency a requirement of every handler, enforced by tests that deliver each event twice.
- Polling adds a small delay between approval and workspace creation.
- The outbox table needs retention and monitoring (backlog age, dead count).
- If KELO is ever a separate system, only the trigger changes; the workflow and its guarantees stay.
