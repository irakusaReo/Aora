# ADR 0006 — Smart-contract toolchain

- **Status:** Proposed
- **Date:** 2026-10-13
- **Related:** brief §3.7, §6.2, §11.2, §13.2; CLAUDE.md rule 10; open questions [C-2](../architecture/open-questions.md#c-2), [D-1](../architecture/open-questions.md#d-1), [E-4](../architecture/open-questions.md#e-4)

Nothing in this ADR is installed in Phase 0, and no contract is planned before a product needs one.

## Context

Any AORA-controlled contract that touches USDC or vault assets needs a written specification, unit and integration tests, invariant and adversarial tests, an upgradeability decision, and an independent review before real funds. Whether AORA writes any contract at all is open: it depends on the anchoring question (C-2) and the custody model (D-1).

## Decision

- **Toolchain: Foundry**, with contracts in a top-level `contracts/` directory using the `src/`, `test/`, `script/` layout the brief already shows (§11.2). It provides Solidity-native unit, fuzz and invariant testing and a local chain for the backend's integration tests.
- **`contracts/` is created only when the first contract is specified.** Until then the backend's chain tests use the local chain with a plain test token.
- **Non-upgradeable by default.** An upgradeable contract needs its own ADR naming who can upgrade and under what controls (§3.7).
- **Pinned compiler version and pinned, vendored dependencies.** Audited standard libraries are preferred over hand-written token or access-control code.
- **Every contract has a specification document first,** then tests, including invariant tests for asset and share accounting.
- **Deployments in sandbox phases go to a local chain or a Base test network only.** Deployment scripts refuse to run against the mainnet chain ID until production readiness. Deployed addresses are recorded in `contracts/deployments/` per environment.
- **Contract ABIs reach the backend as generated, version-controlled artifacts,** never hand-copied.

## Alternatives considered

- **Hardhat:** stays in the TypeScript toolchain, but fuzz and invariant testing are less direct, and those are the tests §3.7 demands.
- **Both:** two toolchains to maintain for no current benefit.
- **No contracts ever (use only third-party contracts):** possible if C-2 is answered "no anchoring" and vault products are all provider-run. Then this ADR stays unused, which is fine.

## Consequences

- A second, non-Node toolchain in the repository and in CI once contracts exist.
- Solidity tests need reviewers who can read Solidity.
- The local chain gives deterministic tests for reverted, dropped and delayed transactions without external access.
