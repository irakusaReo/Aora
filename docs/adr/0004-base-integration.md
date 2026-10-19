# ADR 0004 — Base integration library and approach

- **Status:** Accepted (owner ruling, 2026-10-13)
- **Date:** 2026-10-13
- **Related:** brief §3, §9.2, §9.3, §13.2; CLAUDE.md rules 1, 6, 7, 10; open questions [C-2](../architecture/open-questions.md#c-2), [C-3](../architecture/open-questions.md#c-3), [D-2](../architecture/open-questions.md#d-2), [D-11](../architecture/open-questions.md#d-11), [E-4](../architecture/open-questions.md#e-4)

Nothing in this ADR is installed in Phase 0.

## Context

Base is the only chain. The brief wants one dedicated integration module, maintained libraries, no custom client, no chain-selection abstraction, and explicit handling of unknown transaction states. Development must use a test network or local chain, never mainnet.

## Decision

- **One `chain` module** is the only code that talks to Base. No other module imports an EVM library or holds an RPC URL.
- **Library: viem**, a maintained, TypeScript-native EVM library whose amounts are native `bigint`. Exact version and API surface are confirmed when it is first installed (Phase 5).
- **Static, environment-specific chain config:** network identity, chain ID, native USDC address, token decimals, confirmation policy, RPC endpoints. Selected by deployment environment only, never by request, user or tenant. Sandbox environments contain a testnet entry only; no mainnet entry exists in the repository before production readiness (C-3).
- **Startup verification:** the process refuses to start if the RPC's chain ID differs from config, or the configured token's on-chain decimals differ from config.
- **Explicit transaction state machine** with at least: `prepared`, `authorization_pending`, `submitted`, `pending_confirmation`, `confirmed`, `failed`, `reverted`, `status_unknown`, `reconciliation_required` (brief §3.4). A transaction hash or a signature never implies `confirmed`.
- **No automatic resubmission** when status is unknown. The module queries by hash and by sender nonce, and escalates to `reconciliation_required` if it still cannot tell.
- **Verification by content, not by hash:** a transfer counts only if the receipt succeeded and the decoded transfer event matches the expected token contract, recipient and amount, under the confirmation policy.
- **Signing sits behind a `Signer` interface** with no production implementation until ADR 0009 is decided. Tests use throwaway keys on a local chain.
- **Read paths should use two independent RPC providers** before crediting a balance (D-11).
- **First on-chain scope is observing and verifying USDC transfers.** AORA writes no contract of its own until a product requires one (C-2).

## Alternatives considered

- **ethers:** mature and widely used; viem is preferred for stricter typing and `bigint` amounts. Either would satisfy the brief.
- **A vendor's all-in-one SDK:** ties the integration to one vendor's wallet and RPC choices before D-1 and D-2 are made.
- **Custom JSON-RPC client:** forbidden by the brief without a specific justification.
- **A generic multi-chain abstraction:** forbidden by CLAUDE.md rule 1.

## Consequences

- Replacing the RPC provider or library touches one module.
- Unknown states are first-class, so some operations will wait for an operator rather than retry; this is intended.
- Anything that submits a transaction is blocked on D-1 and D-2; read-only verification is not.
- Whether tests may fork mainnet read-only needs an explicit answer (E-4).

## Addendum, 2026-10-18: what checkpoint 5A built (phase-5 plan)

- **Library:** viem 2.57.2, pinned exact (P5-1). A lint rule lets only `services/api/src/modules/chain` import it. Public clients run with `cacheTime: 0`: viem otherwise caches the block number for about four seconds.
- **Config:** `chain/config.ts` holds Base Sepolia only, with the native USDC address and its provenance. Environment: `BASE_SEPOLIA_RPC_URL` (https; a plain-http loopback address only on a developer machine) and `SANDBOX_SIGNER_PRIVATE_KEY`. No RPC URL: every chain feature is off and `/v1/health` says `not_configured`.
- **Startup verification on serverless:** Vercel has no long-lived process, so the check (chain ID, code at the USDC address, `decimals()`, ledger exponent) runs once per instance on its first chain call, before anything else may run. A wrong chain, token or exponent stays refused for the life of the instance; an unreachable RPC may be retried. `/v1/health` reports the result.
- **State machine** as decided above, with the signed transaction, hash and nonce committed as `submitted` before broadcast; sends never retry at the transport level; recovery is by receipt, by the node's pool, and by the sender's nonce. An operation whose nonce was used by another transaction, or that stays unknown past a time limit, goes to `reconciliation_required` and opens a `chain_operation_unresolved` exception.
- **Nonces** are allocated from a locked `chain.signer_nonce` row (the larger of the stored next nonce and the node's pending count).
- **Inbound observation** scans `Transfer` events to the sandbox wallet from every token contract over bounded ranges from a stored cursor. Native USDC is `observed`, then `confirmed` under `chain.confirmation_policy`, or `dropped` if its block is reorganised away. Any other token is `unexpected_asset` with an exception (ADR 0005 point 6). Nothing is credited in 5A; crediting needs attribution (5C).
- **Local chain:** anvil with chain ID 84532 and a TEST-ONLY token's code at the configured USDC address (P5-2), so tests exercise the real config entry and never relax the signer's chain guard. No mainnet fork (E-4 stays open).
- **Network fees** are recorded on each operation and not ledgered in the sandbox (P5-7).

## Addendum, 2026-10-18: what checkpoint 5C built

- **Attribution (P5-5):** a deposit is credited only if its sender was registered, by a signature over a one-time challenge, before the deposit was observed. Anything else is `unattributed` with an exception; an operator can attribute it to a workspace or to AORA's own sandbox funding, with an audited reason (`POST /v1/ops/chain/transfers/{id}/attribution`).
- **Withdrawals (P5-9):** requested by an admin or finance member with a step-up, approved by a different admin with a step-up, then signed and broadcast once through the chain-operation state machine.
- **Three-way reconciliation:** run by the chain job once the scan has caught up, at the scan's last block: on-chain balance against observed inbound minus AORA's mined outbound; the ledger wallet account against credited minus completed; each credited transfer and completed withdrawal against its journal entry or transaction. Differences open `chain_balance_mismatch`, `ledger_mismatch` or `chain_operation_mismatch`; nothing is corrected automatically.
- **Anchoring (P5-10):** each finished UTC day (closed 15 minutes after midnight) becomes a salted Merkle root committed to the AnchorRegistry once it is deployed; roots are recomputed from the ledger and compared with the chain (`anchor_mismatch`). Calldata of every AORA transaction is tested to carry only the token transfer or the anchor call.

## Addendum, 2026-10-19 (Phase 7B: consumer addresses and withdrawals, phase-7 plan P7-9, P7-11)

Deposit addresses, credited deposits and withdrawals may belong to a CHIWO consumer instead of a workspace (`consumer_account_id` on `chain.address_challenge`, `chain.registered_address`, `chain.observed_transfer` and `chain.withdrawal`, with exactly one owner). The proof is the same signed one-time challenge, worded for a personal account. An address is active for one owner at a time across workspaces and consumers. A consumer withdraws only to an address they registered, after a PIN step-up, with no second approver; the chain operation, confirmation policy, never-resend rule and three-way reconciliation are unchanged.
