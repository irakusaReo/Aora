# ADR 0005 — Native USDC policy

- **Status:** Accepted (owner ruling, 2026-10-13)
- **Date:** 2026-10-13
- **Related:** brief §3.2, §8.2, §9.3; CLAUDE.md rules 2, 3; open questions [C-4](../architecture/open-questions.md#c-4)

## Context

Native USDC on Base is the only stablecoin. Bridged USDC (USDbC), USDT and every other token must be rejected, not substituted. The token address must live only in verified, environment-specific chain config, and token precision must come from verified config rather than assumption.

## Decision

1. **Exactly one token contract is trusted per environment.** There is no token registry, no admin screen to add tokens and no user-supplied token address anywhere in the API.
2. **The address lives in one place:** the chain config of the `chain` module (ADR 0004). No other module, test fixture, environment variable or document is a source for it. Other code refers to the asset as `USDC`, never by address.
3. **Each config entry records its provenance:** source URL at the issuer, date verified, and who verified it. An entry without provenance fails review. Both the mainnet and Base Sepolia addresses were verified on 2026-10-13 (see below).
4. **Startup checks:** chain ID matches; contract code exists at the address; on-chain `decimals` equals the configured value. Any mismatch stops the process.
5. **Amounts are integer base units** (`bigint` in code, `BIGINT` in the ledger). The decimal exponent is read from config. Conversion to a display string happens only at the presentation edge. No floating point at any step.
6. **Inbound transfers of any other token** to an AORA-watched address are never credited. They are recorded as an `unexpected_asset` exception for an operator.
7. **A transfer event is accepted only if emitted by the configured contract.** Matching on token symbol or name is never sufficient.
8. **No silent substitution:** if native USDC is unavailable for an operation, the operation fails with a stable error code.

## Verified addresses (C-4 resolved)

Verified on 2026-10-13 against Circle's documentation, "USDC contract addresses", <https://developers.circle.com/stablecoins/usdc-contract-addresses>.

| Network | Native USDC address | Use |
|---|---|---|
| Base Sepolia (testnet) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | Sandbox chain config, from Phase 5 |
| Base (mainnet) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | Matches brief §3.2. **Not entered in any config** until production readiness |

This table is the provenance record, not a configuration source. When the `chain` module is created, its config entry carries the same URL and date, and the startup checks in point 4 still apply. Chain IDs and token decimals are read from the chain and from Base's own documentation at that time, not from memory.

## Alternatives considered

- **Configurable token allow-list:** more flexible, and exactly the surface through which a bridged or fake token becomes trusted.
- **Address in an environment variable:** easy to change per deploy, but unreviewed, unversioned and without provenance.
- **Resolving the address at runtime from a third-party token list:** adds an external trust dependency for the most sensitive value in the system.

## Consequences

- Adding or changing a supported asset requires a code change, a review and a new ADR. This is intended friction.
- A wrong address is caught at review (provenance) and again at startup (chain checks), not after funds move.
- The ledger's `asset` row for USDC takes its exponent from this config, so ledger and chain cannot disagree on precision.
