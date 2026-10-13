# ADR 0010 — Custody model

- **Status:** Proposed — **Decision pending owner input**
- **Date:** 2026-10-13
- **Related:** brief §3.8, §6.1, §6.5, §7.3; lessons §2; open questions [D-1](../architecture/open-questions.md#d-1), [D-4](../architecture/open-questions.md#d-4); [ADR 0009](0009-wallet-and-signing.md)

No vendor or custodian is named or recommended here. Regulatory statements are deliberately absent: the applicable Kenyan rules for payments, virtual assets and investments are **to verify** with counsel.

## Context

Brief §6.5: "Do not assume that AORA can custody customer funds… merely because it can deploy a smart contract." Custody must be documented with the responsible legal entity, key control, contracts and regulatory requirements before any live deposit or withdrawal. Custody has two separate parts that may be answered differently:

- **Digital assets:** who controls the keys for customer USDC.
- **Fiat:** who holds merchant collections between payment and payout. Lessons §2 requires every balance view to name where funds sit and who controls them.

## Options — digital assets (USDC)

| Option | Description | AORA's role | Strengths | Risks and costs |
|---|---|---|---|---|
| 1. Non-custodial | Customers control their own keys (ADR 0009 options A–C) | Software provider; never able to move customer USDC unilaterally | Smallest custody liability; AORA is not a honeypot | Recovery and support are harder; some products (pooled vaults, automated sweeps) are harder to offer; whether a given wallet design counts as non-custodial is a legal question |
| 2. AORA custodial | AORA controls keys, usually pooled wallets with per-customer ledger claims | Custodian | Simplest experience; full product flexibility | Heaviest licensing, capital, security and audit burden; loss of keys is loss of customer funds |
| 3. Third-party licensed custodian | A custodian holds assets; AORA instructs through its API | Introducer or technology layer, per contract | Custody risk sits with a specialist | Fees; dependence on custodian; need to reconcile custodian records against the ledger |
| 4. Hybrid by product | For example, non-custodial for consumer transfers, custodian for merchant treasury and vaults | Mixed | Fits each product's needs | Two models to build, explain and reconcile |

## Options — fiat (merchant collections)

| Option | Description | Consequence for the product |
|---|---|---|
| F1. Merchant's own provider account | Payments land in an account the merchant owns at the provider; AORA only observes and reports | AORA holds no fiat; payouts and sweeps are limited to what the provider lets a third party instruct (to verify) |
| F2. Licensed partner holds funds | A licensed partner collects into its own safeguarded account; AORA is the technology layer | AORA's ledger mirrors the partner's records; balance views name the partner as controller |
| F3. AORA holds funds under its own authorisation | Collections land in AORA's safeguarded account | Full control of settlement and payouts; needs AORA's own licence and trust arrangements |

## What is decided regardless of option

- The ledger (ADR 0003) records **claims and locations separately**: what a customer is owed, and where the backing asset actually sits. Each account names its controlling legal entity as data.
- Reconciliation compares ledger claims against the actual holder's records (provider, custodian or chain) and raises exceptions on any difference.
- No screen or API response implies AORA holds funds that another entity controls.
- No live custody of any kind before the model, entity and contracts are documented (brief §6.5).

## What is needed from the owner

1. Digital-asset option (1–4), per product if hybrid.
2. Fiat option (F1–F3) for Kenya at launch.
3. The legal entity responsible in each case (D-4).

## Interim ruling for the testnet MVP (2026-10-13)

The production decision is still pending. The sandbox MVP uses an AORA-controlled Base Sepolia wallet (ADR 0009 interim ruling) and an AORA-controlled sandbox collection account at the payment provider's sandbox. Both are labelled sandbox assumptions on every balance view. Neither is a custody decision.

## Consequences of leaving this open

- Phases 1–4 are **not** blocked: the sandbox slice uses a simulator, and its chart of accounts is labelled as a sandbox assumption.
- The real chart of accounts for merchant funds cannot be finalised (needed before Phase 3 exits).
- ADR 0009 cannot be decided.
- Phase 7 (NAM Vault) cannot start.
