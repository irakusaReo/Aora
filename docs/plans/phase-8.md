# Phase 8 Plan — KELO credit

- **Status:** done (2026-10-19): 8A to 8D built, merged (PRs #30–#33) and on staging. Run mode of 2026-10-18 (CLAUDE.md): no approval stop between phases.
- **Scope source:** [mvp-scope.md](../product/mvp-scope.md) §3 (checkpoints 8A to 8D), journeys K2, K3, K5, K6 and K7; [ADR 0017](../adr/0017-kelo-marketplace-domain.md), [ADR 0018](../adr/0018-plan-types-and-credit-pricing.md); [kelo-experience.md](../product/kelo-experience.md); [kenya-credit-conduct.md](../compliance/kenya-credit-conduct.md) (O-8, read 2026-10-19).
- **Branch:** one per checkpoint (`phase-8a` …). Merge rules as before: CI green on the head commit, migrations expand-only and on staging first, then staging health and every cron job confirmed.
- **Test discipline:** tests strictly first for every state machine (decision, agreement, instalment, return), the schedule engine (property tests), every ledger posting, idempotency, the flag, and consumer and tenant isolation (a merchant never sees a consumer's limit, decision or profile).
- **Sandbox:** no licence, no real lending. The lender of record is the simulated KELO book, named on every credit record and screen as "simulated lender, not licensed" (O-16). The credit bureau and the M-Pesa statement are simulators only (owner decision 2026-10-18). Nothing is ever reported to a bureau.

## Checkpoints

| | Contents | Needs from the owner |
|---|---|---|
| **8A** | Flag `kelo_credit`; credit terms on plan templates (consumer pricing, deposit, late charges and caps, grace, default period, allocation order) validated against r. 29; the schedule engine extended (equal principal, simple daily interest on the declining balance, deposit, APR); eligibility rule set and limit policy as data; bureau simulator; decisions with reason codes and an input snapshot; key information document; checkout that accepts a decision, creates the agreement (snapshotting every version) and takes the first payment by M-Pesa; merchant settlement on fulfilment net of the discount fee; kelo-web plan selector, decision and agreement screens; internal-ops flag switch | Nothing |
| **8B** | Repayments: pay the next instalment or pay early (exact balance, interest only to the day), allocation per r. 56(2), late charges after the grace period capped by the agreement and r. 29, default (non-performing) marking, reminders by email to the borrower only inside a contact window, statements, completion and limit growth; kelo-web purchases hub | Nothing |
| **8C** | Returns and disputes: a request pauses the affected amount (no reminders, no late charges); an accepted return reduces the balance by compensating entries, re-plans what is left and refunds any overpayment; clawback from the merchant (netted from the next settlement, else a receivable, never a hidden shortfall) | Nothing |
| **8D** | KELO dashboard in kony-web: orders needing action, BNPL sales, settlements, returns, fees, all equal to the ledger, with no consumer credit data | Nothing |

## 1. Decisions taken in this plan

| # | Decision | Why | Recorded in |
|---|---|---|---|
| P8-1 | **The flag is data:** `ops.feature_flag(key, enabled, changed_by, changed_at)` with an audited operator switch in internal-ops. Off by default. With it off, every credit route answers `not_found`, plan lists omit credit templates, and nothing on any screen mentions credit | ADR 0018; turning credit on must not need a Vercel Production change | ADR 0018 addendum |
| P8-2 | **Two credit pricing models:** `none` (Pay in N: the consumer pays the price only) and `daily_interest` (monthly financing: simple interest per day on the declining principal, at a daily rate in parts per million). No flat fees in the MVP. Early repayment then naturally costs interest only to the day (r. 56(4)) | Exact integers, explainable, compliant | ADR 0018 addendum |
| P8-3 | **Schedule shape:** an optional deposit at checkout, then equal principal parts (the last takes the remainder) with each instalment's interest on the principal outstanding during its period, rounded half up. The engine returns principal, interest and total per line, the total cost of credit, the periodic (daily) rate and the APR (daily rate × 365, nominal, shown to two decimals as text). Property test: lines sum exactly to the totals | ADR 0018; r. 54(4) | ADR 0018 addendum |
| P8-4 | **r. 29 cap at configuration time:** a template version is refused (database check plus engine validation) unless its maximum possible interest plus its maximum late charges cannot exceed the principal. The agreement also caps late charges in total | r. 29, r. 30(2) | kenya-credit-conduct.md |
| P8-5 | **Eligibility is rules as data** (`kelo.eligibility_rule_set`, versioned): phone on file; no overdue credit instalment; open agreements below a maximum; order inside the template's range; affordability (the largest instalment ≤ a share of the declared monthly income, which the consumer gives at checkout with the reason shown); within the limit; bureau result not adverse when the consumer opted into a check. Every decision stores reason codes and an input snapshot, approved or declined | r. 28; lessons §4; K6 | ADR 0018 addendum |
| P8-6 | **Limit policy as data** (`kelo.limit_policy`): a starting limit for a thin file, raised by a step for each agreement repaid on time, up to a maximum. "Limit used" is the outstanding principal of open agreements. Field names never say balance, available, funds or cash (a test scans API responses and pages) | ADR 0018; kelo-experience §2 | — |
| P8-7 | **Optional data sources:** the bureau check only, as a simulator, with its own consent document separate from the credit terms (r. 58). The M-Pesa statement upload is not built in the MVP (optional in ADR 0018; recorded as deferred) | r. 58; owner decision (simulators only) | open-questions |
| P8-8 | **Ledger, cash-basis interest:** at acceptance, debit `kelo_consumer_receivable` (consumer, KES) with the principal and credit `kelo_merchant_payable_pending` (platform). The deposit and each repayment debit the provider clearing account and credit the receivable for principal, `kelo_interest_income` for interest and `kelo_late_charge_income` for late charges. At fulfilment the payable moves to the merchant's `merchant_available`, less the discount fee to `kelo_fee_revenue` (the existing layaway path). Cancellation before fulfilment reverses the agreement entry and refunds what was paid | ADR 0017 accounts; simple and exact | ADR 0021 addendum |
| P8-9 | **The receivable is the consumer's** (`consumer_account_id` on ledger accounts, P7-2), so a merchant can never read it | ADR 0017 isolation | — |
| P8-10 | **Repayment from a CHIWO balance is not built:** CHIWO holds USDC only and KELO plans are in KES. Repayment is by M-Pesa (Daraja test number or simulator) | mvp-scope note; no KES balance exists | open-questions (Eng default) |
| P8-11 | **Reminders:** email through the notifications module (ADR 0020) to the borrower only, before each due date and after a missed one, inside a configured contact window (Nairobi, data), masked, with no action link and no bureau threat. SMS waits for an SMS provider | r. 30(1); ADR 0020; kelo-experience §2 | — |
| P8-12 | **Agreement wording:** a key information document and an agreement per template version, as terms documents (`kelo_credit_kid_<key>`, `kelo_credit_agreement`), naming the simulated lender and stating that it is not licensed; consent records the agreement version | r. 47, r. 48, r. 54 | — |

## 2. Data model (8A, `…20261019000400_kelo_credit`)

- `ops.feature_flag(key pk, enabled, changed_by, changed_at)`, row `kelo_credit` false.
- `kelo.plan_template`: new nullable or defaulted columns `pricing_model` (`none` | `daily_interest`), `daily_rate_ppm`, `deposit_bps`, `first_payment_at_checkout`, `grace_days`, `late_fee_minor`, `late_fee_total_cap_minor`, `default_after_days`; a check that credit templates carry them and that the r. 29 cap holds. Seed: `sandbox_pay_in_4` (4 parts, 14 days, first at checkout, no consumer cost) and `sandbox_monthly_6` (10% deposit, 6 monthly parts, daily interest), both sandbox; category rules for electronics (Pay in 4) and solar (monthly financing).
- `kelo.eligibility_rule_set(version, rules jsonb, effective_from)`, `kelo.limit_policy(version, start_minor, step_minor, max_minor, effective_from)`.
- `kelo.credit_decision(id, consumer_account_id, listing_id, variant_id, template_id, amount, outcome approved|declined, reason_codes[], inputs jsonb, rule_set_version, limit_policy_version, expires_at, created_at)`, consumer-isolated.
- `kelo.credit_agreement(id, purchase_id, consumer_account_id, tenant_id, decision_id, template_id, terms_document_id, kid_document_id, lender_of_record, principal, interest_total, deposit, status, created_at)` with `kelo.credit_instalment(agreement_id, seq, due_on, principal, interest, status, paid_principal, paid_interest, late_charges)`.
- `kelo.purchase.plan_type` widened to the credit types.
- Ledger types `kelo_consumer_receivable` (consumer), `kelo_merchant_payable_pending`, `kelo_interest_income`, `kelo_late_charge_income` (platform). Payment intent purpose `kelo_credit`.

## 3. State machines

- **Decision:** `approved` | `declined`, final; an approved decision expires after a configured time and can be used once.
- **Agreement:** `pending_first_payment → active → paid_off`; `pending_first_payment | active → cancelled` (before fulfilment); `active → defaulted` (non-performing, 8B); `active | defaulted → paused` per return or dispute (8C). The order machine of ADR 0017 is unchanged: `payment_ready` means the agreement is active.
- **Credit instalment:** `due → submitting → pending → paid`, `pending → due` on a failed payment, `due → late` after the grace period (8B), `paused` (8C).

## 4. Endpoints (8A; credit routes are `not_found` with the flag off)

`GET /v1/kelo/marketplace/listings/{id}/plans` (credit plans appear when on), `POST /v1/kelo/credit/decisions` (Idempotency-Key; listing, option, template, declared income, optional bureau consent), `GET /v1/kelo/credit/decisions/{id}`, `GET /v1/kelo/credit/limit`, `POST /v1/kelo/purchases` extended with `decision_id`, `GET /v1/kelo/me/purchases/{id}` with the agreement, `GET /v1/ops/feature-flags`, `POST /v1/ops/feature-flags/{key}` (operator, audited, with a reason).

## 5. Tests (8A, first)

Flag off: every credit route and plan is absent. The schedule engine (property): lines sum to the totals; the APR text follows from the rate; a refused template breaks r. 29. A decline stores reasons and inputs, charges nothing and places no order (K6). An approval and purchase snapshot the template, rule set and terms versions, and a later template version changes nothing. Stock cannot be oversold by concurrent orders. The first payment makes the agreement active; settlement happens only after fulfilment, net of the discount fee; trial balance zero. A merchant sees the order but no limit, decision or reason. The banned limit wording appears in no response or page.

## 6. Files

`services/api/src/modules/kelo/credit/` (`schedule.ts` additions, `eligibility.ts`, `credit.service.ts`, `credit.controller.ts`, `bureau.ts`), `services/api/src/modules/ops/feature-flags.ts`, migrations, `services/api/test/kelo-credit-*.test.ts`, kelo-web plan selector and checkout, internal-ops flag page, docs (ADR 0017, 0018, 0021 addenda).

## 7. 8A as built (2026-10-19)

Differences from sections 2 to 4, none material:

- **Receivable name:** `consumer_kelo_credit_receivable`, because the 7B database rule gives consumers only `consumer_*` account types.
- **Allocation account:** payments posts a successful repayment to `kelo_credit_repayments_unapplied` (platform); KELO allocates it to principal, charges and interest in its own entry. The payments module never needs to know an instalment's split, and reconciliation checks the unapplied account per intent.
- **The agreement entry is posted when the first payment succeeds** (activation), not at acceptance, so a failed first payment needs no reversal.
- **The deposit is line 0** of the agreement's instalments; Pay in N has no deposit and its line 1 is due at checkout. A template takes exactly one of the two (database check).
- **Routes:** the credit purchase reuses `POST /v1/kelo/purchases` with a body naming `decision_id`, `expected_total_payable_minor`, `agreement_version` and `kid_version`; repayments use `POST /v1/kelo/me/purchases/{id}/credit/instalments/{seq}/pay`; the buyer's purchase view gains `credit` (the agreement, or null).
- **Cancellation refunds** reuse `kelo.layaway_refund` (no fee) and its provider path.
- **Screens:** kelo-web credit plan card, decision form on the listing page, `/credit/checkout/{decision}` (decision and agreement), `/credit` (the limit, worded "You can spread up to …"), and a credit card in `/purchases`; internal-ops `/flags`.

## 8. 8B as built (2026-10-19)

- Migration `20261019000500_kelo_credit_repayments` (expand-only): `kelo.credit_repayment`; on parts `interest_waived_minor`, `paid_charges_minor`, `repayment_id`, `late_on`; a deferred trigger keeping late charges within the agreement's cap; `kelo.reminder_policy`.
- 8A's single-part payment now goes through a repayment too, so every payment has one record and one allocation.
- Routes: `GET …/credit/quote`, `POST …/credit/repay` (`next` or `payoff`, with the quoted amount), `GET …/credit/statement`; cron `GET /v1/internal/cron/kelo-credit` (seventh job, added to the scheduled workflow).
- Emails: `kelo.credit.reminder` (upcoming, overdue) and `kelo.credit.receipt`.
- kelo-web: "Pay early" in `/purchases` with the exact payoff, what it is made of and the interest saved; `/credit/statement/{purchase}`.

## 9. 8C as built (2026-10-19)

- Migration `20261019000600_kelo_returns` (expand-only): purchase states `return_requested`, `returned`, `disputed`; `kelo.purchase_claim` (one open per purchase, by an expression index); `credit_instalment.grace_from`; account type `merchant_kelo_clawback_receivable`.
- `CreditService.unwind` is the one path that undoes a credit purchase: cancellation (8A), an accepted return, and an upheld dispute.
- Routes: `POST /v1/kelo/me/purchases/{id}/claims`, `…/claims/{claim}/withdraw`; `POST /v1/workspace/kelo/claims/{id}/accept` (refund permission, step-up) and `…/reject`; `GET /v1/ops/kelo/claims`, `POST /v1/ops/kelo/claims/{id}/decision` (step-up).
- Screens: kelo-web "Something wrong?" in each credit purchase card, the paused notice and withdraw; kony-web KELO orders shows the claim and accept (PIN) or reject (reason); internal-ops `/disputes`.
- Deviation: no partial returns (one item per purchase), so "re-plans what is left" has nothing left to re-plan.

## 10. 8D as built (2026-10-19)

- `GET /v1/workspace/kelo/dashboard` (settlement permission: admin and finance), `services/api/src/modules/kelo/dashboard.service.ts`. Every money figure is summed from the ledger entries that name the workspace (`kelo_*_settlement`, `kelo_credit_return`) and from the clawback account's balance, so it equals the ledger by construction (tested against `merchant_available` and the clawback receivable). Order counts come from the order machine and open claims.
- kony-web `/w/{id}/kelo/dashboard`, in kelo-experience §3's order: orders needing action; BNPL sales; settlements due and paid (sale, KELO fee, clawbacks netted, paid to available); returns; fees.
- No migration. Nothing about any buyer or their credit is read or returned (tested).
