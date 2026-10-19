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

## Addendum, 2026-10-14: what checkpoint 3C built

- **Settlement rule (sandbox):** a run settles every succeeded collection of a workspace and asset that has no open reconciliation exception, in one batch: debit `merchant_collections_pending`, credit `merchant_available`, net of fee. Rows are taken with `FOR UPDATE SKIP LOCKED`, so overlapping runs never settle a collection twice; a collection is marked with its batch and can never move to another. Runs from the scheduled jobs (`/v1/internal/cron/settlement`).
- **Payout float:** a successful payout credits `provider_payout_float` (per provider, debit-normal, allowed below zero). In the sandbox the provider's disbursement account is funded outside the ledger, so a balance below zero records float used, not an overdraft. This is a labelled sandbox assumption, like M-4, and must be replaced by a funded account before any pilot.
- **Payouts:** reservation on creation (`merchant_available` → `merchant_payouts_in_flight`, amount plus fee); success: in flight → payout float (amount) and `fee_revenue` (fee); failure: the reservation is reversed exactly. The fee charged must equal the previewed fee and tariff version, or the request is refused (`fee_changed`).
- **First payout to a new recipient:** `payments.payout_policy` (versioned data) sets the cooling-off period after confirmation, the first-payout cap and the minimum payout. Sandbox defaults: 10 minutes, KES 1,000.00, KES 10.00 (Daraja's documented B2C minimum, held as data).
- **Refunds:** reservation on creation from `merchant_available` if the collection is settled, otherwise from `merchant_collections_pending`; success: in flight → `provider_clearing` of the provider that collected it; failure: reversed. A database trigger, which locks the collection, refuses any refund that would take the total refunded (excluding failed refunds) above the collection. The sandbox refund tariff charges nothing and AORA keeps the original collection fee. Refunds of Daraja collections are not available in Phase 3 (open question X-14).
- **Payouts and refunds share one state machine** (`payments.operation_transition`), with the same rules as a payment intent: `submitting` committed before the provider call, `status_unknown` never resubmitted, `reconciliation_required` only left by an operator.


## Addendum, 2026-10-18 (Phase 4C: KELO layaway, phase-4 P4-9)

- **Purpose on every collection.** `payments.payment_intent.purpose` is `collection` (default) or `kelo_layaway`, immutable. A layaway instalment is routed and limited as the merchant's (its `tenant_id`), carries **no collection fee** (a check constraint), and is **not** one of the merchant's collections: it is absent from the collections list and lookup, cannot be refunded through the collections refund route, emits no merchant webhook, and is never picked up by the settlement job.
- **Posting on success:** debit `provider_clearing` (the provider), credit `kelo_layaway_funds_held` (platform liability to the buyer), the full amount. KELO is told through the outbox event `kelo.layaway.payment_result` in the same transaction.
- **Settlement on fulfilment** (one entry, `kelo_purchase`): debit `kelo_layaway_funds_held` (the total); credit the merchant's `merchant_available` (total − merchant discount fee) and `kelo_fee_revenue` (the fee). The fee is the template's basis points of the total, rounded half up, fixed on the purchase when it is placed.
- **Cancellation:** debit `kelo_layaway_funds_held` (what was paid); credit `kelo_refunds_payable` (the refund) and `kelo_fee_revenue` (the cancellation fee). The refund is disbursed through the simulator (sandbox; Daraja reversal is X-14): debit `kelo_refunds_payable`, credit `provider_payout_float` (`sandbox_sim`). Unknown outcomes are inquired, never resubmitted; a stuck refund opens `stuck_status_unknown`.
- **Reconciliation:** a succeeded layaway intent is checked against `kelo_layaway_funds_held` (all of it, there), not the merchant's accounts.
- **Sandbox assumption (owner may change):** a retained cancellation fee is KELO income, not the merchant's. Who keeps it in production is a commercial decision.

## Addendum, 2026-10-18 (Phase 5C: USDC treasury, phase-5 plan P5-4, P5-9)

USDC has its own accounts and never shares one with KES (CLAUDE.md rule 5):

| Account | Owner | Normal side | Meaning |
|---|---|---|---|
| `chain_wallet_usdc` | platform | debit | USDC held in AORA's sandbox testnet wallet |
| `platform_usdc_funding` | platform | credit | AORA's own sandbox funding of that wallet (faucet USDC an operator attributes) |
| `merchant_usdc_available` | workspace | credit | USDC the workspace may withdraw |
| `merchant_usdc_withdrawals_in_flight` | workspace | credit | Reserved for withdrawals not yet resolved |

Entries: a confirmed deposit from a registered address debits `chain_wallet_usdc` and credits the workspace's `merchant_usdc_available` (one entry per observed transfer). A withdrawal request moves the amount to `…_in_flight`; a confirmed withdrawal transaction moves it out of `chain_wallet_usdc`; a rejected, reverted or failed one moves it back. Network fees (testnet ETH) are recorded on the chain operation, not ledgered (P5-7). Withdrawal limits are `tenancy.tier_limit` rows for `USDC` (per transaction and per 24 hours), sandbox data.

## Addendum, 2026-10-18 (Phase 6: NAM Vault, phase-6 plan P6-5)

| Account | Owner | Normal side | Meaning |
|---|---|---|---|
| `nam_vault_usdc` | platform | debit | USDC AORA's wallet has in the vault, at the vault's accounted value |
| `nam_vault_rounding` | platform | credit (may go negative) | Difference between holders' cost and what the vault returns |
| `merchant_nam_funding_pending` | workspace | credit | Set aside for a NAM order not yet confirmed |
| `merchant_nam_holding` | workspace | credit | The workspace's principal in the vault, at cost |

An order reserves `merchant_usdc_available` → `merchant_nam_funding_pending`. Its confirmation moves `chain_wallet_usdc` → `nam_vault_usdc` (platform) and pending → holding (workspace), in one entry. A redemption of `s` of `S` shares returning `a` releases cost `c = cost × s ÷ S` (the whole cost when `s = S`). It posts `a` from the vault account back to the wallet account, debits `c` from the holding, credits `a` to `merchant_usdc_available`, and puts `c − a` in `nam_vault_rounding`. The holder receives what the vault returned, as the disclosure says. Shares themselves are not money and live in `nam.holding`.

## Addendum, 2026-10-19 (Phase 7A: CHIWO payments to a merchant, phase-7 plan P7-4, P7-5)

A consumer's payment to a KONY merchant through CHIWO **is the merchant's collection**: a payment intent in the merchant's workspace with purpose `collection` and channel `chiwo`. The fee comes from the tariff in effect and is charged to the merchant, exactly as for a collection the merchant starts, so gross − fee = net, settlement, refunds, webhooks and reconciliation are unchanged. The consumer pays the amount and nothing on top (`fee_minor` 0 in the quote, which the payment request must echo). No new account type: nothing is held for the consumer in fiat. The merchant's per-person "payment received" email is not sent for a `chiwo` intent (no one at the merchant started it); the consumer gets a CHIWO receipt email instead.

## Addendum, 2026-10-19 (Phase 7B: personal USDC, phase-7 plan P7-8 to P7-12)

| Account | Owner | Normal side | Meaning |
|---|---|---|---|
| `consumer_usdc_available` | consumer | credit | USDC the consumer may send or withdraw |
| `consumer_usdc_withdrawals_in_flight` | consumer | credit | Reserved for the consumer's on-chain withdrawals not yet resolved |

A confirmed deposit from a consumer's registered address debits `chain_wallet_usdc` and credits their `consumer_usdc_available`. A transfer between CHIWO consumers is one entry, sender's available to recipient's available, with no fee and no chain transaction; paying a payment request is such a transfer, and a request names at most one (`chiwo.transfer.request_id` unique). An on-chain withdrawal reserves into `…_in_flight`, leaves `chain_wallet_usdc` once confirmed, and is released if the transaction fails or reverts, exactly like a workspace withdrawal but with no second approver (P7-11). Limits per transfer, per withdrawal and per day are `chiwo.consumer_limit` rows (sandbox data).

## Addendum, 2026-10-19 (Phase 7C: personal NAM, phase-7 plan P7-14)

| Account | Owner | Normal side | Meaning |
|---|---|---|---|
| `consumer_nam_funding_pending` | consumer | credit | Set aside for a personal NAM order not yet confirmed |
| `consumer_nam_holding` | consumer | credit | The consumer's principal in the vault, at cost |

The entries are the Phase 6 ones with the owner's accounts in place of the workspace's: an order reserves `consumer_usdc_available` → `consumer_nam_funding_pending`; its confirmation moves the wallet to the vault (platform) and pending to holding (consumer); a redemption returns what the vault paid to `consumer_usdc_available` with the same proportional cost release and rounding account.
