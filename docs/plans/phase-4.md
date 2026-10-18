# Phase 4 Plan — KELO commerce

- **Status:** in progress. Run mode of 2026-10-18 (CLAUDE.md): the owner approved continuing through the MVP phases without plan approval stops.
- **Scope source:** [mvp-scope.md](../product/mvp-scope.md) §3 (checkpoints 4A to 4C), journeys K1 and K4; brief §4.5, §4.6, §13.4; [ADR 0008](../adr/0008-kelo-to-kony-provisioning.md), [ADR 0017](../adr/0017-kelo-marketplace-domain.md), [ADR 0018](../adr/0018-plan-types-and-credit-pricing.md); [kelo-experience.md](../product/kelo-experience.md).
- **Branch:** `phase-4`. Merge to `main` only when CI passes, every Vercel variable the code needs exists, and new migrations are already on staging. All migrations are expand-only.
- **Test discipline:** tests strictly first for state machines (enlistment, provisioning, listing, order, layaway plan), idempotency, tenant and consumer isolation, stock and capacity reservation, and ledger postings.
- **No credit.** Nothing in this phase extends credit or needs the `kelo_credit` flag. The flag exists from 4B, off, and gates nothing yet except the absence of credit plans.

## Checkpoints

| | Contents | Needs from the owner |
|---|---|---|
| **4A** | KELO module; taxonomy (twelve sandbox categories); store enlistment and vetting; ADR 0008 provisioning (exactly one workspace, backfill, recovery, restrictions); catalogue with three listing types, stock and capacity; prohibited items; moderation queue; image storage adapter (simulator, then Vercel Blob); KELO section in `kony-web`; review queues in `internal-ops` | The Vercel Blob store (public), requested 2026-10-18. Until then the image adapter is the simulator |
| **4B** | `apps/kelo-web` (public browse and search, listing page with plan selector, sign-in, purchases hub shell); quotes for quote-based listings; `kelo_credit` flag (off) | Approval to create the Vercel project `kelo-web` and add its origin to `CLERK_AUTHORIZED_PARTIES` |
| **4C** | Plan templates, category plan rules and listing plan offers (layaway only); schedule engine; layaway orders with reservation; instalment collection by M-Pesa (Daraja sandbox) into "layaway funds held"; fulfilment evidence; merchant settlement on fulfilment less the discount fee; cancellation refunds by configured rule; journey K4 | Nothing |

## 1. Decisions taken in this plan

| # | Decision | Why | Recorded in |
|---|---|---|---|
| P4-1 | **Twelve sandbox categories** as seed data: electronics and phones; home appliances; furniture; solar home systems; motorbikes; holidays and travel; courses and exams; optical; dental; medical-cosmetic; moving; home repairs and installation. Derived from the categories the brief and ADRs name; the owner may replace them with a data change | The list is not recorded anywhere in the repository | open-questions O-15 |
| P4-2 | **Two ways in, one workflow.** A new merchant enlists from KELO (no workspace yet); an existing KONY admin enlists their workspace's business. Both create a `store` that, once vetting approves it, runs the same provisioning workflow | Brief §4.6 step 2: "receives *or is linked to* a KONY workspace" | ADR 0008 addendum |
| P4-3 | **Business resolution reuses ADR 0012 matching** (extracted from onboarding into one function). `same` with the applicant already admin of that business's workspace links it; `same` with anyone else, or `review`, stops at `failed_needs_review`; `new` creates the business | A KELO enlistment must never hand an existing workspace to a second person | ADR 0008 addendum |
| P4-4 | **Restrictions are a closed list copied to the workspace:** `payouts_suspended`, `listing_suspended`. A workspace restriction is enforced server-side (payouts refuse with `workspace_restricted`); only an operator lifts it, with an audited reason | Brief §13.4 "restricted merchants remain restricted" needs a testable meaning | ADR 0008 addendum |
| P4-5 | **Vetting is an operator decision against the category's requirements** (configuration per category). The sandbox has no KYB provider (D-8): the operator attests each requirement, and the attestation is audited | Simulator only for ID verification (owner, 2026-10-18) | this plan |
| P4-6 | **Consumer-owned rows get their own row-level barrier.** `Database.withConsumer(accountId)` sets `app.account_id` with transaction scope; consumer tables have a `consumer_isolation` policy. Orders carry both `tenant_id` and `consumer_account_id`; the merchant policy and the consumer policy are separate | ADR 0017: consumer isolation needs its own tests, beside tenant isolation; E-1's second barrier applies to people too | ADR 0017 addendum |
| P4-7 | **Images never pass through the API.** The API issues a short-lived client upload token (content types `image/jpeg`, `image/png`, `image/webp`; at most 4 MB; random suffix; path under the listing), the browser uploads to Vercel Blob directly, and the API then checks the blob's size and type before attaching it. A public store, because product images are public content and private blobs must be streamed through a function | ADR 0013 4.5 MB body limit; vercel.com/docs/vercel-blob (read 2026-10-18) | ADR 0017 addendum |
| P4-8 | **Search is PostgreSQL full-text search** over published listings only, with a generated `tsvector` and a GIN index | ADR 0017 | — |
| P4-9 | **A layaway instalment is a payment intent with purpose `kelo_layaway`**, owned by the merchant's workspace for routing and limits, but posting to the platform's "layaway funds held" liability, never to the merchant's collections. On fulfilment one entry moves the order's held funds to the merchant (net of the discount fee) and to KELO fee revenue | ADR 0017: held funds are a liability to the consumer until fulfilment | ADR 0021 addendum |
| P4-10 | **Cancellation refunds** follow the category's refund rule (percentage returned, cancellation fee with a cap, and the rule for a passed session date). The refund goes out by the existing refund path (simulator; Daraja reversal is X-14) | ADR 0018 | — |
| P4-12 | **An instalment is claimed before its payment is created** (`submitting`, keyed by the request's Idempotency-Key). Payment creation runs in its own transaction, so without the claim two concurrent requests could each push a payment | One STK push per instalment attempt | ADR 0017 addendum |
| P4-13 | **A retained cancellation fee is KELO income in the sandbox** | Who keeps it in production is commercial and the owner's | ADR 0021 addendum |
| P4-14 | **On the M-Pesa rail the layaway checkout offers Safaricom's test number only, and a labelled simulator choice.** The test number cancels every push (1032), so a full layaway can only be completed on staging with the simulator | No real number until O-14 is decided | this plan |
| P4-11 | **Fulfilment evidence per category:** consumer confirmation, or the merchant's proof of delivery. A scheduled service is fulfilled when its session starts | ADR 0017 | — |

## 2. Data model

New schema `kelo`. Every table carries `mode` (`sandbox` only). Merchant-side tables carry `tenant_id` with row-level security; consumer-side tables carry `consumer_account_id` with the consumer policy.

**4A `…20261018000100_kelo_catalogue`**
- `kelo.category(id, parent_id, slug, name, version, effective_from, effective_to, listing_types[], vetting_requirements jsonb, restricted bool, fulfilment_evidence, prohibited_terms text[])`. Twelve rows of seed data.
- `kelo.store(id, applicant_account_id, idempotency_key, request_hash, kind, name, country, registration_*, location, verification, existing_tenant_id, status, tenant_id, business_id, restrictions text[], decided_by, decision_reason)`. Status `submitted → approved | rejected`; contents immutable; decision final.
- `kelo.store_category(store_id, category_id, attested jsonb)` — categories the store may list in, set at approval.
- `kelo.provisioning(id, store_id unique, status, business_id, tenant_id, admin_account_id, attempts, last_error, reason)`; status per ADR 0008. Unique `store_id`; unique `tenant_id` among completed records (one KELO link per workspace).
- `tenancy.workspace_restriction(id, tenant_id, kind, source, reason, lifted_at, lifted_by)`; one active row per `(tenant_id, kind)`.
- `kelo.listing(id, tenant_id, store_id, category_id, type, title, description, currency, status, search tsvector generated, published_at)`; status `draft → in_review → published | rejected`, `published → suspended | in_review`.
- `kelo.listing_variant(id, tenant_id, listing_id, name, price_minor, stock_on_hand, stock_reserved)`; `check (stock_reserved between 0 and stock_on_hand)`.
- `kelo.listing_session(id, tenant_id, listing_id, starts_at, price_minor, capacity, reserved)`; `check (reserved between 0 and capacity)`.
- `kelo.listing_image(id, tenant_id, listing_id, pathname, url, content_type, size_bytes, status)`.
- `kelo.moderation_decision(id, listing_id, outcome, reason, decided_by)`; append-only.

**4B `…kelo_quotes`**
- `kelo.quote_request(id, listing_id, tenant_id, consumer_account_id, details, status)`; `kelo.quote(id, request_id, tenant_id, price_minor, currency, expires_at, status)`.
- `platform.feature_flag(key, enabled, environment)` with `kelo_credit = false`.

**4C `…kelo_layaway`**
- `kelo.plan_template`, `kelo.category_plan_rule`, `kelo.listing_plan_offer` (ADR 0018; versioned with effective dates; layaway rows only).
- `kelo.refund_rule(category_id, version, percent_returned_bps, cancellation_fee_minor, cancellation_fee_cap_minor, after_session_rule, effective_from)`.
- `kelo.order(id, tenant_id, consumer_account_id, listing_id, variant_id | session_id | quote_id, plan_type, template_version_id, total_minor, currency, status, idempotency_key)`; `kelo.order_event` append-only.
- `kelo.layaway_plan(id, order_id, status)` and `kelo.layaway_instalment(id, plan_id, seq, due_on, amount_minor, payment_intent_id, status)`; instalments sum to the total (check by trigger).
- `payments.payment_intent` gains `purpose` (`collection` default, `kelo_layaway`).
- Ledger account types `kelo_layaway_funds_held` (platform liability per asset), `kelo_fee_revenue` (platform income per asset).

## 3. State machines

- **Store:** `submitted → approved | rejected`. Final once decided.
- **Provisioning (ADR 0008):** `requested → business_resolved → workspace_linked → admin_assigned → completed`; any step → `failed_retryable` (retried by the outbox), `failed_needs_review` (operator), `reconciliation_required`. Each step is its own transaction; a crash resumes from the last committed step.
- **Listing:** `draft → in_review → published | rejected`; `rejected → draft`; `published → suspended` (operator) `| in_review` (restricted category, price or description changed); `suspended → in_review`.
- **Order (ADR 0017, layaway subset):** `placed → payment_ready → merchant_confirmed → fulfilled → completed`; `→ cancelled` before fulfilment. Layaway: `payment_ready` once the first instalment succeeds; fulfilment only after the last.
- **Layaway plan:** `active → paid_in_full → settled`; `active → cancelled → refunded`. A payment in `status_unknown` blocks the transition and shows "being checked".

## 4. Endpoints (all `/v1`)

**4A** — `POST /kelo/stores` (enlist; Idempotency-Key), `GET /kelo/stores`, `GET /kelo/stores/:id`; `GET /kelo/categories`; workspace routes `POST|GET /workspaces/:id/kelo/listings`, `PATCH /workspaces/:id/kelo/listings/:lid`, `POST …/submit`, `POST …/variants`, `POST …/sessions`, `POST …/images/upload-token`, `POST …/images` (attach); operator routes `GET /ops/kelo/stores?status=`, `POST /ops/kelo/stores/:id/decision`, `GET /ops/kelo/provisioning?status=`, `POST /ops/kelo/provisioning/:id/retry`, `GET /ops/kelo/listings/review`, `POST /ops/kelo/listings/:id/decision`, `POST /ops/workspaces/:id/restrictions/:kind/lift`; job `GET /internal/cron/kelo-provisioning-backfill`.
**4B** — public `GET /kelo/marketplace/listings?q=&category=&cursor=`, `GET /kelo/marketplace/listings/:id`; consumer `POST /kelo/quote-requests`, `GET /kelo/me/quotes`; merchant `POST /workspaces/:id/kelo/quotes`.
**4C** — `GET /kelo/marketplace/listings/:id/plans` (schedule from the engine); consumer `POST /kelo/orders` (Idempotency-Key), `GET /kelo/me/orders`, `POST /kelo/me/orders/:id/instalments/:seq/pay`, `POST /kelo/me/orders/:id/cancel`, `POST /kelo/me/orders/:id/confirm-delivery`; merchant `GET /workspaces/:id/kelo/orders`, `POST …/orders/:oid/confirm`, `POST …/orders/:oid/fulfil`.

## 5. Tests (written first where the discipline requires it)

- **Provisioning (brief §13.4):** exactly one workspace per approved store; the event delivered twice creates nothing new; concurrent approvals of two stores for one business give one workspace; a crash after each step resumes; the backfill finds an approved store with no provisioning and completes it; the admin is the applicant, linked to the right business; an existing workspace is linked only when the applicant is its admin; restrictions copied and enforced; one merchant cannot read another's store, listings or provisioning; provisioning grants no payout, financing or investment permission.
- **Catalogue:** listing state machine table test; a prohibited term blocks submission; unreviewed listings are invisible to the marketplace and to search; a restricted-category price change returns to review; categories are only data (a test fails on a category slug in code); stock and capacity cannot go below zero under concurrent reservation.
- **Images:** the token constrains type, size and path; attach refuses a blob outside the listing's path or over the size; nothing uploads through the API.
- **Consumer isolation:** a consumer sees only their own quotes and orders under `withConsumer`; a merchant sees an order's fulfilment facts and never another tenant's; the platform role is not used for consumer reads.
- **Schedule engine:** property test, instalments sum exactly to the total for any amount and count; the final instalment absorbs the remainder; dates from the template.
- **Layaway (K4):** no credit decision or agreement exists; every instalment posts to "layaway funds held" and nothing reaches the merchant; capacity reserved at order; fulfilment refused before the last instalment; settlement on fulfilment equals total − discount fee exactly; cancellation refund equals the configured rule to the minor unit; an unknown instalment payment is never re-pushed; trial balance zero; reconciliation clean.

## 6. Files

- `services/api/src/modules/kelo/` — `stores.service.ts`, `provisioning.service.ts`, `catalogue.service.ts`, `images.ts` (adapter interface, simulator, Vercel Blob), `marketplace.service.ts`, `quotes.service.ts`, `orders.service.ts`, `layaway.service.ts`, `schedule.ts`, controllers.
- `services/api/src/modules/business/matching.ts` — ADR 0012 matching, extracted from onboarding.
- `services/api/prisma/migrations/2026101800xxxx_*` — one per checkpoint.
- `services/api/test/kelo-*.test.ts`.
- `apps/kony-web/app/w/[workspaceId]/kelo/…`, `apps/internal-ops/app/kelo/…`, `apps/kelo-web/` (4B).
- Docs: ADR 0008, 0017 and 0021 addenda; `docs/operations/web-apps.md`; `docs/progress.md`.
