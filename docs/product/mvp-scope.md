# AORA — Sandbox MVP Scope

- **Source:** owner's MVP definition, 2026-10-13.
- **Goal:** a test user can complete every journey below end to end in a staging environment, against real provider sandboxes where they exist and the AORA simulator where they do not. The ledger balances and reconciliation comes back clean.
- **Hard limits:** no real money, no Base mainnet, no live or production keys. Every record, response and screen is labelled sandbox. All CLAUDE.md rules apply.

Phase numbers are those of [delivery-plan.md](../architecture/delivery-plan.md).

## 1. Journeys, in build order

| # | Journey | MVP area | Phase | Real sandbox or simulator |
|---|---|---|---|---|
| J1 | Sign in; create a sandbox payment intent; webhook; ledger entry; clean reconciliation | Platform | 1 | Simulator |
| J2 | Sign in with phone and one-time code; approve a sensitive action with a PIN; admin, finance and cashier see only what their role allows; every action is in the audit log | Platform | 2 | SMS provider sandbox |
| J3 | Onboard a registered and an unregistered merchant through tiers; add a branch and staff | KONY | 3A | Simulator KYB |
| J4 | Collect an M-Pesa payment by STK push; see it in history with gross, fee and net; see it in the settlement view | KONY | 3A | Daraja sandbox |
| J5 | Operator works a reconciliation exception; looks up a user and a merchant; reads the audit trail | Ops console | 3A (grows each phase) | n/a |
| J6 | Pay out with a fee preview; refund a collection, linked to the original | KONY | 3B | Daraja sandbox B2C; refund path to verify |
| J7 | Create an API key; call `/v1` with idempotency; receive a signed webhook; replay it | KONY developer API | 3B | n/a |
| J8 | A KELO merchant is approved and a KONY workspace appears automatically; operator sees provisioning status | KELO, Ops | 4 | n/a |
| J9 | Receive USDC on Base Sepolia into merchant treasury; send USDC with a second user's approval | KONY | 5–6 | Base Sepolia |
| J10 | See KES and USDC balances that agree with the ledger, the provider and the chain | Platform | 6 | Daraja sandbox, Base Sepolia |
| J11 | Fund the one NAM product; see funding, order and holding as separate linked states; read disclosures; withdraw | NAM | 7 | Simulator investment provider |
| J12 | Sign up as a consumer; pay a KONY merchant by M-Pesa; send and receive USDC; send a payment request; see history and a receipt | CHIWO | 8 | Daraja sandbox, Base Sepolia |
| J13 | Use NAM Vault inside CHIWO | NAM | 9 | Simulator |
| J14 | Use NAM Vault inside KONY as a business investor | NAM | 10 | Simulator |
| J15 | Apply for credit; get a decision with reason codes; see total cost of credit; consent; receive a sandbox disbursement; repay from a share of incoming payments | KELO | 11 | Simulator lender; Daraja sandbox for inflows |
| J16 | Reset staging to seeded demo data and run every journey above | Staging | MVP gate | All |

Staging is first deployed in Phase 3A, because provider callbacks need a public HTTPS address, and is redeployed at the end of every later phase.

## 2. What moved because of the MVP

| Item | Was | Now | Why |
|---|---|---|---|
| Payouts with fee preview, refunds, developer API (keys, signed webhooks, replay) | Phase 12 | Phase 3B | In the MVP definition |
| Internal ops console (web) | No phase (R-8) | Starts in 3A, extended each phase | In the MVP definition |
| Staging deployment | Phase 13 | First deploy in 3A; MVP gate after Phase 11 | In the MVP definition |
| Role `finance` | Not planned | Phase 1 schema, Phase 2 permissions | In the MVP definition |
| Remaining "KONY commercial depth" (analytics, sweeps, split settlement, payment links, status page, vertical workflows) | Phase 12 | Phase 12, after the MVP | Not in the MVP definition |

## 3. Exit tests per journey

Each journey is done when its automated test passes locally and in CI, and its manual script passes in staging.

| # | Exit tests |
|---|---|
| J1 | Delivery plan §3.4 |
| J2 | Code is single-use, expires, and locks after repeated failures; PIN is stored only as a slow hash; a sensitive action fails without a fresh PIN; authorization matrix (route × role) is default-deny; every state-changing request writes one audit event |
| J3 | Registered merchant matched by registration number, unregistered by owner + name + location (ADR 0012); ambiguous match goes to review; tier limits come from configuration and are enforced; cashier is limited to collecting |
| J4 | STK push request and callback handled per Daraja's documented behaviour; callback is idempotent; timeout gives `status_unknown` and a status query, never a second push; fee uses the tariff version effective at the time; gross − fee = net exactly; journal balances |
| J5 | Each exception type can be listed, inspected and resolved with an audited reason; operator role required; no cross-tenant data without it |
| J6 | Fee shown before confirmation equals fee charged; payout needs step-up and the `finance` or `admin` role; unknown payout status is never retried automatically; refund cannot exceed the original and posts a compensating entry |
| J7 | Key shown once and stored hashed; same idempotency key returns the same result; webhook signature verifies with the published public key; replay delivers the same event ID and causes no second effect at a correct receiver |
| J8 | Brief §13.4 list (exactly one workspace, no duplicates on retry, crash recovery, backfill, correct admin, restricted stays restricted, no financial authority granted) |
| J9 | Startup fails on wrong chain ID, address or decimals; a transfer of any other token is not credited; credit only after the confirmation policy; send requires a different approver and step-up; unknown submission is not resubmitted; development signer refuses to start outside sandbox |
| J10 | Three-way reconciliation is clean on seeded data and flags each injected difference; collections, settled, available, USDC, holdings and credit are separate figures |
| J11 | Funding confirmed ≠ order confirmed ≠ holding; holding follows the provider's state only; withdrawal not complete until confirmed; no yield or return figure anywhere |
| J12 | Consumer and business contexts never mix; fees and timing shown before authorising; receipt matches the ledger entry; payment request cannot be paid twice |
| J13, J14 | Personal and business investor contexts are separate; cashier cannot see or act; unsettled funds and credit are never offered as a funding source |
| J15 | Feature flag off → no credit endpoint reachable; every decision stores reason codes and inputs; total cost shown before consent; consent stores the terms version; each repayment deduction is posted and visible; credit limit never shown as cash |
| J16 | Reset script is idempotent; health checks green; every journey script passes; ledger trial balance is zero; reconciliation has no open exceptions |

## 4. Conflicts and stretches flagged, not resolved

Tracked as M-1 to M-7 in [open-questions.md](../architecture/open-questions.md#m-flags-raised-by-the-mvp-definition). I am following the "proposed reading" for each until you say otherwise.

- **F-1 (M-1) Testnet key in `.env.local`.** Brief §3.8 says never store private keys in plaintext configuration; CLAUDE.md rule 9 says secrets never go in config files. Your ruling permits a testnet-only key. For staging I propose the platform's secret store rather than a file.
- **F-2 (M-2) API keys and webhook secrets.** Rule 9 says API keys never go in database fields. A developer API has to recognise the keys it issued. Proposed: store only hashes of AORA-issued keys, and sign webhooks with a platform key pair so no per-merchant secret is stored.
- **F-3 (M-3) Pooled testnet wallet.** "Send and receive USDC" for consumers and merchants with one development signer means AORA controls all testnet USDC. That looks like custody. It is a sandbox convenience and must be labelled; it does not decide ADR 0010.
- **F-4 (M-4) Payouts imply AORA holds merchant fiat.** Same point on the fiat side.
- **F-5 (M-5) KELO credit before the licence decision.** Sandbox only, feature flag off by default.
- **F-6 (M-6) Simulated fiat-to-USDC conversion.** Brief §3.3 requires an approved provider and legal model for real conversion. The simulator must say it is simulated and show no real rate.
- **F-7 (M-7) Named providers.** Nothing about Daraja or the SMS provider is assumed; their documentation is read and cited in the phase that integrates them. If the Daraja sandbox does not offer something the MVP lists (for example a refund or reversal call), that journey step falls back to the simulator and is reported as simulated.

No conflict was found in: tenants and roles, audit log, ledger, outbox, tariffs, NAM "no yield claims", out-of-scope list.

## 5. Credentials expected, by phase

Requested in one batch at the start of each phase, in the format in `docs/progress.md`.

| Phase | Needed |
|---|---|
| 1 | Nothing external. (GitHub push needs the `workflow` token scope; see progress.) |
| 2 | SMS provider sandbox credentials |
| 3A | Daraja sandbox app credentials and test shortcode values; public HTTPS tunnel or staging URL for callbacks; staging cloud account |
| 3B | Daraja sandbox B2C credentials, if separate (to verify) |
| 5 | Base Sepolia RPC URL; testnet signer key funded with Base Sepolia ETH and testnet USDC |
| Others | None expected |
