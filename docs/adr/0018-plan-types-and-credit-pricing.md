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
