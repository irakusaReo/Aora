# Phase 3 Plan — KONY core (web)

- **Status:** scope approved by the owner on 2026-10-13 ("Phase 3 is approved as defined in mvp-scope.md"). Proceeding without waiting for plan approval.
- **Scope source:** [mvp-scope.md](../product/mvp-scope.md) §3 (checkpoints 3A to 3D) and journeys J3 to J7; [delivery-plan.md](../architecture/delivery-plan.md) Phase 3 proof list; lessons §1, §5, §6, §7.
- **Branch:** `phase-3`. Merge to `main` only when CI passes, every Vercel variable the code needs exists, and new migrations are already on staging. All migrations in this phase are expand-only.
- **Test discipline:** tests strictly first for ledger invariants, state machines, idempotency and tenant isolation. Other code may have tests written alongside.

## Checkpoints

| | Contents | Needs from the owner |
|---|---|---|
| **3A-1** | Tariffs and fees; gross, fee and net on every collection; tier limits; branches; attribution reference | Nothing |
| **3A-2** | Merchant onboarding with ADR 0012 matching and a review queue; staff invitation by email; operator API (exceptions with audited resolution, lookups, audit trail) | Nothing |
| **3A-3** | `packages/api-client`, `packages/ui`, `apps/kony-web`, `apps/internal-ops` | Approval to create two Vercel projects and to change `CLERK_AUTHORIZED_PARTIES` |
| **3B** | Provider registry; `mpesa` rail; Daraja STK push adapter, callback intake and status query; adapter contract suite | Daraja sandbox credentials; `DARAJA_CALLBACK_SECRET` |
| **3C** | Settlement batches and view; payout recipients with confirmation; payouts with fee preview (Daraja B2C); refunds | Daraja B2C test credentials; approval to download the sandbox certificate |
| **3D** | API keys; `/v1` access by key; signed outbound webhooks with delivery log and replay | `WEBHOOK_SIGNING_PRIVATE_KEY` |

Everything is built and tested against the simulator first. A real Daraja call is made only when the owner replies "done" to the credential request. Whatever is still simulated at the end of the phase is reported as simulated.

## 1. Decisions taken in this plan

| # | Decision | Why | Recorded in |
|---|---|---|---|
| P3-1 | **The fee is fixed when the collection is created**, from the tariff version in effect at that instant, and stored on the intent with the version id | The payer is quoted an amount; a tariff change between creation and success must not change what the merchant was shown. Deterministic across a tariff change | ADR 0021 |
| P3-2 | **Fee formula:** `fee = clamp(flat + amount × bps / 10 000, min, cap)`, integer arithmetic on minor units, rounding half up, per band chosen by amount. `net = gross − fee` exactly | Covers free bands, percentage, flat, tiered and capped pricing as data (lessons §1) | ADR 0021 |
| P3-3 | **Sandbox tariff values are obviously fake** (for example 1.00% capped at KES 200.00, free under KES 100.00) | Real tariffs are unverified (X-4). They are data, replaced without a code change | ADR 0021 |
| P3-4 | **Staff are invited by email**; the invitee accepts explicitly after signing in with that address. The old invite-by-phone route is removed | Clerk identifies people by email; a phone number no longer proves anything at sign-in | ADR 0019 note, this plan |
| P3-5 | **Daraja callbacks are authenticated by a per-operation token in the callback URL** (HMAC of the operation id with `DARAJA_CALLBACK_SECRET`), and **a callback is never trusted for money**: a success callback triggers a status query, and only the query result posts to the ledger | Daraja documents no callback signature, only source IP addresses. CLAUDE.md requires a signature check | ADR 0022 |
| P3-6 | **Amounts on the `mpesa` rail must be whole shillings.** Callback amounts are read from the raw text as decimal strings, never as JSON floats | Daraja's `Amount` is a whole number in the request and a decimal in the callback | ADR 0022 |
| P3-7 | **A payout goes only to a confirmed recipient.** Confirming means entering the number twice with a fresh PIN step-up; it is audited. This proves intent, not ownership of the number | Owner's instruction for O-11. Daraja B2C returns the recipient's name only after the money has moved | open-questions O-11 |
| P3-8 | **A payout reserves the money first.** Amount plus fee move from "available" to "payouts in flight" when the payout is created; success releases them to the provider and to fee revenue; failure posts a compensating entry | An unknown payout must never be spendable twice, and never retried automatically | ADR 0021 |
| P3-9 | **Settlement in the sandbox is an AORA job**: collections that appear in the provider's settlement report move from "collections pending" to "available" in one batch per workspace and asset | Sandbox assumption M-4 (AORA-controlled collection account), labelled on every view | ADR 0021 |
| P3-10 | **Refund fee policy is tariff data** (operation `refund`). The sandbox tariff charges nothing and does not return the original collection fee | No verified provider or legal rule yet | ADR 0021 |
| P3-11 | **Collection points with parent and child are not built in this phase.** A branch and a free-text attribution reference are | mvp-scope 3A lists branches, not collection points. Recorded as open question R-9 | open-questions |
| P3-12 | **API keys act with a fixed scope, not a role**: `collect` or `full`. A key can never perform an action that needs a PIN step-up (payouts, refunds, member changes, recipient confirmation) | A key has no human behind it to step up. Rule 12 | ADR 0023 |
| P3-13 | **Outbound webhooks are signed with Ed25519** over `timestamp.body`; the public key is served at `/v1/webhook-signing-key`. HTTPS only; private and loopback addresses are refused when deployed | M-2: one platform key pair in the secret store, no per-merchant secret in the database | ADR 0023 |

## 2. Data model

One migration per checkpoint, expand-only. Every table carries `mode` (`sandbox` only) and, where tenant-owned, `tenant_id` with row-level security.

**3A-1 `…000600_tariffs_branches`**
- `pricing.tariff_version(id, tariff_key, operation, rail, country, asset_code, version, effective_from, effective_to, rounding, created_at)`; unique `(tariff_key, version)`; no two versions of a key overlap in time (exclusion constraint). Immutable once effective, except closing `effective_to`.
- `pricing.tariff_band(id, tariff_version_id, min_amount, max_amount, bps, flat_amount, min_fee, max_fee)`; bands of one version do not overlap.
- `tenancy.tier_limit(id, tier, asset_code, version, effective_from, effective_to, per_transaction_max, daily_collection_max, daily_payout_max)`.
- `tenancy.workspace` gains `tier` (default `tier_0`).
- `tenancy.branch(id, tenant_id, name, status)`; `tenancy.membership` gains `branch_id` (required in the application for cashiers).
- `payments.payment_intent` gains `fee_amount`, `net_amount`, `tariff_version_id`, `branch_id`, `reference`, `rail`. `net_amount + fee_amount = amount` by check constraint; all immutable after insert.
- `ledger.account.type` adds `fee_revenue` (platform), `merchant_available`, `merchant_payouts_in_flight`.

**3A-2 `…000700_onboarding`**
- `business.onboarding_application(id, applicant_account_id, idempotency_key, kind, name, country, registration_type, registration_value, location, status, business_id, tenant_id, decided_by, decision_reason)`.
- `business.match_decision(id, application_id, rule, normalisation_version, inputs, outcome, matched_business_id)`; append-only.
- `tenancy.invitation(id, tenant_id, email_lower, role, branch_id, status, invited_by, accepted_by, expires_at)`; one open invitation per workspace and address.
- `payments.reconciliation_exception` gains `resolved_at`, `resolved_by`, `resolution`, `resolution_reason`; status adds `resolved`.

**3B `…000800_mpesa`**
- `payments.provider_operation(id, provider, operation_type, operation_id, tenant_id, external_ref, external_ref_2, msisdn, raw_result_code, receipt, created_at)`: the adapter-owned record (ADR 0007). The payer's number lives here, never on the intent.
- `sim.sim_transaction` gains `kind` (`collection`, `payout`, `refund`).

**3C `…000900_settlement_payouts_refunds`**
- `payments.settlement_batch(id, tenant_id, asset_code, provider, gross_amount, fee_amount, net_amount, intent_count, created_at)`; `payment_intent.settlement_batch_id`.
- `payments.payout_recipient(id, tenant_id, rail, country, label, status, confirmed_at, confirmed_by)`; number in `provider_operation`-style private column readable only by the platform role, shown masked.
- `payments.payout(id, tenant_id, idempotency_key, request_hash, recipient_id, amount, fee_amount, tariff_version_id, asset_code, provider, status, …)` and `payout_transition`.
- `payments.refund(id, tenant_id, idempotency_key, request_hash, intent_id, amount, status, …)` and `refund_transition`. A trigger refuses a refund that would take the total refunded above the collection's amount.

**3D `…001000_developer`**
- `developer.api_key(id, tenant_id, name, prefix, key_hash, scope, created_by, revoked_at, last_used_at)`.
- `developer.webhook_endpoint(id, tenant_id, url, event_types, status)`.
- `developer.webhook_event(id, tenant_id, type, payload)`; `developer.webhook_delivery(id, event_id, endpoint_id, attempt, status, response_status, replay_of)`.

## 3. State machines

All follow the payment-intent pattern: a `TRANSITIONS` table in code, a guarded `update … where status = from`, an append-only transition row and an audit event per change.

- **Onboarding application:** `submitted → approved | needs_review | rejected`; `needs_review → approved | rejected`. `approved` creates the business, workspace, admin membership and ledger accounts in the same transaction, exactly once.
- **Invitation:** `pending → accepted | revoked | expired`.
- **Payment intent:** unchanged (Phase 1).
- **Payout:** `created → reserved → submitting → pending_provider | succeeded | failed | status_unknown`; `pending_provider | status_unknown → succeeded | failed | reconciliation_required`; `failed → released` is the compensating entry. `reserved` and `submitting` are committed before the provider is called; `status_unknown` is never resubmitted.
- **Refund:** `created → submitting → pending_provider | succeeded | failed | status_unknown → …` as for payouts, without the reservation.
- **Webhook delivery:** `pending → delivered | failed`; `failed → pending` on retry until attempts are exhausted, then `dead`. A replay is a new delivery linked by `replay_of`.

## 4. Ledger entries

| Event | Debit | Credit |
|---|---|---|
| Collection succeeds | `provider_clearing` gross | `merchant_collections_pending` net; `fee_revenue` fee |
| Settlement batch | `merchant_collections_pending` net | `merchant_available` net |
| Payout reserved | `merchant_available` amount + fee | `merchant_payouts_in_flight` amount + fee |
| Payout succeeds | `merchant_payouts_in_flight` amount + fee | `provider_clearing` amount; `fee_revenue` fee |
| Payout fails | reversal of the reservation entry | |
| Refund succeeds | `merchant_available`, or `merchant_collections_pending` if not yet settled | `provider_clearing` |

Balances stay distinct types and are never summed (rule 5).

## 5. Endpoints

Workspace routes need `Aora-Workspace-Id` and a permission; (S) marks PIN step-up.

- **3A-1:** `GET /v1/tariffs/quote` · `GET|POST /v1/workspace/branches` · `PATCH /v1/workspace/branches/{id}` · `PATCH /v1/workspace/members/{id}` gains `branch_id` · `GET /v1/payment-intents` (list with gross, fee, net; cashiers see their branch only) · `POST /v1/payment-intents` gains `branch_id`, `reference`, `rail`, `payer_phone`.
- **3A-2:** `POST /v1/onboarding/applications` · `GET /v1/onboarding/applications/{id}` · `GET|POST /v1/workspace/invitations` (S on POST) · `DELETE /v1/workspace/invitations/{id}` (S) · `GET /v1/me/invitations` · `POST /v1/me/invitations/{id}/accept` · `GET /v1/workspace` · operator: `GET /v1/ops/onboarding-reviews`, `POST /v1/ops/onboarding-reviews/{id}/decision`, `POST /v1/ops/reconciliation-exceptions/{id}/resolution`, `GET /v1/ops/accounts`, `GET /v1/ops/workspaces`, `GET /v1/ops/audit-events`.
- **3B:** `POST /v1/webhooks/daraja/{kind}/{operationId}/{token}`.
- **3C:** `GET /v1/settlements` · `GET|POST /v1/payout-recipients` · `POST /v1/payout-recipients/{id}/confirmation` (S) · `POST /v1/payouts/preview` · `POST /v1/payouts` (S) · `GET /v1/payouts`, `GET /v1/payouts/{id}` · `POST /v1/payment-intents/{id}/refunds` (S) · `GET /v1/refunds/{id}` · cron: `GET /v1/internal/cron/settlement`.
- **3D:** `GET|POST /v1/api-keys` (S on POST) · `DELETE /v1/api-keys/{id}` (S) · `GET|POST /v1/webhook-endpoints` · `GET /v1/webhook-deliveries` · `POST /v1/webhook-deliveries/{id}/replay` · `GET /v1/webhook-signing-key` (public).

`docs/api/openapi.yaml` is updated in the same commit as each route; the contract test enforces it.

## 6. Tests (the proof)

Written first unless marked (alongside).

- **Tariffs:** property test over random amounts and bands: `net + fee = gross`, fee within `[min, cap]`, monotone in amount inside a band. Free band, percentage, flat and cap cases to the minor unit. A new tariff version changes the fee of later collections only, with no code change. Overlapping versions and overlapping bands are refused by the database.
- **Ledger:** collection posts three balanced postings; trial balance is zero after every scenario; new account types cannot go negative.
- **Tier limits:** over-limit collection refused from configuration; raising the limit by inserting a row admits it.
- **Branches:** a cashier cannot list or read another branch's collections; tenant isolation tests extended to every new table, at API and database level.
- **Onboarding:** each ADR 0012 rule (1 to 4) with the decision stored; ambiguous goes to review and creates nothing; approving twice creates one workspace; concurrent identical applications create one business.
- **Invitations:** only the invited address can accept; accept twice gives one membership; revoked and expired are refused; another workspace's invitation is invisible.
- **Exceptions:** each type is listed, inspected and resolved with a reason; resolving twice is refused; operator role required; one audit event each.
- **Daraja adapter:** the shared adapter contract suite runs against the simulator and against the Daraja adapter talking to a local stub that replays the documented sample payloads. Timeout gives `status_unknown` and a query, never a second push. Duplicate and forged callbacks. A callback alone never posts to the ledger. Sub-shilling amount refused.
- **Payouts:** state-machine table test; idempotent create; previewed fee equals charged fee, and a stale preview is refused; needs step-up and `finance` or `admin`; unconfirmed recipient refused; insufficient available balance refused by the ledger; unknown is never resubmitted; failure restores the balance exactly.
- **Refunds:** cannot exceed the original across concurrent requests; compensating entry; idempotent.
- **Developer API:** key shown once and stored only as a hash; revoked key refused; a key cannot reach a step-up route; signature verifies with the published key and fails on a changed body; replay causes no second effect on a receiver that deduplicates by event id; delivery to a private address refused.
- **Cross-cutting:** route × role matrix, OpenAPI contract, hygiene and `.env.example` tests extended.
- **Web (alongside):** typecheck, lint and a build of each app in CI; every page renders the sandbox banner (component test).

## 7. Files

- `services/api/src/modules/pricing/`, `onboarding/`, `developer/`; additions to `tenancy/`, `payments/` (`providers.ts`, `daraja.ts`, `settlement.service.ts`, `payouts.service.ts`, `refunds.service.ts`), `business/`.
- `services/api/prisma/migrations/…000600` to `…001000`.
- `packages/api-client`, `packages/ui`, `apps/kony-web`, `apps/internal-ops`.
- `docs/adr/0021-fees-settlement-and-payout-ledger.md`, `0022-daraja-integration.md`, `0023-developer-api.md`; `docs/providers/daraja.md` (what was read, with source and date).

## 8. Not in this phase

Airtel, MTN and bank rails (Phase 4); KELO; USDC; mobile apps; collection points with parent and child (P3-11); automatic sweeps; split settlement; a public developer portal and status page; KYB against a real provider (sandbox adapter with scripted outcomes only, D-8).
