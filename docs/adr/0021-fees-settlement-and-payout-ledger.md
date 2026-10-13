# ADR 0021 — Fees, tier limits, settlement and the payout ledger

- **Status:** Accepted for the sandbox (owner approved Phase 3 scope, 2026-10-13). Fee and limit values are sandbox data, not decisions.
- **Date:** 2026-10-13
- **Related:** lessons §1, §2, §7; ADR 0003; CLAUDE.md rules 3, 4, 5; open questions X-4, D-8, M-4; [phase-3 plan](../plans/phase-3.md)

## Context

Lessons §1 requires provider tariffs and AORA fees to be versioned data, the version applied to be recorded on each transaction, and gross, fee and net to be shown after every collection. Lessons §7 requires tier limits to be configuration. Phase 3 also adds settlement, payouts and refunds, which need more balance types than Phase 1 had.

## Decision

**Tariffs**

- `pricing.tariff_version` is one version of the price of one operation (`collection`, `payout`, `refund`) on one rail, in one country and asset, with `effective_from` and `effective_to`. The database refuses two versions in effect at the same instant.
- `pricing.tariff_band` rows belong to a version. A band starts at `min_amount` and runs to the next band's `min_amount`, so bands cannot overlap or leave a gap.
- **Formula**, in integer minor units: `fee = clamp(flat_amount + amount × bps / 10 000, min_fee, max_fee)`, and never more than the amount. The proportional part is rounded half up, or down, as the version says. `net = gross − fee`; on a collection `net_amount` is a generated column, so the identity cannot be broken.
- **Published versions and bands are immutable.** A price changes by publishing the next version, which closes the previous one at the same instant. Bands can only be inserted in the transaction that creates their version.
- **The fee is fixed when the operation is created**, from the version in effect at that instant, and stored with the version id. A tariff change between creation and success does not change what the merchant was shown.
- The sandbox tariff (free below KES 100.00, then 1.00% capped at KES 200.00) is deliberately fake. Real provider and AORA tariffs are unverified (X-4).
- Not yet modelled: the provider's own charge to AORA, and a pass-through link between an AORA fee and a provider tariff. Both wait for verified tariffs.

**Tier limits**

- `tenancy.tier_limit` holds versioned limits per tier and asset: per transaction, collections over a rolling 24 hours, payouts over a rolling 24 hours. A rolling window avoids choosing a time zone. The newest version in effect applies; rows are append-only.
- A workspace with no limit configured for an asset may not collect in it.
- Values are sandbox placeholders (D-8).

**Ledger**

| Account type | Owner | Meaning |
|---|---|---|
| `provider_clearing` | platform, per provider | Money the provider holds for AORA |
| `merchant_collections_pending` | workspace | Collected, net of fee, not yet settled |
| `merchant_available` | workspace | Settled and free to pay out |
| `merchant_payouts_in_flight` | workspace | Reserved for payouts not yet resolved |
| `fee_revenue` | platform | AORA's fees |

A successful collection posts one entry: debit `provider_clearing` gross; credit `merchant_collections_pending` net; credit `fee_revenue` fee (omitted when the fee is zero, because a posting must be positive). Settlement, payout and refund entries are listed in the phase plan §4 and are built in checkpoint 3C. Each balance type is reported separately and never summed (rule 5).

## Alternatives considered

- **Fee calculated when the collection succeeds:** the merchant could be shown one fee and charged another across a tariff change.
- **Bands with explicit upper bounds:** allows overlaps and gaps that then need a second constraint.
- **A PostgreSQL exclusion constraint for version overlap:** needs the `btree_gist` extension, which the migration role may not be able to create on the hosted database. A trigger with an advisory lock gives the same guarantee.
- **Calendar-day limits:** needs a time zone per workspace, which nothing yet defines.

## Consequences

- A price or limit change is an insert, with no deployment.
- Reconciliation now expects the merchant to be credited gross minus fee.
- The sandbox chart assumes an AORA-controlled collection account (M-4). That is a labelled sandbox assumption, not a custody decision.
