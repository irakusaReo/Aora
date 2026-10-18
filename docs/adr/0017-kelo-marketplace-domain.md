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
