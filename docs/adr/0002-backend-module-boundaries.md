# ADR 0002 — Backend module boundaries

- **Status:** Accepted (owner ruling, 2026-10-13)
- **Date:** 2026-10-13
- **Related:** brief §2.5, §7, §11; open questions [E-1](../architecture/open-questions.md#e-1), [E-2](../architecture/open-questions.md#e-2), [D-4](../architecture/open-questions.md#d-4)

## Context

AORA is one modular monolith with separate financial domains (CHIWO, KONY, KELO, NAM) on a shared platform. The brief requires "clear domain ownership and authorization boundaries" without microservices. The main risk in a monolith is that boundaries erode: one module reads another's tables, or writes a balance directly.

## Decision

**One NestJS codebase, one PostgreSQL database, modules with enforced boundaries.**

Modules, created only when a phase needs them:

| Module | Owns |
|---|---|
| `identity` | Persons, accounts, authentication interface, sessions, step-up |
| `business` | Legal entities, canonical business identity, external identifiers |
| `tenancy` | Workspaces, memberships, roles, permission checks |
| `audit` | Append-only audit events |
| `ledger` | Accounts, journal entries, postings, balances (ADR 0003) |
| `payments` | Payment intents, orchestration, provider adapters (ADR 0007), webhook intake, reconciliation |
| `outbox` | Transactional outbox and worker loop (ADR 0008) |
| `chain` | Base and USDC integration (ADR 0004, 0005) |
| `kony`, `kelo`, `chiwo`, `nam` | Product-specific records and workflows |

Rules:

1. **A module owns its tables.** No other module reads or writes them. Each module's tables live in their own PostgreSQL schema where the ORM supports it (to verify in Phase 1), otherwise under a table-name prefix.
2. **Modules talk through exported application services and outbox events**, never through each other's repositories or tables. Cross-module foreign keys reference IDs only.
3. **Dependency direction is one way:** product modules → `payments`/`ledger`/`chain` → `business`/`tenancy`/`identity`/`audit`. Platform modules never import product modules. Enforced by a lint rule in CI from Phase 1.
4. **Only `ledger` writes ledger tables.** Every other module posts through its API. No module keeps its own balance column.
5. **Authorization is checked in the application service**, not only in the HTTP controller, so workers and internal callers get the same checks. Every query on tenant-owned data is scoped by tenant; PostgreSQL row-level security is a second barrier (E-1).
6. **Every tenant and financial record carries a `mode`** (`sandbox` only until production readiness; E-2).
7. **Process entry points are added when needed.** Phase 1 has one API process and one worker process from the same codebase. A separate `webhook-ingress` deployable (§11.2) is split out only when its exposure or scaling profile differs enough to justify it.

## Alternatives considered

- **Microservice per product:** rejected by the brief; adds distributed transactions to a ledger that needs local ones.
- **Unstructured monolith with shared models:** fastest at first, and the direct cause of balance conflation and tenant leaks later.
- **Separate database per domain:** makes "post journal and update payment state in one transaction" impossible without sagas.

## Consequences

- A payment state change, its journal entry and its outbox event commit in one database transaction.
- Boundary rules need tooling (lint rule, schema separation) and review discipline; without enforcement they will decay.
- A module can later be extracted along its service interface if scale ever requires it.
- Product modules cannot take shortcuts into platform tables; some queries will need an explicit platform service method.

## Addendum, 2026-10-19 (Phase 7: CHIWO, the personal context)

- A new product module, `chiwo`, owns the `chiwo` schema. It is the **personal context**: every route is under `/v1/chiwo/*`, acts for the signed-in person only, and refuses any request carrying `Aora-Workspace-Id` (`context_mismatch`). Workspace membership grants nothing in CHIWO, and a CHIWO account grants nothing in a workspace (brief §7.1; phase-7 plan P7-1).
- Consumer isolation in the database: `chiwo` tables carry the consumer's account and have a `consumer_isolation` policy (`identity.current_account_id()`, set by `Database.withConsumer`) and **no tenant policy**, so the tenant-scoped role never sees them (P7-2).
- `chiwo` → `payments` follows rule 3: a CHIWO payment to a merchant is created through `PaymentsService.createIntent` (channel `chiwo`), and CHIWO hears about status changes through the outbox event `chiwo.merchant_payment.result`, whose name lives in `payments` so that `payments` never imports `chiwo`.
- Merchant pay codes (`tenancy.pay_code`) belong to `tenancy`: a workspace creates them; CHIWO reads only the trading name behind an active code.
