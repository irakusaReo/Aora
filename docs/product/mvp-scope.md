# AORA — Sandbox MVP Scope

- **Source:** owner's MVP definition and rulings of 2026-10-13 (including the hosting, mobile, rails, contracts and KELO marketplace rulings). This version replaces the earlier one.
- **Goal:** a test user can complete every journey below end to end on **staging** (Vercel "Production" target, Neon `main`), against real provider sandboxes where credentials exist and the AORA simulator where they do not, with Base Sepolia for anything on-chain. The ledger balances and reconciliation comes back clean.
- **Hard limits:** no real money, no Base mainnet, no live or production keys. Every record, response and screen is labelled sandbox. All CLAUDE.md rules apply.

From Phase 2 on, the phase numbers below are the authoritative ones.

## 1. In scope

1. **Shared platform** — phone one-time-code sign-in (Africa's Talking sandbox), PIN step-up, tenants and roles (admin, finance, cashier), consent records, audit log, double-entry ledger, outbox and cron jobs, reconciliation with an exception queue, versioned tariffs, rate limiting.
2. **KONY** (web and mobile) — tiered onboarding for registered and unregistered businesses; branches, staff and roles; collections; transaction history with gross, fee and net; settlement view; payouts with fee preview; refunds; USDC treasury on Base Sepolia (receive, and send with approval); developer API (`/v1`, API keys, idempotency, signed webhooks with replay, OpenAPI).
3. **Rails** — M-Pesa via Daraja (Kenya), Airtel Money (Kenya), MTN MoMo (one non-Kenyan market, sandbox only), one bank. Simulator fallback for each.
4. **KELO** (web and mobile; merchant side inside KONY) — store enlistment with automatic KONY provisioning; catalogue with three listing types, taxonomy, search and moderation; marketplace; "Pay with KELO" through payment links and the developer API; plan types Pay in N, monthly financing and layaway; eligibility with reason codes; disclosure and consent; repayments; returns and disputes; merchant settlement and dashboard. Credit behind the `kelo_credit` flag.
5. **CHIWO** (web and mobile) — consumer sign-up; pay a KONY merchant; send and receive USDC on Base Sepolia; payment requests, history and receipts.
6. **NAM Vault** (inside CHIWO and KONY) — one product on the AORA vault contract; funding, order and holding as separate linked states; disclosures; withdrawal; no yield claims.
7. **Smart contracts** — `NamUsdcVault` and `AnchorRegistry` on Base Sepolia (ADR 0015).
8. **Internal ops console** — reconciliation exceptions, provisioning status, listing review queue, user and merchant lookup, audit trail.
9. **Staging** — seeded demo data across all twelve KELO categories, health checks, a reset runbook.

## 2. Out of scope

Card acceptance; a real fiat-to-USDC conversion provider (simulator, labelled); production custody; live money; mainnet; merchant working-capital financing; asset-financing device locks (data model only); KELO in-store QR; multi-merchant orders; app-store distribution.

## 3. Build order

Constraints applied: hosting first; rails one per checkpoint after Daraja; contracts before the NAM vault backend; mobile after the web flow for a journey is stable; KELO in checkpoints (a) to (h).

| Phase | Checkpoints | Delivers |
|---|---|---|
| **2 Hosting foundation and sign-in** | 2A lint rule, Neon-ready database access, cron job routes · 2B Neon staging and first Vercel deployment · 2C one-time-code sign-in, PIN step-up · 2D permissions, consent, rate limiting | The API on a real URL with real sign-in |
| **3 KONY core (web)** | 3A onboarding, branches, staff, tariffs, shared packages, `kony-web`, `internal-ops` · 3B Daraja collection end to end · 3C settlement view, payouts (Daraja B2C), refunds · 3D developer API | A merchant collects, pays out and refunds through M-Pesa sandbox |
| **4 More rails** | 4A Airtel Money KE · 4B MTN MoMo (market per O-5) · 4C bank (per O-6) | Multi-rail under one merchant identity |
| **5 KELO commerce** | 5A (a) enlistment, provisioning, catalogue, moderation · 5B (b) consumer marketplace in `kelo-web` · 5C (c) layaway | KELO demoable without credit |
| **6 Chain and contracts** | 6A Base Sepolia config, transfer verification, local signer · 6B contracts: specs, tests, deploy, verify · 6C KONY USDC treasury, three-way reconciliation, anchoring job | USDC and the two contracts on testnet |
| **7 NAM Vault** | 7A vault backend on the contract · 7B NAM in `kony-web` | One vault product for businesses |
| **8 CHIWO (web)** | 8A sign-up, pay a merchant · 8B USDC send and receive, requests, receipts · 8C NAM in `chiwo-web` | The consumer product |
| **9 KELO credit** | 9A (d) plans, checkout, underwriting behind the flag · 9B (e) repayments and collections · 9C (f) returns and disputes · 9D (g) merchant dashboard in KONY | BNPL end to end |
| **10 Mobile** | 10A `kony-mobile` · 10B `chiwo-mobile` · 10C (h) `kelo-mobile` and KELO merchant screens in `kony-mobile` | Native apps for the stable journeys |
| **11 MVP gate** | Seed data in all twelve categories, health checks, reset runbook, every journey on staging | The MVP |

**On layaway before credit:** I agree, and the order above does it (5C before 9A). Layaway needs orders, holding accounts, settlement on fulfilment and refunds, which credit also needs, but no credit decision, no licence question and no bureau or ID provider. One caution: it means AORA's sandbox holds consumers' money before delivery, which is a custody-like assumption (open question O-9) and must be labelled like M-4.

**Why CHIWO comes after KELO commerce:** KELO consumers use the same AORA identity that Phase 2 builds, and pay by M-Pesa through Phase 3's rail, so KELO does not wait for CHIWO. Repaying "from a CHIWO balance" arrives with Phase 9, after CHIWO exists.

## 4. Journeys and exit tests

Each journey is done when its automated test passes locally and in CI and its script passes on staging. "Sim" marks a simulator fallback that must be reported as simulated.

### Platform, KONY, CHIWO, NAM

| # | Journey | Phase | Exit tests |
|---|---|---|---|
| J1 | Sign in; create a payment intent; webhook; ledger entry; clean reconciliation | 1 (done) | Delivery plan §3.4 |
| J2 | Sign in on staging with phone and one-time code; set a PIN; approve a sensitive action with it; each role sees only what it may | 2 | Code is single-use, expires, locks after failures and is never the fixed code on a deployed environment; PIN stored only as a slow hash; sensitive action fails without a fresh PIN; route × role matrix is default-deny; each state-changing request writes one audit event; rate limits hold across instances |
| J3 | Onboard a registered and an unregistered merchant; add a branch and staff | 3A | ADR 0012 matching; ambiguous match goes to review; tier limits from configuration; cashier limited to collecting |
| J4 | Collect by M-Pesa STK push; see gross, fee and net; see settlement | 3B | Behaviour per Daraja's current documentation; callback idempotent; timeout gives `status_unknown` and an inquiry, never a second push; fee from the tariff version in effect; gross − fee = net exactly |
| J5 | Operator works an exception; looks up a user and a merchant; reads the audit trail | 3A onward | Each exception type listed, inspected and resolved with an audited reason; operator role required |
| J6 | Pay out with a fee preview; refund a collection | 3C | Previewed fee equals charged fee; payout needs step-up and `finance` or `admin`; unknown payout never retried automatically; refund cannot exceed the original and posts a compensating entry |
| J7 | Create an API key; call `/v1` idempotently; receive a signed webhook; replay it | 3D | Key shown once and stored hashed; signature verifies with the published public key; replay causes no second effect |
| J8 | Collect on Airtel, on MTN and through the bank, under one merchant | 4 | Shared adapter contract suite passes per rail; each record carries its country and asset; a sandbox test currency is shown as one; no cross-currency total |
| J9 | Receive USDC into merchant treasury; send with a second user's approval | 6 | Startup fails on wrong chain ID, address or decimals; other tokens never credited; credit only after the confirmation policy; unknown submission never resubmitted; development signer refuses to start outside sandbox |
| J10 | Balances agree across ledger, providers and chain; a ledger period is anchored | 6C | Three-way reconciliation clean on seeded data and flags each injected difference; the anchored root recomputes from the ledger; no personal data in any transaction |
| J11 | Fund the NAM product; see funding, order and holding separately; read disclosures; withdraw | 7 | Holding follows contract state only; withdrawal not complete until confirmed; vault invariants hold; no yield figure anywhere |
| J12 | Consumer signs up; pays a merchant by M-Pesa; sends and receives USDC; sends a payment request; gets a receipt | 8 | Personal and business contexts never mix; fees and timing shown before authorising; a request cannot be paid twice |
| J13 | NAM Vault inside CHIWO and inside KONY | 7B, 8C | Personal and business investor contexts separate; cashier cannot see or act |

### KELO

| # | Journey | Phase | Exit tests |
|---|---|---|---|
| K1 | A merchant enlists a store, receives a KONY workspace and lists an item | 5A | Brief §13.4 list (exactly one workspace, retries create no duplicate, crash recovery, backfill, restricted stays restricted, no financial authority granted); category vetting from configuration; a prohibited item cannot be submitted; a listing is invisible until reviewed; taxonomy has no category in code |
| K2 | A consumer buys electronics on Pay in N through the M-Pesa sandbox; the merchant is settled on delivery; the consumer finishes repaying; the ledger balances | 9A–9B | Flag off → no credit route reachable; schedule shown before acceptance equals the schedule charged, to the minor unit; instalments sum exactly to the total; consent stores the terms version; stock is reserved and cannot be oversold under concurrent orders; merchant settled only after delivery confirmation, net of the discount fee; every repayment posted once; receivable reaches zero; trial balance zero; reconciliation clean |
| K3 | A consumer finances a solar home system with monthly financing and a deposit | 9A–9B | Deposit rule from the template; fees or interest disclosed and equal to what is charged; agreement unaffected by a later configuration change; limit shown with its drivers and never as cash; early repayment has no penalty |
| K4 | A consumer completes a layaway purchase of a holiday package | 5C | No credit decision or agreement exists; payments sit in "layaway funds held", not with the merchant; capacity reserved for the session; fulfilment and merchant settlement only after the last payment; cancellation refunds follow the configured rule exactly |
| K5 | A return partway through a plan pauses repayments and reduces the balance | 9C | No reminder or late charge on the paused amount; balance reduced only by compensating entries; overpayment refunded; clawback from the merchant follows the configured rule and never hides a shortfall |
| K6 | A declined application shows its reasons | 9A | Decision stores reason codes and an input snapshot; the consumer sees plain-language reasons and what would change the outcome; nothing is charged; no order is placed |
| K7 | The merchant follows BNPL sales, orders, returns, fees and settlements in KONY | 9D | Figures equal the ledger; the merchant never sees a consumer's limit, decision or credit profile |
| K8 | The same KELO journeys on mobile | 10C | Same exit tests through the app; idempotency key survives an app restart; session token only in secure storage |

Demo data covers all twelve categories. K2 (electronics), K3 (solar) and K4 (holidays) are the three tested in depth.

### Gate

| # | Journey | Exit tests |
|---|---|---|
| G1 | Reset staging to seeded data and run every journey | Reset is idempotent; health checks green; all journey scripts pass; trial balance zero; no open reconciliation exception; contract addresses match `contracts/deployments/` |

## 5. Flags carried from the first MVP definition

M-1 to M-7 are resolved (see [open-questions.md](../architecture/open-questions.md)). New owner defaults and open questions are O-1 to O-10 there. Nothing in this scope conflicts with the amended brief or CLAUDE.md beyond those recorded items.

## 6. Credentials by phase

Requested in one batch at the start of each phase, in the CLAUDE.md format.

| Phase | Needed |
|---|---|
| 2 | Neon account and project; Vercel account on the Pro plan and project; Africa's Talking sandbox username and API key |
| 3 | Daraja sandbox app credentials, test shortcode and passkey values, B2C sandbox credentials (exact list to verify from Daraja's documentation) |
| 4 | Airtel Africa developer sandbox credentials; MTN MoMo sandbox subscription key and API user; the chosen bank's sandbox credentials |
| 5 | Image storage (O-7), if adopted |
| 6 | Base Sepolia RPC URL; a testnet signer key funded with Base Sepolia ETH and testnet USDC (local only); block-explorer API key |
| 9 | ID-verification sandbox; credit-bureau sandbox |
| 10 | Expo account or EAS token, only when binaries are built |
