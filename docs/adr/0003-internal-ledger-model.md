# ADR 0003 — Internal ledger model

- **Status:** Accepted (owner ruling, 2026-10-13)
- **Date:** 2026-10-13
- **Related:** brief §3.5, §8, §13.1; CLAUDE.md rules 3–6; open questions [R-1](../architecture/open-questions.md#r-1), [D-4](../architecture/open-questions.md#d-4)

## Context

The double-entry ledger is mandatory and is the accounting source of truth; on-chain records never replace it. It must keep collections, settled funds, available cash, USDC, investment holdings and credit limits distinct, never use floating point, never rewrite history, and make every write idempotent. It has to exist before anything posts money (R-1).

## Decision

**A double-entry ledger in PostgreSQL, owned by the `ledger` module, with invariants enforced by the database.**

Data model:

- **`asset`** — code (for example `KES`, `USDC`), kind (fiat or token), and `exponent` (number of minor-unit digits). Exponents are data: fiat from a currency table, USDC from verified chain config (ADR 0005). Nothing assumes two decimals.
- **`account`** — id, owner reference (tenant, legal entity or platform), asset, **account type** from a closed list (for example: provider clearing, merchant collections pending settlement, merchant settled, fees revenue, fees payable, suspense), normal side, mode. One account holds one asset. The distinct balance kinds in CLAUDE.md rule 5 are distinct account types, never flags on one balance.
- **`journal_entry`** — id, idempotency key (unique), entry type, reference to the originating operation, optional `reverses_entry_id`, mode, posted-at. Immutable once written.
- **`posting`** — entry id, account id, direction (debit or credit), `amount` as a positive `BIGINT` in minor units. Immutable.
- **`account_balance`** — derived running balance per account, updated in the same transaction as the postings and fully rebuildable from them.

Invariants, enforced in the database as well as in code:

1. For each entry and each asset, total debits equal total credits (deferred constraint trigger checked at commit).
2. An entry has at least two postings; amounts are positive integers.
3. No `UPDATE` or `DELETE` on entries or postings (trigger, and the application role lacks the privilege).
4. A repeated idempotency key returns the original entry and writes nothing.
5. Accounts of a type that must not go negative are checked in the posting transaction.
6. All postings in an entry share the entry's mode.

Behaviour:

- **Corrections are compensating entries** linked by `reverses_entry_id`. Nothing is edited.
- **Pending money is modelled with accounts, not mutable status.** For example, a collection is posted to a "pending settlement" account and moved to "settled" by a second entry when settlement is confirmed.
- **Cross-asset operations** (later, fiat↔USDC) post through per-asset conversion clearing accounts so each asset still balances on its own.
- **Ledger tables use reviewed SQL migrations** for constraints and triggers (brief §11.1). The ORM is used for reads and for calling the posting function, not for bypassing it.
- The chart of accounts is versioned data. Its real shape depends on the funds-flow and legal model (D-4); Phase 1 uses a minimal sandbox chart.

## Alternatives considered

- **Balance columns on domain tables:** simple, and exactly what the brief forbids. No audit trail, easy conflation.
- **A dedicated ledger database or third-party ledger service:** purpose-built, but adds a second datastore and loses single-transaction posting with domain state. The brief says no extra databases without demonstrated need. Revisit if posting throughput becomes a limit.
- **Full event sourcing for all domains:** the journal already is the event log for money; applying it everywhere adds cost without a stated need.
- **`NUMERIC` amounts:** arbitrary precision, but integer minor units in `BIGINT` map to exact `bigint` in TypeScript and remove scale ambiguity. `BIGINT` has ample range for KES minor units and for USDC base units.

## Consequences

- Balances are always explainable as a sum of immutable postings; reconciliation has a stable target.
- Every money-moving feature must define its journal entries before it is built ("plan before code").
- Database-level enforcement means a bug in application code cannot post an unbalanced or mutated entry; it also means ledger migrations need careful review.
- The running-balance row is a contention point for very active accounts; acceptable now, measurable later.
- Reporting (statements, cash-flow views) reads from the ledger, so "collections", "settled" and "available" cannot drift apart.
