# ADR 0017 — KELO marketplace domain model

- **Status:** Accepted (owner definition, 2026-10-13)
- **Related:** brief §2.3 amendment, §4.5, §4.6; ADR 0002, 0003, 0008, 0012, 0018; lessons §4; open questions O-1 to O-4, O-7 to O-9

## Context

KELO is a consumer BNPL marketplace with a merchant side. Consumers browse and buy on instalment terms, in the marketplace or through "Pay with KELO" at a merchant's own checkout. Merchants enlist, list, fulfil and handle returns from a KELO section of their KONY workspace. Owner defaults: one merchant per order; KELO pays the merchant upfront less a discount fee once fulfilment is confirmed, and the consumer repays KELO; the production funding model is undecided.

## Decision

### Modules

The `kelo` module is split by responsibility. Each part owns its tables; they talk through services and outbox events (ADR 0002).

| Part | Owns |
|---|---|
| `kelo.store` | Store enlistment, vetting status, category permissions |
| `kelo.catalogue` | Taxonomy, listings, variants, inventory, capacity, quotes, media references, moderation |
| `kelo.order` | Orders, order lines, fulfilment, returns, disputes |
| `kelo.credit` | Consumer credit profile, eligibility decisions, agreements, schedules, repayments (ADR 0018) |
| `kelo.settlement` | Merchant payables, settlement timing, clawbacks |

A store belongs to a KONY workspace, so every merchant-side row carries that `tenant_id` and is under row-level security. Consumer-side rows (agreements, schedules) are owned by a person, not a tenant, and get their own isolation rule: a consumer sees only their own; a merchant sees an order's fulfilment facts but never the consumer's credit profile, limit or decision reasons.

### Enlistment

Enlisting a store runs the ADR 0008 provisioning workflow. The trigger is `kelo.store.approved`, which settles the open point under R-2: **"qualifying" means a store whose vetting is approved.** Vetting is the KYB tier plus category-specific requirements held as configuration (for example a licensed optical or dental provider, a motorbike dealer).

### Catalogue

- **Taxonomy is data:** categories form a tree with effective dates. The twelve launch categories are seed data, never constants. Each category maps to its allowed plan types, limits and settlement rule (ADR 0018), its vetting requirements and its prohibited-item rules.
- **Three listing types**, one table with a type and type-specific children:
  - **Stock item:** variants and inventory. Stock is **reserved** when an order is placed, in the same transaction as the order, with a database constraint that available stock cannot go below zero. A reservation expires if the order is not confirmed, and is released on cancellation.
  - **Scheduled service:** sessions with a date and a capacity, reserved the same way (holidays, courses, exams).
  - **Quote-based service:** the merchant issues a quote with a price and an expiry; an accepted quote becomes the order (moving).
- **Search:** PostgreSQL full-text search over name, description and category. No search service.
- **Media:** listings hold references to stored images; the bytes never pass through the API (4.5 MB limit, ADR 0013). The storage provider is open question O-7.
- **Moderation:** a listing is `draft → in_review → published`, or `rejected`, `suspended`. A prohibited-items list (configuration) blocks submission; everything else goes to a review queue in `internal-ops`. A change to price or description of a published listing in a restricted category returns it to review.
- **Medical-cosmetic categories** store what was bought and its price. No prescription, diagnosis, measurement or other health information is stored in any KELO table, description or note.

### Orders

One merchant per order. The order has its own state machine, linked to but separate from the credit agreement and from payments.

```text
placed ─▶ payment_ready ─▶ merchant_confirmed ─▶ fulfilled ─▶ completed
   │            │                  │                 │
   └─▶ cancelled (before fulfilment, from any earlier state)
                                   └─▶ partially_fulfilled ─▶ fulfilled | completed
fulfilled ─▶ return_requested ─▶ returned (whole or part) ─▶ completed
any ─▶ disputed ─▶ (previous state) | returned | cancelled
```

- `payment_ready` means "credit approved and first instalment or deposit paid" for a credit plan, and "plan started" for layaway (where fulfilment waits until the plan is fully paid).
- `fulfilled` needs evidence: the consumer's confirmation or a proof of delivery from the merchant. Which is required is per-category configuration.
- An order never advances because a payment succeeded on its own, and a payment state never changes because an order did; each reacts to the other's events through the outbox.
- Partial fulfilment splits the order's lines; credit and settlement follow the fulfilled amount.
- `status_unknown` and `reconciliation_required` exist on the payment and settlement operations the order depends on, and the order shows "being checked" while any of them is unresolved.

### Returns and disputes

- A return request or an open dispute **pauses the schedule** for the affected amount: no reminders, no late charges, no automatic collection on it.
- An accepted return **reduces the outstanding balance by compensating ledger entries** and re-plans the remaining instalments; money the consumer has already paid beyond the new total is refunded.
- **Clawback** of money already settled to the merchant follows configured rules per category: netted from the merchant's next KELO settlement first, then a receivable from the merchant. A clawback never drives a merchant ledger account negative silently; the shortfall is its own account.
- Outcomes are recorded with reason codes and are audited.

### Settlement to merchants

Timing is configuration per category (for example on delivery confirmation, or a number of days after). The merchant is paid the order value less the merchant discount fee, through the KONY payout path, and sees every figure: sale, fee, clawbacks, net.

### Lender of record

Every credit agreement names a `lender_of_record`. In the sandbox it is a simulated KELO book. A `LenderAdapter` interface (decide, fund, record repayment, report) lets a partner lender take that role later without changing orders, catalogue or the consumer experience.

### Ledger accounts added

Separate account types (ADR 0003), per asset: consumer receivables; merchant payables; merchant discount fee income; consumer fee income; late-charge income; layaway funds held; refunds payable; merchant clawback receivable; write-offs. Layaway money is a liability to the consumer in "layaway funds held" until fulfilment; it is never merchant money or KELO income before then.

### Pay with KELO outside the marketplace

A KONY payment link or a developer-API checkout can offer KELO as a payment method. It creates the same order and agreement, with the merchant's own description of the goods and no catalogue listing. In-store QR is after the MVP.

## Alternatives considered

- **KELO as part of `kony`:** the consumer side has a different owner of data and different isolation rules.
- **One state machine for order, credit and payment:** simpler to draw, and the source of "paid, so it must be delivered" bugs the brief forbids.
- **A search service or a headless commerce product:** not needed at MVP scale, and adds a system.
- **Multi-merchant baskets:** ruled out by the owner for the MVP; settlement and returns become much harder.

## Consequences

- KELO is the largest part of the MVP and is built in checkpoints (mvp-scope).
- Layaway can be built and demonstrated before any credit feature, because it uses orders, holding accounts and settlement but no credit decision.
- Consumer isolation needs its own tests, beside tenant isolation.
- The simulated lender must be labelled sandbox everywhere a lender is named.

## Addendum, 2026-10-18 (Phase 4A, as built)

- **Taxonomy:** `kelo.category`, versioned and immutable; twelve sandbox categories as seed data (open question O-15). Each carries its allowed listing types, vetting requirement keys (sandbox placeholders, not verified legal requirements), a `restricted` flag and its fulfilment evidence. A test fails if application code names a category.
- **Prohibited items:** `kelo.prohibited_term`, configuration with effective dates, global or per category, matched as whole words in title and description. Checked at submission and on every edit of a published listing (`prohibited_item`). Health-information terms are prohibited in medical-cosmetic and dental listings.
- **Listings:** state machine `draft → in_review → published | rejected`, `rejected → draft` on edit, `published → suspended | in_review`, `suspended → in_review`. Each change bumps a `revision`; each moderation decision is append-only and names the revision it saw. A restricted category's listing returns to review when its price or description changes.
- **Stock and capacity:** `stock_reserved ≤ stock_on_hand` and `reserved ≤ capacity` are database checks; stock cannot be lowered below what is reserved (`conflict`). Reservation by orders arrives in 4C.
- **Images (P4-7):** a public Vercel Blob store. The API issues a client token for one exact pathname under `kelo/<workspace>/<listing>/`, one image type and at most 4 MB; the browser uploads directly; the API checks the stored blob's path, type and size with `head()` before attaching it. With no `BLOB_READ_WRITE_TOKEN` the image store is the labelled simulator.
- **Marketplace reads** are public and return published listings only, with no stock counts (an `in_stock` or `available` flag only). Search is PostgreSQL full-text search over a generated `tsvector` with a GIN index on published rows.
- **Writes** go through the platform role with the tenant named in every statement; members read through row-level security, the same split as branches and payouts.

## Addendum, 2026-10-18 (Phase 4C: layaway, as built)

- **Purchase** (`kelo.purchase`) holds two linked state machines on one row: the order (`placed → payment_ready → merchant_confirmed → fulfilled → completed`, `→ cancelled` before fulfilment) and the plan (`active → paid_in_full → settled`, `active | paid_in_full → cancelled → refunded`). Every change is an append-only `purchase_event`. A database check refuses `fulfilled` or `completed` before the last payment.
- **Terms are fixed at purchase:** the template version, the refund rule version, the price and the merchant fee are stored on the purchase; consent names the terms version (`kelo_layaway_terms`).
- **Reservation:** a place or a unit is reserved in the same transaction as the purchase by a conditional update, so concurrent buyers cannot oversell (`sold_out`); cancellation releases it; fulfilment of a stock item removes the unit from stock and reservation together.
- **Instalments** are paid in order. Each is claimed (`submitting`, keyed by a hash of the request's Idempotency-Key) before its payment is created, so two requests can never both push a payment; a retry with the same key adopts the payment; a claim with no payment behind it after two minutes is reclaimed. `pending` is "being checked" and cannot be paid again. A declined payment returns the instalment to `due`.
- **Fulfilment evidence** follows the category: the buyer's confirmation (`consumer_confirmation`), a merchant proof reference (`merchant_proof`), or the session having started (`session_start`).
- **Plans offered** are the merchant's choice per listing (`kelo.listing_plan_offer`, none by default) among the templates the category allows (`kelo.category_plan_rule`). The buyer sees every payment, the total, "no fees", the late rule and the cancellation rule before agreeing, all from the schedule engine.

## Addendum, 2026-10-19 (Phase 8A: credit purchases)

- `kelo.purchase.plan_type` now also takes `pay_in_n` and `monthly_financing`. A credit purchase has no layaway refund rule (`refund_rule_id` may be null only for credit) and is fulfilled once its agreement is in force, not after the last payment; the database check that waits for the last payment applies to layaway only.
- The order machine is unchanged. For a credit purchase, `payment_ready` means the agreement is `active`, which happens when the deposit or first part is paid.
- The shared order helpers (transitions, reservation, price lookup, events) live in `services/api/src/modules/kelo/purchase-common.ts`; layaway and credit both use them.
- **Isolation (P8-9):** decisions, agreements, agreement events and credit instalments have consumer row-level security and no tenant policy. A merchant's purchase list shows the plan type and the order, never a limit, decision, reason, income, interest or schedule (tested through the merchant's own row-level context).
- **Cancellation before fulfilment:** a pending agreement is cancelled with no money moved; an active one is reversed (see ADR 0021) and everything the buyer paid is refunded through the existing refund path (`kelo.layaway_refund`, no fee).

## Addendum, 2026-10-19 (Phase 8C: returns and disputes, as built)

- **Order machine, as built:** delivery is one step (`fulfilled → completed` at once; no partial fulfilment, one item per purchase). `completed → return_requested → returned | completed`; `payment_ready | merchant_confirmed | completed → disputed → (the state it came from) | returned | cancelled`. A purchase is closed once `cancelled` or `returned` and refunded.
- **Claims** (`kelo.purchase_claim`): a `return` (after delivery; decided by the merchant) or a `dispute` (once paid for; decided by a platform operator), with a reason code and optional details (purchase data only, never health information). One open claim per purchase. Decided once: `open → accepted | rejected | withdrawn`, each audited with who decided and why. Credit purchases only; layaway keeps its cancellation rule.
- **Pause:** an open claim pauses every open part (`paused`) and the agreement: no reminders, no late charges, no repayment. Rejected or withdrawn, everything goes back as it was, and a part whose due date passed during the pause gets its full grace period again from the day it resumed (`credit_instalment.grace_from`).
- **Accepted:** the credit is undone by compensating entries (ADR 0021) and everything the buyer paid is refunded with no fee. After delivery the merchant's net becomes a **clawback receivable** (`merchant_kelo_clawback_receivable`, the workspace's own account, never a silent negative), netted first from the workspace's next KELO settlement; KELO gives up its discount fee. A dispute upheld before delivery is a cancellation. Accepting a return needs the merchant's refund permission and a PIN step-up; an operator's decision needs a step-up and a reason.
- **Not built:** partial returns and re-planning what is left (one item per purchase makes every return whole); clawback rules per category (one rule: net from the next KELO settlement, else a receivable).
