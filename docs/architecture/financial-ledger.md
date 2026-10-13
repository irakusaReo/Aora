# AORA — Financial Ledger

State at the end of Phase 1. Implements [ADR 0003](../adr/0003-internal-ledger-model.md). Schema: `services/api/prisma/migrations/20261013000200_ledger_outbox/migration.sql`.

The internal ledger is the accounting source of truth. Nothing on a provider's side or on-chain replaces it.

## Model

| Table | Meaning |
|---|---|
| `ledger.asset` | A currency or token and its `exponent` (minor-unit digits). Data, never assumed. Phase 1 has `KES` |
| `ledger.account` | Holds one asset, has one type from a closed list, a normal side, and a rule on whether it may go negative. `tenant_id` null means a platform account |
| `ledger.journal_entry` | One accounting event. Has a unique idempotency key and names the operation it belongs to |
| `ledger.posting` | One debit or credit of a positive integer amount to one account |
| `ledger.account_balance` | Running balance per account, expressed on the account's normal side |

Amounts are `BIGINT` minor units in the database and `bigint` in code. There is no floating point anywhere on the path; a test also checks the source for float helpers.

### Account types (Phase 1)

| Type | Owner | Normal side | May go negative | Meaning |
|---|---|---|---|---|
| `provider_clearing` | platform, one per provider | debit | no | Money the provider holds for AORA |
| `merchant_collections_pending` | merchant | credit | no | Collected for the merchant, not yet settled |

Distinct kinds of balance are distinct account types (CLAUDE.md rule 5). "Settled", "available", "USDC", "investment holding" and "credit limit" will each be their own type when they are built; they will not be flags on an existing one. This chart is a sandbox assumption until the funds-flow model is decided (open questions D-4, M-4).

## Invariants and where they are enforced

All of these are enforced by the database, so they hold even against a bug in application code or a direct SQL session.

| Invariant | Mechanism |
|---|---|
| Per entry and asset, debits equal credits; at least two postings | Constraint trigger, deferred to commit |
| Entries, postings and accounts are never updated, deleted or truncated | `BEFORE` triggers; application roles also lack the privileges |
| Postings cannot be added to an entry from an earlier transaction | Trigger compares the entry's creating transaction id |
| A posting's asset matches its account; its tenant matches its entry | Trigger |
| A tenant's entry cannot post to another tenant's account | Trigger |
| Balances change only by posting; no negative balance where forbidden | Trigger owns `account_balance`; roles have `SELECT` only |
| One entry per idempotency key | Unique constraint |
| Amounts are positive integers | Column type and check |
| Every row is sandbox | `mode` check |

## Behaviour

- **Posting is idempotent.** `LedgerService.post` with a key already used returns the original entry and writes nothing. A key reused for a different operation is an error. Concurrent posts of one key produce one entry.
- **Corrections are compensating entries.** `LedgerService.reverse` posts the mirror image, linked by `reverses_entry_id`. An entry can be reversed once; a reversal cannot be reversed. The original is never touched.
- **Pending money is an account, not a status.** A collection sits in `merchant_collections_pending` until a later entry moves it.
- **A journal entry and the state change that causes it commit together.** A payment is never `succeeded` without its entry, and an entry never exists for a payment that is not `succeeded`. A test checks both directions.

## Idempotency keys in use

| Key | Entry |
|---|---|
| `payment_intent:<intent id>:collection` | Collection credited to the merchant |

## Reconciliation against the ledger

For every `succeeded` payment intent, reconciliation checks that the net credit to the merchant's accounts for that intent equals the intent amount, and opens a `ledger_mismatch` exception otherwise. See `ReconciliationService`.

## Not built yet

Fees and revenue accounts, settlement, payouts, refunds as a workflow, statements, balance rebuild job, period close, multi-asset entries, USDC.
