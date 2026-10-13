# KONY & KELO Competitive Lessons — Engineering Requirements

These requirements are derived from `docs/research/kopo-kopo-teardown.md` (research dated October 2026). Each section turns one or more gaps from the teardown into build requirements.

Market figures in the teardown, such as tariffs, competitor prices and market sizes, are context only. They change over time, and none of them may be hardcoded.

Gap IDs in brackets (for example C1 or R3) refer to the gap matrix in §3 of the teardown.

## Positioning

The incumbent resells Safaricom payment acceptance at Safaricom's own price. It earns most of its margin from expensive, opaque merchant credit.

Its weaknesses are:

- Credit limits merchants cannot understand.
- A high minimum advance that shuts out micro-merchants.
- Flat payout fees that punish small withdrawals.
- Acceptance on a single rail (M-Pesa).
- Slow pass-through of tariff cuts.
- Thin business tools.
- Inconsistent developer documentation.

KONY and KELO should win on transparency, multi-rail acceptance, workflow depth and developer experience. The goal is not to clone a payment dashboard.

## 1. Pricing and fees as versioned data (R1, R2, R3)

- Model provider tariffs, AORA fees, free bands, caps and payout fees as versioned tables. Each row carries `effective_from`, `effective_to`, currency and rail.
- Fee calculation uses the tariff version in effect at the time of the transaction and records which version it applied.
- Tiered and threshold pricing must work without code changes. For example: free below one amount, a percentage in the middle band, a flat cap above another amount. Safaricom changed its bands in August 2026, and the system must absorb changes like that through configuration alone.
- Support a pass-through link between an AORA fee and a provider tariff, so a provider's price cut reaches merchants the day it takes effect.
- Payout fees must support flat, percentage, tiered and free-sweep models. Do not hardcode a flat fee per payout.
- Show merchants a fee preview before every payout. Show gross amount, fee and net amount after every collection.

## 2. Showing where funds are held (P3)

- Every merchant balance view states where the funds sit and which entity controls them. The possible locations are a provider wallet, an AORA-controlled account, a bank, a USDC wallet or a vault.
- Support configurable automatic sweeps to the merchant's nominated M-Pesa or bank account, where the provider supports it. Sweep jobs must be idempotent and reconciled.

## 3. Multi-rail acceptance under one merchant identity (P1, X1)

- One canonical merchant can hold many collection points: tills, paybills, Pochi-type wallets, bank accounts, payment links and USDC addresses. Each collection point is tied to a rail with declared capabilities.
- Support child collection points under a parent (per counter, branch, vehicle or staff member), with payments attributed to the parent's ledger. Tanzania's TANQR/Lipa Namba system uses main and child tills, so keep the model compatible with it.
- Keep one unified transaction ledger and report across all rails. Rail-specific detail stays in the adapter records.
- Launch is Kenya only. Even so, every merchant, rail account and tariff carries an explicit `country` and `currency`, and core types make no Kenya-only assumptions.

## 4. Explainable, graduated credit in KELO (C1–C4)

- Store every eligibility decision with machine-readable reason codes and a snapshot of the inputs used. This lets the merchant and support staff see why a limit was set or an application declined.
- The merchant view shows the current limit, its main drivers, and what would raise it. Merchants should see their progress rather than a black box.
- Support small loan sizes (thousands of shillings, not tens of thousands) and limits that grow with repayment history. Minimum amounts are configuration.
- The pricing engine must support daily interest on a declining balance, capped late charges and flat fees, so that pricing models can be compared. Never hardcode a rate.
- Before the merchant accepts an offer, show the total cost of credit: amount, fees, total repayable and repayment schedule. Record the merchant's consent together with the version of the terms.
- Repayment from inflows (a share of each incoming payment) is a configurable mechanism that requires merchant consent. Post every deduction to the ledger and show it to the merchant.
- Credit products require a CBK Digital Credit Provider licence or a licensed partner. Keep lending capabilities behind feature flags until the legal model is confirmed.

## 5. Vertical workflows: build the primitives early (P2)

Vertical-specific screens come later (brief §5.5). The core data model should support these from the start:

- **Split settlement rules**, such as a matatu SACCO splitting each vehicle's takings between owner, crew and levy, paid out in batches.
- **Attribution references** on collections: vehicle, driver, route, counter, order or booking.
- **Deposits and refunds** linked to the original collection, as hotels need.
- **Reconciliation of several wallets into one ledger**, as pharmacies and retailers need.
- **Staff roles** limited to collecting payments, such as a cashier role.

## 6. Developer platform (D1, S1)

- One versioned API (`/v1`), with a single OpenAPI spec as the source of truth. No documentation that mixes API versions.
- Idempotency keys are required on every POST request that creates a financial operation.
- Webhooks are signed, retried on failure, logged per delivery, and can be replayed manually.
- Every asynchronous operation has a status lookup endpoint, so integrators never need to poll unrelated endpoints.
- The sandbox behaves like production: same states, same errors, and test triggers that simulate failures and unknown states.
- Error codes are stable, and the API has a changelog.
- A public status page shows component health without exposing customer data.

## 7. Onboarding (O1)

- Use tiered KYC/KYB. A merchant can start with low limits after minimal verification, and limits rise as verification is completed. The limits for each tier are configuration.

## 8. What not to copy

- Do not use contractual lock-in as the retention mechanism, such as requiring all payments to go through AORA while a loan is outstanding. Retention should come from useful workflows and transparency. Whether to include any such clause is a legal and product decision, not an engineering default.
- Do not use competitor names in product screens, copy or code identifiers.

## Market context for prioritisation (not requirements)

- Kenya launches first. The teardown recommends Tanzania as the first export market because of its TIPS/TANQR interoperability mandate, followed by Ghana. This should shape `docs/architecture/country-provider-model.md`, but it does not authorise building integrations outside Kenya.
- The main competitive threats are Safaricom (Fuliza Biashara, Pochi la Biashara) and Moniepoint, which entered Kenya by acquiring Sumac Microfinance Bank in March 2026.
