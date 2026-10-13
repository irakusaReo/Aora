# ADR 0004 — Base integration library and approach

- **Status:** Proposed
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
