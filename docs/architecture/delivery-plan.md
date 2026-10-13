# AORA — Delivery Plan

- **Status:** Phases 0 and 1 are complete and approved. **From Phase 2 on, the build order and phase numbering in [mvp-scope.md](../product/mvp-scope.md) §2 supersede §2 and §4 of this document** (owner rulings of 2026-10-13: hosting, mobile, real rails, contracts, KELO as a marketplace). The entry and exit rules at the top of §2, and the test lists, still apply to the corresponding work.
- **Date:** 2026-10-13
- **Sources:** [master brief](master-development-brief.md) §14, [competitive lessons](../product/kony-competitive-lessons.md), [open questions](open-questions.md), [ADRs](../adr/)

Everything in every phase below is sandbox-only until Phase 13. Provider sandboxes and Base Sepolia are permitted; Base mainnet is not.

## 1. What changed from brief §14, and why

The brief's phases are kept. The order changes only where one phase needs something a later phase builds.

| Change | Reason | Open question |
|---|---|---|
| Phase 0 is "bootstrap and planning", not "repository discovery" | The repository is empty | G-1 |
| **Ledger core** moves from brief Phase 5 into Phase 1 | Payment intents and reconciliation post to and reconcile against the ledger | R-1 |
| **Outbox and worker** move from brief Phase 3 into Phase 1 | Webhook processing needs durable, idempotent work | R-4 |
| **API conventions** (idempotency keys, error codes, `/v1`, OpenAPI) move from brief Phase 9 into Phase 1; **tariff tables** into Phase 3 | They are structural; retrofitting them breaks the API | R-5 |
| Brief Phase 1 is split: a thin slice first (Phase 1), then completion (Phase 2) | Proves the money path end to end before widening | C-1 |
| A **minimal KELO merchant domain** is added to the provisioning phase | Provisioning has no trigger without it | R-2 |
| Brief Phase 5 keeps only **financial integration** and stays after Base | Linking journals to chain records needs both | R-1, R-6 |
| **New: CHIWO consumer core** (Phase 8) | NAM-in-CHIWO has no host otherwise | R-3 |
| **New: KELO credit core** (Phase 11) | No brief phase builds KELO credit | R-2 |

The two new phases were approved by the owner on 2026-10-13.

| This plan | Brief §14 |
|---|---|
| 0 Bootstrap and planning | 0 |
| 1 Foundation and ledger core, via the first vertical slice | 1 (thin), part of 5, part of 2 |
| 2 Foundation completion | 1 (rest) |
| 3 KONY merchant workflow | 2 |
| 4 KELO merchant domain and KELO-to-KONY provisioning | 3 |
| 5 Base and USDC foundation | 4 |
| 6 Financial integration | 5 (rest) |
| 7 NAM Vault backend | 6 |
| 8 CHIWO consumer core | new |
| 9 NAM Vault inside CHIWO | 7 |
| 10 NAM Vault inside KONY | 8 |
| 11 KELO credit core | new |
| 12 KONY commercial depth | 9 |
| 13 Production readiness and market expansion | 10 |

## 2. Phases

Rules for every phase:

- **Entry** always includes: previous phase approved by the owner; a written plan approved for any work touching money, the ledger, the chain or auth (CLAUDE.md).
- **Exit** always includes: CLAUDE.md definition of done; all tests from earlier phases still pass; lint and typecheck clean; documents for the phase's subject written (brief §15); end-of-phase report delivered; the owner approves.
- **Mocked is reported as mocked.** A phase that exits on a simulator says so.

### Phase 0 — Bootstrap and planning

- **Entry:** none.
- **Exit:** brief cleaned; greenfield readings, review findings and owner decisions recorded in `open-questions.md`; ADRs 0001–0010 proposed; this plan written; minimum scaffold in place; commands documented.
- **Proof:** `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm format:check` pass locally; CI workflow passes on first push (X-12).

### Phase 1 — Foundation and ledger core, via the first vertical slice

Scope is exactly §3 below.

- **Entry:** C-1 confirmed; ADRs 0001, 0002, 0003, 0007 accepted; E-1, E-2, E-3 approved; D-6 answered at least as "sandbox authenticator is acceptable for Phase 1".
- **Exit:** the slice runs end to end against a real PostgreSQL in CI; operator can list and inspect reconciliation exceptions; `system-overview.md`, `domain-boundaries.md`, `financial-ledger.md`, `security-and-tenancy.md` and `docs/api/openapi.yaml` exist and match the code.
- **Proof:** the test list in §3.4.

### Phase 2 — Foundation completion

Real authentication behind the Phase 1 interface, with step-up; full role and attribute model (brief §7.1–7.2); versioned consent records (§7.4); legal entity as data (D-4); canonical business external identifiers and duplicate detection (D-7); rate limiting; audit coverage for every administrative action; ledger completion (reversal API, statements, balance rebuild and verification job).

- **Entry:** Phase 1 approved; D-6 and D-7 decided.
- **Exit:** no endpoint reachable without authentication and a permission check; a person can act personally and for a business without the contexts mixing.
- **Proof:** authorization matrix test (every route × every role, default deny); step-up required on each action flagged sensitive; consent record names person, capacity, action, time and terms version; duplicate business detection returns "needs review" on ambiguous match and never auto-merges; rebuilt balances equal running balances; reversal produces a linked compensating entry and leaves the original untouched.

### Phase 3 — KONY merchant workflow

Merchant onboarding with tiered KYB behind a sandbox adapter; branches; staff roles including a collect-only cashier; collection points with parent and child (lessons §3); attribution references (lessons §5); transaction history; versioned tariff tables with the applied version recorded on each collection, and gross, fee and net shown (lessons §1); settlement states; reconciliation extended to fees and settlement; a second, real provider sandbox adapter if access exists; thin `kony-web` (R-7).

- **Entry:** Phase 2 approved; D-3 decided or explicitly deferred; D-4 funds-flow model decided or a sandbox assumption approved; D-8 at least stubbed.
- **Exit:** a merchant can be onboarded, take a sandbox payment at a branch, and see gross, fee, net, settlement status and where funds sit; operators can resolve exceptions with an audited reason.
- **Proof:** fee calculation uses the tariff version effective at transaction time, including across a tariff change, with no code change; tiered, capped and free-band tariffs compute exactly in integer minor units; cashier cannot view payouts, change settings or see another branch; merchant A cannot read merchant B at API or database level; adapter contract suite passes for every adapter; reconciliation detects missing, duplicate, mismatched-amount and delayed-settlement cases; every screen and response carries the sandbox label.

### Phase 4 — KELO merchant domain and KELO-to-KONY provisioning

Minimal KELO merchant record and approval state machine; provisioning workflow per ADR 0008; backfill job; operator visibility and retry; `merchant-provisioning.md` and its runbook.

- **Entry:** Phase 3 approved; ADR 0008 accepted; "qualifying" defined (R-2); D-7 decided.
- **Exit:** approving a KELO merchant produces exactly one linked KONY workspace with one administrator and no financial authority.
- **Proof (brief §13.4):** exactly one workspace per qualifying merchant; each event delivered twice creates no duplicate; a crash injected between every pair of steps resumes to completion; backfill links pre-existing merchants and is safe to re-run; administrator belongs to the correct business; restricted merchants remain restricted; cross-merchant access denied; ambiguous business match stops for review; provisioning grants no payment, payout, financing or investment permission.

### Phase 5 — Base and USDC foundation

Chain config and startup verification; native USDC policy; transfer observation and content verification; transaction state machine; signer interface; reconciliation of chain operations against observed chain state; local-chain test infrastructure; `base-and-usdc.md`, `wallet-and-signing.md`, `base-transaction-runbook.md`.

- **Entry:** Phase 4 approved; ADRs 0004 and 0005 accepted; C-2, C-3, C-4, E-4 answered; D-11 decided for any testnet work. **Transaction submission additionally requires D-1 and D-2** (ADRs 0009, 0010). Without them the phase delivers the read and verify side only and says so.
- **Exit:** an inbound native-USDC transfer on a test network or local chain is detected, verified and recorded with all fields of brief §3.5; nothing touches mainnet.
- **Proof (brief §13.2):** process refuses to start on wrong chain ID, wrong token address or wrong decimals; transfer of any other token is never credited and raises an exception; wrong amount or recipient is rejected; a hash alone is never accepted; reverted, dropped, replaced and delayed transactions reach the correct state; duplicate and delayed events are idempotent; an unknown-status submission is never automatically resubmitted; no mainnet chain ID is reachable from any sandbox config.

### Phase 6 — Financial integration

Link journal entries to chain operations and provider records; full reconciliation rules across ledger, providers and chain; failure recovery; `reconciliation-runbook.md`.

- **Entry:** Phases 3 and 5 approved.
- **Exit:** every money movement has a journal entry linked to its external evidence, or an open exception.
- **Proof:** a USDC deposit is credited only after the confirmation policy is met and reconciled; three-way reconciliation (ledger, provider or chain, operation record) flags each injected discrepancy; an on-chain transfer does not settle an unrelated off-chain obligation; corrections are compensating entries; no automatic "fix" of a difference.

### Phase 7 — NAM Vault backend

Investment domain; explicit product types; disclosures; deposit and withdrawal state machines; holdings from the authoritative source; provider interface with a sandbox provider; `nam-vault.md`, vault ADR, `vault-exception-runbook.md`.

- **Entry:** Phase 6 approved; **D-1, D-2 and D-10 decided**.
- **Exit:** a sandbox deposit and withdrawal run end to end for one product type.
- **Proof (brief §13.3):** funding confirmed is not investment confirmed; holdings change only on authoritative provider or contract state; withdrawal not shown complete before confirmation; no balance credited on request alone; provider discrepancy creates an exception; sandbox holdings cannot be mistaken for real.

### Phase 8 — CHIWO consumer core (new; approved)

Consumer registration and identity verification; consumer account; sandbox consumer payment and USDC transfer journey of brief §4.1; `chiwo-consumer-workflows.md`.

- **Entry:** Phase 6 approved; R-3 answered (build now, or defer until KONY is validated).
- **Exit:** brief §4.1 runs in sandbox with correct final or unresolved states.
- **Proof:** fees and timing shown before authorization; explicit authorization recorded; device change and recovery require more than the phone number; personal and business contexts never mix.

### Phase 9 — NAM Vault inside CHIWO

- **Entry:** Phases 7 and 8 approved.
- **Exit:** brief §4.2 runs in sandbox.
- **Proof:** payment, USDC transfer and investment order tracked as distinct linked operations; an order is never shown complete because funding succeeded.

### Phase 10 — NAM Vault inside KONY

- **Entry:** Phases 3 and 7 approved.
- **Exit:** brief §4.4 runs in sandbox.
- **Proof:** business-investor context separate from personal; cashier and unauthorized staff cannot view or initiate; collections, unsettled funds and credit are never offered as investable balance.

### Phase 11 — KELO credit core (new; approved)

Applications; eligibility decisions with reason codes and input snapshots; offers with total cost of credit; consent with terms version; disbursement and repayment in the ledger; configurable repayment from inflows; lender adapter. All behind a feature flag (lessons §4).

- **Entry:** Phase 6 approved; **D-5 decided**.
- **Exit:** a sandbox loan runs from application to full repayment.
- **Proof:** every decision stores reason codes and inputs; pricing models (declining balance, capped late charges, flat fee) compute exactly from configuration; a credit limit never appears as cash or USDC; each repayment deduction is posted and visible; feature flag off means no credit endpoint is reachable.

### Phase 12 — KONY commercial depth

Refund workflow; payout fee models and fee preview; automatic sweeps; split settlement; payment links; analytics; public developer documentation, webhook replay, changelog and status page; financing visibility; validated vertical workflows.

- **Entry:** Phase 3 approved (Phase 11 for financing visibility); demand evidence for each vertical workflow (brief §5.5).
- **Exit:** per feature, the definition of done.
- **Proof:** refunds link to the original collection and never exceed it; sweeps and payout batches are idempotent and reconciled; split rules sum exactly to the collected amount in minor units; webhook replay does not duplicate effects; status page exposes no customer data.

### Phase 13 — Production readiness and market expansion

- **Entry:** owner decision to go live for a named product, market and provider; D-4 and D-9 decided; contracts and licences in place.
- **Exit:** brief §16 live-functionality checks; the first `live` mode records are permitted by an explicit, reviewed change.
- **Proof:** independent security review closed; backup restore rehearsed; provider production access verified against real documentation; mainnet chain config added with provenance and verified at startup; reconciliation run against real provider reports; runbooks exercised; `market-readiness-template.md` completed for Kenya.

## 3. First vertical slice (Phase 1)

**Goal:** one sandbox merchant payment travels from an authenticated user to a reconciled ledger entry, with every financial invariant enforced and tested. Thin at every layer, real at every layer except the provider, which is an AORA simulator.

**Path:** identity → tenant → ledger → sandbox payment intent → webhook → reconciliation.

### 3.1 In scope

| Step | What is built | Depth |
|---|---|---|
| Identity | Person and account records; authentication interface with a **sandbox authenticator** (fixed test users, simulated second factor); session | One way to sign in. No registration flow, no recovery |
| Tenant | Canonical business (internal ID, name, country, external identifiers table); one KONY workspace per business; membership with three roles, `admin`, `finance` and `cashier`; tenant scoping in the data layer plus database row-level security; audit events | Businesses and users are created by a seed script, not an onboarding flow |
| Ledger | ADR 0003 core: assets, accounts, journal entries, postings, running balances; balance, immutability and idempotency invariants in the database | One asset (`KES`, exponent from data); a minimal sandbox chart of accounts; no fees |
| Payment intent | `POST /v1/payment-intents` (idempotency key required), `GET /v1/payment-intents/{id}` (status lookup); explicit state machine: `created` → `pending_provider` → `succeeded` \| `failed`, plus `status_unknown` and `reconciliation_required` | One direction: a collection into the merchant's pending-settlement account |
| Provider | Simulator adapter per ADR 0007 with triggers: success, decline, timeout then success, timeout then failure, duplicate webhook, late webhook, amount mismatch, missing settlement line | In-process; no network |
| Webhook | `POST /v1/webhooks/sandbox`: verify signature, store raw payload, deduplicate, enqueue to outbox; worker applies the transition and posts the journal entry in one transaction | One event type family (payment result) |
| Reconciliation | A job that compares the simulator's settlement report with payment intents and ledger entries and writes exceptions: missing internally, missing at provider, amount mismatch, duplicate reference, stuck in `status_unknown` | Detect and record. Operator endpoint to list and inspect. No resolution workflow |
| Cross-cutting | `/v1`, OpenAPI as source of truth, stable error codes, `mode = sandbox` on every record and response, structured logs with no secrets or personal data, PostgreSQL in CI, migrations | As needed by the above |

### 3.2 Out of scope

- Fees, tariffs, taxes, payouts, settlement to a merchant account, refunds, sweeps.
- Any real provider, any provider-specific behaviour, any public callback URL.
- Base, USDC, wallets, contracts, any blockchain dependency.
- KELO, provisioning, CHIWO, NAM.
- Real authentication, registration, recovery, OTP delivery, KYC/KYB.
- Branches, collection points, attribution references.
- Any user interface. The slice is exercised through the API and tests.
- Deployment and infrastructure. Local and CI only.
- Multi-currency. One asset.

### 3.3 Checkpoints inside the phase

Three checkpoints, each with its own short plan approved before code, because each touches auth or money:

1. **1A — Identity, tenant, audit, API conventions, database and test harness.** Includes proving Vitest with NestJS (E-3) and Prisma with row-level security (E-1) before anything else.
2. **1B — Ledger core and outbox.** Invariant tests written first.
3. **1C — Payment intent, simulator, webhook, reconciliation.**

### 3.4 Tests that prove the slice

Written before the code they test.

- **Journal balance:** an unbalanced entry is rejected by the database, not only by the service. Property test over random valid and invalid entries.
- **Immutability:** `UPDATE` and `DELETE` on entries and postings fail at the database.
- **Precision:** amounts are integers end to end; a request with a fractional minor unit or a float-formatted amount is rejected; the asset exponent comes from data.
- **Idempotency:** the same idempotency key with the same body returns the same intent; with a different body returns a conflict; concurrent duplicates create one intent and one journal entry.
- **State machine:** every legal transition succeeds, every illegal one is rejected; a terminal state never changes.
- **Unknown state:** a provider timeout yields `status_unknown`, no ledger posting and no automatic retry; a later webhook or status inquiry resolves it exactly once.
- **Webhook:** bad signature rejected and logged; a duplicate delivers one effect; a late success after a recorded failure goes to `reconciliation_required`, not a silent overwrite.
- **Atomicity:** a crash injected between state change and journal post leaves neither; the outbox handler run twice posts once.
- **Reconciliation:** each simulator discrepancy trigger produces exactly the expected exception type; a clean run produces none; nothing is auto-corrected.
- **Tenant isolation:** user of business A cannot read or create anything for business B through the API; the same query fails at the database when the tenant setting is wrong or absent.
- **Authorization:** unauthenticated requests are rejected; `cashier` can create and read intents but cannot read reconciliation exceptions; operator endpoints need the operator role.
- **Sandbox labelling:** every response and every financial row carries `mode = sandbox`; the database rejects any other value.
- **Hygiene:** no secret patterns in the repository or in captured test logs.
- **End to end:** sign in → create intent → simulator webhook → intent `succeeded` → balanced journal entry in the merchant's pending-settlement account → reconciliation run with zero exceptions.

### 3.5 Slice definition of done

CLAUDE.md definition of done, plus: all §3.4 tests pass in CI against PostgreSQL; the four architecture documents and the OpenAPI file match the code; the end-of-phase report lists exactly what is simulated.

## 4. MVP overlay (owner, 2026-10-13)

The goal is now a sandbox MVP in staging ([mvp-scope.md](../product/mvp-scope.md)). The phases above stand, with these changes:

- **Phase 3 is split.** **3A:** onboarding, branches, staff, M-Pesa collection through the Daraja sandbox, tariffs, history, settlement view, `kony-web`, ops console v1, first staging deployment. **3B:** payouts with fee preview, refunds, developer API (keys, idempotency, signed webhooks with replay). 3B items are pulled forward from Phase 12.
- **Ops console** is a web app from 3A and gains a screen in each later phase.
- **Staging** is redeployed at each phase exit from 3A on; "journey passes in staging" joins the exit criteria.
- **MVP gate** after Phase 11: seeded demo data, health checks, reset runbook, and every journey in mvp-scope §1 passing in staging.
- **Phase 12** keeps only what the MVP does not need. **Phase 13** is unchanged and not part of the MVP.
- **Phase 2** uses an SMS provider sandbox for one-time codes and a transaction PIN for step-up, behind `AuthProvider`.
- **Phase 5** may submit Base Sepolia transactions through the development signer (ADR 0009 interim ruling).
- Each phase has a plan in `docs/plans/phase-N.md` and progress is tracked in `docs/progress.md`.
