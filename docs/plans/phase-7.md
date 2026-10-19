# Phase 7 Plan — CHIWO (web)

- **Status:** done (2026-10-19): 7A (PR #25), 7B (PR #26) and 7C (PR #27) merged and on staging. `chiwo-web` deployment waits for the owner's approval. Run mode of 2026-10-18 (CLAUDE.md): no approval stop between phases.
- **Scope source:** [mvp-scope.md](../product/mvp-scope.md) §3 (checkpoints 7A, 7B, 7C), journeys J12 and J13 (CHIWO side); brief §2.1, §4.1, §4.2, §7.1 ("a person may act personally in CHIWO and on behalf of a company in KONY; these must not be conflated"), §7.2; O-11 (c) confirmed-recipient rule; O-14 (Daraja test number only).
- **Branch:** `phase-7`. Merge rules as before: CI green on the head commit, every Vercel variable the code needs exists, new migrations already on staging (expand-only), then staging health and all cron jobs confirmed.
- **Test discipline:** tests strictly first for every state machine (merchant payment, transfer, payment request, consumer withdrawal, personal NAM order), every ledger posting, idempotency, and consumer isolation (one consumer never sees another's rows; personal and business contexts never meet).
- **Chain:** staging's chain stays off until the owner funds the sandbox wallet. 7B and 7C are built and tested on the local chain; on staging they answer `chain_unavailable` until then. 7A needs no chain.

## Checkpoints

| | Contents | Needs from the owner |
|---|---|---|
| **7A** | Consumer sign-up and personal context; merchant pay codes in KONY; pay a KONY merchant by M-Pesa (Daraja sandbox, test number only) with amount, fees and timing shown before authorising; consumer receipts and activity; `apps/chiwo-web` (sign-up, pay, activity, receipt) | Approval to create the `chiwo-web` Vercel project and add its origin to `CLERK_AUTHORIZED_PARTIES` on `aora-api` (a Vercel Production setting), asked once 7A is ready to deploy |
| **7B** | Personal USDC: receive (registered own address, from another CHIWO user), send (to another CHIWO user by phone number, or on-chain to a registered address), payment requests that cannot be paid twice, receipts for all of it | Nothing (local chain) |
| **7C** | NAM in `chiwo-web`: personal investor profile, orders from the personal USDC balance, holding, redemption; the KONY and CHIWO profiles never meet | Nothing (local chain) |

## 1. Decisions taken in this plan

| # | Decision | Why | Recorded in |
|---|---|---|---|
| P7-1 | **Personal context = a CHIWO consumer profile** (`chiwo.consumer`, one per user account), created by sign-up: a signed-in AORA account, a phone number on file (`PUT /v1/me/phone`), and consent to `chiwo_terms` (versioned). CHIWO routes live under `/v1/chiwo/*`, act for the signed-in account only, and **refuse any request that carries `Aora-Workspace-Id`** (`context_mismatch`). Workspace routes never read consumer rows. Membership of a workspace grants nothing in CHIWO and vice versa | Brief §7.1; J12 "personal and business contexts never mix" | ADR 0002 addendum |
| P7-2 | **Consumer isolation in the database:** every `chiwo.*` table carries `consumer_account_id` with the `consumer_isolation` policy used by KELO (`app.account_id` set by `withConsumer`); no tenant policy, so the tenant role sees none of it. Ledger accounts gain a nullable `consumer_account_id` (at most one of tenant and consumer), so a consumer's balances are their own accounts, never a platform account with a qualifier | Rule 5 and rule 12; reuses Phase 4's barrier | ADR 0003 addendum |
| P7-3 | **Merchant pay codes:** `tenancy.pay_code` (8 characters from an unambiguous alphabet, unique, optional branch). A KONY admin creates and deactivates them; any CHIWO consumer may look one up and sees only the trading name and the sandbox label. Lookups are rate-limited per account | The consumer needs a way to name a merchant without seeing workspace data | this plan |
| P7-4 | **A CHIWO merchant payment is the merchant's collection**: a payment intent in the merchant's tenant with purpose `collection` and channel `chiwo`, so collections, gross/fee/net, settlement, refunds, webhooks and reconciliation work unchanged. The consumer side is `chiwo.merchant_payment` (consumer, pay code, intent, status mirrored from the intent through the outbox). The merchant's per-person "payment received" email is not sent for `chiwo` intents (no one at the merchant created it); the consumer gets a receipt email instead | One money path; no second collection model | ADR 0021 addendum |
| P7-5 | **Fees and timing before authorising** (brief §4.1, J12): `POST /v1/chiwo/payments/quote` returns amount, the fee the consumer pays (none: the tariff charges the merchant), the total, the rail and the expected timing as data (`chiwo.timing_note`, versioned). The payment request must echo the quote's amount and fee; a stale quote is refused (`fee_changed`) | J12 exit test | this plan |
| P7-6 | **Sandbox payer number (O-14):** the STK push goes to Daraja's test number, never the consumer's own number, and every screen says so. When Daraja is not configured the simulator serves the rail, labelled simulated | O-14 open; ADR 0022 | — |
| P7-7 | **Consumer limits are data** (`chiwo.consumer_limit`: per-payment and per-day maxima per asset and operation, with effective dates), checked inside the creating transaction under a per-consumer lock | CLAUDE.md: limits are versioned configuration | — |
| P7-8 | **Personal USDC is a ledger claim on AORA's sandbox wallet**, exactly like the KONY treasury: `consumer_usdc_available` and `consumer_usdc_withdrawals_in_flight`. A transfer between CHIWO users is a ledger move (no chain transaction, labelled "AORA transfer, sandbox"); an on-chain send is a withdrawal from AORA's wallet through a chain operation | ADR 0009/0010 interim: one AORA-controlled testnet wallet; no per-user keys | ADR 0021 addendum |
| P7-9 | **Receiving on-chain:** the consumer registers their own Base address by signature (the 5C challenge, extended to consumers); confirmed deposits from it are credited to them under the confirmation policy; anything else stays unattributed for an operator, as in 5C | Reuses the proven 5C path; no address of AORA's per user | ADR 0004 addendum |
| P7-10 | **Sending to a person by phone number (O-11 c):** the recipient must be a CHIWO consumer; before the first transfer to them the sender sees their masked display name and confirms with a PIN step-up; the recipient is then recorded as confirmed for that sender. Every transfer needs step-up | O-11 (c) | — |
| P7-11 | **On-chain sends** go only to an address the sender registered by signature (their own), with step-up, a per-day limit (P7-7) and the never-resubmit rule of 5A. No second approver: a person acts alone for themself; the two-person rule is a business control | Rule 6; brief §7.2 is about workspaces | — |
| P7-12 | **Payment requests** are USDC only (no person-to-person KES rail exists). A request names a payer (a CHIWO consumer by phone) or is open to anyone with its link; it is paid by a transfer; **a request cannot be paid twice**: the pay step locks the row, requires `open`, and `chiwo.transfer.request_id` is unique. Requests expire after a configured period and can be cancelled by the requester | J12 exit test | — |
| P7-13 | **Receipts** are views over merchant payments, transfers, withdrawals and requests: parties masked, amount, fee, status, time, reference, sandbox label; emailed on success through the notifications module (masked, no action links) | J12; ADR 0020 | — |
| P7-14 | **Personal NAM (7C):** `nam.investor_profile(kind personal, person_id)`; orders funded from `consumer_usdc_available` with personal-capacity consent to `nam_vault_disclosure`; `consumer_nam_funding_pending` and `consumer_nam_holding`. The NAM service is generalised over the profile's owner; a workspace profile and a personal profile of the same person are separate rows, holdings and ledger accounts | J13 | ADR 0015 addendum |

## 2. Data model

**7A (`…20261019000100_chiwo`, expand-only):**
- `chiwo.consumer(account_id pk → identity.user_account, consent_id, status active|closed, created_at)`.
- `tenancy.pay_code(code pk, tenant_id, branch_id null, status active|inactive, created_by, created_at)`; tenant-isolated, readable by the platform role for lookups.
- `chiwo.consumer_limit(id, operation, asset_code, per_payment_max, per_day_max, effective_from)`; seeded KES merchant-payment limits.
- `chiwo.timing_note(rail, text, effective_from)`.
- `payments.payment_intent.channel` (`kony` default | `chiwo`).
- `chiwo.merchant_payment(id, consumer_account_id, idempotency_key, request_hash, pay_code, tenant_id, amount, asset_code, intent_id unique, status, created_at, updated_at)`; status `submitted → succeeded | failed | being_checked`, mirrored from the intent (`status_unknown`, `pending_provider` → `being_checked`; `reconciliation_required` → `being_checked`).
- `consent.terms_document` row `chiwo_terms` v1.
- (Moved to 7B, where the first consumer balance appears: `ledger.account.consumer_account_id`.)

**7B (`…20261019000200_chiwo_usdc`):** `ledger.account.consumer_account_id` (null; at most one of tenant and consumer; unique per consumer); account types `consumer_usdc_available`, `consumer_usdc_withdrawals_in_flight`; `chain.address_challenge` and `chain.registered_address` gain `consumer_account_id` (exactly one owner); `chain.withdrawal` likewise; `chiwo.recipient(sender, recipient, confirmed_at)`; `chiwo.transfer(id, sender, recipient, amount, asset_code, request_id unique null, idempotency_key, status posted)`; `chiwo.payment_request(id, requester, payer null, amount, asset_code, note, status open|paid|cancelled|expired, expires_at, paid_transfer_id)`; consumer USDC limits rows.

**7C (`…20261019000300_chiwo_nam`):** account types `consumer_nam_funding_pending`, `consumer_nam_holding`; `nam.vault_order`, `nam.redemption`, `nam.holding`, `nam.holding_change` gain `consumer_account_id` with the consumer policy.

## 3. State machines

- **Merchant payment:** `submitted` → `succeeded` | `failed` | `being_checked`; `being_checked` → `succeeded` | `failed` | `reconciliation_required`. Driven only by the intent's own machine (payments module), never by the consumer.
- **Transfer (7B):** single transaction: idempotent request → limits → ledger move → `posted`. No intermediate state, because nothing leaves AORA's ledger.
- **Consumer withdrawal (7B):** the 5C withdrawal machine without the approval step: `reserved` → `submitted` (chain operation) → `completed` | `failed` (reservation released) | `reconciliation_required` (reservation kept, exception opened).
- **Payment request (7B):** `open` → `paid` (with the transfer, in one transaction) | `cancelled` | `expired`. Final states have no exit.
- **Personal NAM order and redemption (7C):** the Phase 6 machines, unchanged.

## 4. Endpoints (personal routes; no `Aora-Workspace-Id`)

7A: `GET /v1/chiwo/me`, `POST /v1/chiwo/sign-up` (`{terms_version}`), `GET /v1/chiwo/merchants/{code}`, `POST /v1/chiwo/payments/quote`, `POST /v1/chiwo/payments` (Idempotency-Key, step-up not required: the payer approves on the handset), `GET /v1/chiwo/payments`, `GET /v1/chiwo/payments/{id}`, `GET /v1/chiwo/activity`, `GET /v1/chiwo/receipts/{kind}/{id}`. KONY: `GET/POST /v1/pay-codes`, `POST /v1/pay-codes/{code}/deactivate` (workspace, admin).
7B: `GET /v1/chiwo/usdc`, address challenge and registration, `GET /v1/chiwo/recipients/lookup`, `POST /v1/chiwo/transfers`, `POST /v1/chiwo/withdrawals`, `POST/GET /v1/chiwo/requests`, `POST /v1/chiwo/requests/{id}/pay`, `POST /v1/chiwo/requests/{id}/cancel`.
7C: `GET /v1/chiwo/nam`, `POST /v1/chiwo/nam/orders`, `POST /v1/chiwo/nam/redemptions`, lists.
All in `docs/api/openapi.yaml`; personal routes go in the permissions test as consumer routes.

## 5. Tests (first where the discipline requires it)

7A: sign-up needs a phone and the current terms version; CHIWO routes refuse `Aora-Workspace-Id`; a workspace member who is not signed up cannot use CHIWO; pay-code lookup reveals only the trading name; a payment to an inactive code is refused; the quote's fee and amount must match; the merchant sees a collection with gross, fee and net from the tariff; the consumer's status follows the intent through success, failure and `status_unknown`; a repeat with the same Idempotency-Key replays, a different body is refused; concurrent duplicates make one intent; limits refuse over-limit payments; consumer isolation of every `chiwo` table and route; no merchant "payment received" email for a CHIWO payment, one consumer receipt email on success.
7B: transfer ledger exact and idempotent; recipient confirmation before the first transfer; a request cannot be paid twice (sequential and concurrent); expired or cancelled requests refuse payment; deposits from a consumer's registered address credit only that consumer after confirmation; withdrawal reservation, failure release, unknown kept; three-way reconciliation still clean with consumer flows.
7C: personal order and redemption; personal and business profiles of the same person stay separate; cashier and other consumers see nothing; the no-yield scan covers chiwo-web.

## 6. Files

`services/api/src/modules/chiwo/` (`consumer.service.ts`, `merchant-payments.service.ts`, `chiwo.controller.ts`, then `usdc.service.ts`, `requests.service.ts`), `services/api/src/modules/tenancy/pay-codes.*`, migrations, `services/api/test/chiwo-*.test.ts`, `apps/chiwo-web/` (Next.js, same shape as `kelo-web`), `apps/kony-web` pay-code page, docs (ADR 0002, 0003, 0021 addenda, openapi, `docs/product/chiwo-consumer-workflows.md`).
