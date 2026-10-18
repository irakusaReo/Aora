# ADR 0009 — Wallet and signing model

- **Status:** Proposed — **Decision pending owner input**
- **Date:** 2026-10-13
- **Related:** brief §3.8, §12.2; CLAUDE.md rules 9, 11; open questions [D-1](../architecture/open-questions.md#d-1), [D-2](../architecture/open-questions.md#d-2); [ADR 0010](0010-custody-model.md)

No vendor is named or recommended here. No provider capability is assumed; every capability must be verified against the chosen provider's documentation before it is relied on.

## Context

Brief §3.8 requires a documented answer to: who controls signing keys, who can authorize a transaction, how recovery works, how merchant signatories approve, how signing requests are protected, how compromised credentials are handled, how limits and policy are enforced, and who pays network fees. These answers follow from the custody model (ADR 0010), which is not decided. Private keys and seed phrases must never be in code, config, database fields or logs.

## Options

| Option | Who holds keys | Fits custody model | Main strengths | Main risks and costs |
|---|---|---|---|---|
| A. User-owned external wallets | The customer, in their own wallet app | Non-custodial | AORA holds no keys; smallest regulatory surface for custody | Customers must understand wallets, which the brief says they should not need to (§2.1); recovery is the customer's problem; merchant multi-signatory approval is hard |
| B. Embedded wallets from a wallet-infrastructure provider (key shares or secure enclaves) | Split between customer and provider, per the provider's design | Non-custodial or shared, depending on the provider's legal position | Phone-first experience without seed phrases; recovery flows provided | Dependence on one vendor; recovery tied to the authentication factor (SIM-swap exposure if that is a phone number); custody classification needs legal confirmation |
| C. Smart accounts (account abstraction) with policy on-chain | Customer-held signer(s), with rules in the account contract | Non-custodial | Merchant multi-approver rules, spending limits and sponsored fees can be enforced by the account itself | More moving parts; contract risk; relies on supporting infrastructure whose availability on Base must be verified |
| D. AORA-operated keys in an HSM or cloud key-management service | AORA | AORA custodial | Simple user experience; full control of policy and limits | AORA is custodian with the licensing, security and liability that implies; highest-value attack target |
| E. Signing through a licensed custodian's API | The custodian | Third-party custodial | Custody risk and much of the compliance burden sit with a specialist | Cost; dependence on custodian's policies, limits and uptime; integration is specific to the custodian |

Options can be combined by product (for example, one model for consumers and another for merchant treasury).

## What is decided regardless of option

- All signing sits behind one `Signer` interface in the `chain` module (ADR 0004). Domain code never sees key material.
- Authorization (who may approve, step-up, limits, merchant signatory rules) is enforced server-side before any signing request, whichever option signs.
- Development, test and any future production keys are separate. Tests use throwaway keys on a local chain only.
- A signature or a returned transaction hash is never treated as completion.

## What is needed from the owner

1. The custody model (ADR 0010).
2. Whether consumers and merchants may use different models.
3. Who pays network fees: customer, AORA, or priced into disclosed fees.
4. Then a provider shortlist to evaluate against verified documentation.

## Interim ruling for the testnet MVP (2026-10-13)

The production decision is still pending. For the sandbox MVP on Base Sepolia only:

- The `Signer` interface is backed by a **local development signer** that loads one testnet private key from `.env.local` (git-ignored, never committed, never logged, never stored in the database).
- The signer is **forbidden outside sandbox**. The process refuses to start if the development signer is configured and either `AORA_MODE` is not `sandbox` or the connected chain ID is not Base Sepolia's.
- The key must never have held mainnet funds. A key that controls value on any mainnet is refused.
- This makes the MVP's USDC wallet an AORA-controlled testnet wallet with per-customer ledger claims. That is a sandbox convenience and decides nothing about production custody (ADR 0010).
- In staging the key should come from the platform's secret store, injected as an environment variable, rather than from a file on disk (see `docs/product/mvp-scope.md`, flag F-1).

## Consequences of leaving this open

- Phase 5 can build chain config, transfer verification, the transaction state machine and tests on a local chain.
- Phase 5 cannot build real transaction submission, recovery or merchant signatory flows.
- Phase 7 (NAM Vault) cannot start.

## Addendum, 2026-10-18: the sandbox signer as built (owner decision 2026-10-18; phase-5 plan P5-4)

- `DevelopmentSigner` (`services/api/src/modules/chain/signer.ts`) is created only after startup verification, with the chain ID the RPC reported, and refuses any mode but sandbox and any chain but 84532. It also refuses to sign a transaction for another chain ID. The key is held in a closure: no property, `toJSON` or `toString` reveals it, and tests check the logs never contain it.
- One AORA-controlled testnet wallet, `0xEfBB9b5761BB2633cCB94a294628Dd63124Cedb5`, generated by `services/api/scripts/generate-sandbox-signer.mjs` (writes the key to `.env.local`, prints only the address). It goes to a sensitive Vercel variable on `aora-api` once the owner has funded it.
- "A key that has held mainnet funds is refused" is not checked by code: checking would need a mainnet RPC, which this project never contacts. The key was generated fresh for this purpose on 2026-10-18.
