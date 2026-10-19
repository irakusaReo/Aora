# ADR 0018 — Plan types and credit pricing configuration

- **Status:** Accepted (owner definition, 2026-10-13). Regulatory points are unverified and marked.
- **Related:** ADR 0003, 0017; lessons §1, §4; brief §7.4; open questions D-5, O-1 to O-4, O-8, O-9

No rate, fee, tenor, limit, deposit or late charge appears in code. Sandbox values are seed data and are visibly sandbox.

## Context

KELO's twelve launch categories differ widely in ticket size, risk and fulfilment. The owner defined four plan types and requires every commercial term to be versioned configuration with effective dates.

## Decision

### Plan types (a closed list in code; their terms are data)

| Type | Credit extended | Shape | MVP |
|---|---|---|---|
| `pay_in_n` | Yes | A few short instalments, the first at checkout. Consumer cost is transparent; the merchant pays a discount fee | Built |
| `monthly_financing` | Yes | Longer tenor for larger tickets; disclosed fees or interest; optional deposit | Built |
| `layaway` | **No** | Instalments before delivery; funds held; fulfilment after the last payment | Built, first |
| `asset_financing` | Yes | Title retention or device locking | Data model only. No device-lock integration |

### Configuration model

All rows are versioned: `effective_from`, `effective_to`, country, asset. A change is a new version; nothing is edited in place.

- **`plan_template`** — type; number and spacing of instalments; first-payment rule; deposit rule (none, fixed, percentage, minimum); consumer pricing model (none, flat fee, percentage fee, daily interest on a declining balance); merchant discount fee model; late-charge policy with its **cap**; grace period; early-repayment rule; rounding rule; minimum and maximum order value.
- **`category_plan_rule`** — which templates a category allows, with category-level limits, tenor bounds, deposit requirement and merchant settlement timing.
- **`listing_plan_offer`** — which of the allowed templates a merchant offers on a listing.
- **`eligibility_rule_set`** — the underwriting rules and thresholds, with reason codes.
- **`limit_policy`** — starting limits for thin-file consumers and how limits grow with repayment history.
- **`terms_document`** — the disclosure and agreement text, by version and language.

### Calculation

- One schedule engine in the API produces, for a given order value, template version and start date: the deposit, every instalment date and amount, fees or interest, the total repayable and the late-charge policy. Web and mobile render exactly this; nothing is computed in a client.
- Integer minor units throughout. The rounding rule is part of the template, and the instalments always sum exactly to the total repayable; the final instalment absorbs any remainder. A property test covers this.
- "From KES X per instalment" on a product page comes from the same engine.
- **An agreement snapshots the template version, rule-set version and terms version it was made under.** Later configuration changes never alter an existing agreement.

### Eligibility and limits

- Rules-based, no model. Every decision stores machine-readable **reason codes** and a **snapshot of the inputs** (lessons §4), for approvals and declines alike.
- Inputs, each optional and each behind consent where it concerns the consumer's data: KELO repayment history; an M-Pesa statement the consumer chooses to upload; a credit-bureau result through a `CreditBureauAdapter` (simulator until sandbox access exists). An affordability check is always run.
- The spending limit is shown only with what drives it and how to grow it, and is **never presented as cash or a balance**, in any API field name, screen or message.
- The engine is product-neutral, so merchant working-capital financing can reuse it after the MVP.

### Disclosure and consent

Before acceptance the consumer is shown the price, deposit, every instalment date and amount, fees or interest, total repayable and the late-charge policy. Acceptance records a consent (brief §7.4) naming the person, the capacity, the action, the time and the terms version. No pre-ticked boxes.

### Repayment

- On any rail the consumer chooses, or from a CHIWO balance. M-Pesa STK push first.
- **Automatic collection only where the provider documents support for it and the consumer has given explicit, recorded consent.** Any standing-order or recurring-debit capability is **to verify** per rail; until verified, each instalment is a consumer-initiated or consumer-approved payment.
- Early repayment carries no penalty in the MVP.
- Repayment is allocated by a configured order (for example oldest instalment first), posted to the ledger and visible to the consumer.

### Collections conduct

Reminders by SMS, push or in-app message only. KELO never reads phone contacts, never contacts third parties and never shames a borrower. Late charges are capped by the template. **The CBK Digital Credit Provider conduct rules have not yet been read and cited;** that is the first task of the credit checkpoint, and its findings are recorded in `docs/compliance/` before any reminder is built (open question O-8).

### Layaway

- No credit agreement and no credit decision; a layaway plan and schedule only.
- Payments are held in the "layaway funds held" liability account (ADR 0017). They are not the merchant's until fulfilment.
- Refund rules on cancellation are configuration per category: how much is returned, any cancellation fee and its cap, and what happens when a scheduled service's date passes.
- **Whether layaway is outside the definition of credit in Kenya has not been verified.** It is assumed "probably not credit" per the owner, kept available without the credit feature flag in the sandbox, and recorded as open question O-9.

### Feature flag

`kelo_credit` gates every credit plan type, the limit, eligibility and repayment-of-credit endpoints. With the flag off those routes do not exist as far as a caller can tell. Layaway and the catalogue do not depend on it.

## Alternatives considered

- **Plan terms in code per category:** twelve categories of constants, and a deployment for every pricing change.
- **A general rules engine or scripting language for pricing:** more flexible than needed and hard to audit; a fixed set of pricing models with parameters is enough.
- **Recomputing schedules from current configuration:** changes a signed agreement after the fact.
- **A scoring model for eligibility:** not explainable enough for the stated goal, and there is no data to train one.

## Consequences

- Product and risk can change terms without engineering, and every past decision remains explainable against the versions it used.
- Configuration mistakes become the main risk; each new version is validated (sums, caps, date logic) before it can take effect, and versions are audited.
- Until O-8 and O-9 are answered, credit stays flagged off outside the sandbox and reminder behaviour is not built.

## Addendum, 2026-10-19 (Phase 8A: credit terms, decisions and agreements, as built)

Phase-8 plan decisions P8-1 to P8-12; Kenya's credit conduct rules (O-8) are read in [kenya-credit-conduct.md](../compliance/kenya-credit-conduct.md). The paragraph above that says the conduct rules "have not yet been read" is superseded by that file.

- **Flag as data (P8-1):** `ops.feature_flag`, one row per flag, off by default. An operator switches `kelo_credit` in internal-ops `/flags` with a PIN step-up and a reason (`POST /v1/ops/feature-flags/{key}`, audited as `ops.feature_flag.changed`). It is read on every use, so a switch takes effect on every instance at once and needs no Vercel change. Off: every credit route is `not_found`, merchants are offered no credit template, and plan lists omit credit plans (absent, not greyed out).
- **Credit terms on the template:** `pricing_model` (`none` for Pay in N, `daily_interest` for monthly financing), `daily_rate_ppm`, `deposit_bps` or `first_payment_at_checkout` (exactly one), `grace_days`, `late_fee_minor`, `late_fee_total_cap_minor`, `default_after_days` and `lender_of_record`. Layaway rows must carry none of them (database check). Seeded: `sandbox_pay_in_4` (four parts every 14 days, the first at checkout, no interest; electronics, home appliances, solar) and `sandbox_monthly_6` (10% deposit, six parts every 30 days, 500 ppm a day = 18.25% a year nominal; solar).
- **Schedule engine (P8-3):** `creditSchedule()` in `services/api/src/modules/kelo/schedule.ts`. Equal principal parts (the last takes the remainder), each with simple interest on the principal owed during its period, rounded half up; a part due at checkout carries none. It returns principal, interest and amount per line, the total cost of credit, the daily rate as text (four decimals, exact) and the APR as text (daily rate × 365, nominal, two decimals, rounded half up). Property tests prove the lines sum exactly to the price and to the total payable.
- **r. 29 at configuration time (P8-4):** `plan_template_recovery_cap` refuses a credit template unless the most interest it could ever charge (the whole financed amount for the whole tenor, plus rounding) plus its late-charge cap stays within the principal of the smallest order it allows; `withinRecoveryCap()` is the same inequality, property-tested against the engine at every larger price. Each agreement repeats the check on its own figures.
- **Eligibility and limit as data (P8-5, P8-6):** `kelo.eligibility_rule_set` (version 1: phone on file, at most two open agreements, the largest single payment at most 30% of declared monthly income, decline on an adverse bureau result, decisions valid 30 minutes) and `kelo.limit_policy` (version 1: KES 50,000 to start, KES 25,000 more per agreement repaid on time, at most KES 200,000). "Used" is principal still owed on open agreements. Reason codes, checked and shown in a fixed order: `phone_missing`, `overdue_instalment`, `too_many_open_agreements`, `order_out_of_range`, `unaffordable`, `over_limit`, `bureau_adverse`, each with plain words shown at once.
- **Decisions** (`kelo.credit_decision`) are final and immutable, store the reason codes, the rule-set and limit-policy versions and an input snapshot, and belong to the consumer alone (no tenant; consumer row-level security). An approval is used at most once (`credit_agreement.decision_id` unique, plus a per-decision advisory lock) before it expires. A decline charges nothing, reserves nothing and places no order.
- **Bureau (P8-7):** a sandbox simulator only, run only with its own consent (`kelo_bureau_check_consent`, separate from the agreement, r. 58). The M-Pesa statement upload is deferred.
- **Agreement (P8-12):** `kelo.credit_agreement` snapshots the template, the key information document (`kelo_credit_kid_<template>`), the agreement (`kelo_credit_agreement`), the consent, the lender of record and every price, rate and charge; its instalments (`kelo.credit_instalment`, seq 0 is the deposit) sum by trigger to the price and to the interest. A later template version changes nothing in it (tested). Machine: `pending_first_payment → active → paid_off`, `pending_first_payment | active → cancelled` before fulfilment; `defaulted` and `paused` arrive in 8B and 8C.
- **Payments:** the checkout line, then each part once due, by M-Pesa (Daraja test number) or the simulator, claimed before the payment exists as for layaway. Paying ahead waits for 8B's early repayment.

Deviation from the plan: the consumer's receivable is named `consumer_kelo_credit_receivable` (not `kelo_consumer_receivable`), because Phase 7B's database rule gives a consumer only `consumer_*` account types.
