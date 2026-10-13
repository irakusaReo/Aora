# ADR 0015 — Smart-contract scope and safety

- **Status:** Accepted (owner scope decision, 2026-10-13). Supersedes the "no AORA contract in the MVP" position recorded under C-2.
- **Related:** ADR 0004, 0005, 0006, 0009, 0010; brief §3.5–§3.7, §6.2–§6.4, §8.1; CLAUDE.md rules 1, 2, 8, 10

**Base Sepolia only.** Mainnet deployment is forbidden in this project. It would first need an independent audit (brief §3.7), a custody decision (ADR 0010) and an owner decision recorded in a new ADR.

## Contracts

Two contracts. A third is not proposed, because no other problem in the brief needs one.

### 1. `NamUsdcVault` — single-asset vault

- **Problem it solves:** brief §6.2–§6.4 requires a NAM vault whose asset accounting, share accounting, deposits and withdrawals are explicit and reconcilable, and §6.3 forbids crediting a balance because a deposit was requested. On-chain shares make the customer's claim verifiable against the USDC actually held.
- **Scope:** holds exactly one asset, native USDC (address fixed at construction, immutable). **No yield strategy, no lending, no external calls other than to the USDC contract.** Deposit mints shares; redeem burns shares and returns USDC.
- **Share-inflation and donation attacks:** total assets are tracked in an internal accounting variable updated only by deposit and redeem, never read from the token balance, so USDC sent directly to the vault changes no share price. Virtual shares and a decimals offset remove the first-depositor rounding attack. Rounding always favours the vault.
- **Access control:** deposits and redemptions are permissionless for the share owner. One role, `guardian`, can pause **deposits only**. Nobody can pause or block redemptions, move assets, mint shares or change the asset.
- **Emergency control and its risk:** pausing deposits stops new exposure during an incident. Risk: a compromised guardian can deny new deposits (a nuisance, not a loss). It cannot trap or take funds. Stray tokens sent to the vault, and any USDC above accounted assets, are left untouched in the MVP rather than adding a sweep function with its own risk.
- **Who holds shares in the MVP:** the sandbox wallet model of ADR 0009 (AORA-controlled testnet signer, per-customer ledger claims). The contract itself does not assume that.

### 2. `AnchorRegistry` — financial-event commitments

- **Problem it solves:** brief §3.1 and §8.1 call for "financial event anchoring" and "verifiable links to internal operations" without publishing sensitive records.
- **Scope:** stores one `bytes32` commitment per ledger period: the Merkle root of that period's journal-entry digests, with the period identifier and a count. Append-only: a period can be anchored once and never changed.
- **No personal data, ever (rule 8).** A leaf is a salted hash of an internal entry identifier and its amounts; the salt stays off-chain, so a leaf cannot be linked back by guessing inputs. No phone number, name, tenant identifier or per-customer value is published. The data model and its privacy analysis are written in the specification before deployment (brief §3.6).
- **Access control:** one role, `anchorer`, may add a commitment. Nobody can alter or delete one. An `admin` can rotate the anchorer.
- **Emergency control and its risk:** rotating the anchorer key. Risk: a compromised anchorer can publish a wrong root for a period not yet anchored; it cannot rewrite history. A wrong root is detectable by recomputation, and is corrected by publishing a superseding notice for a new period identifier, never by deletion.
- **It holds no funds.**

## Engineering rules

1. **Foundry.** Pinned compiler, pinned vendored dependencies, audited standard libraries in preference to hand-written code.
2. **Non-upgradeable.** No proxies, no `delegatecall`, no self-destruct.
3. **Specification first.** `contracts/spec/<Contract>.md`: purpose, state, functions, access control, invariants, events, emergency controls and risks, privacy analysis.
4. **Tests strictly first:** unit tests, fuzz tests and invariant tests are written before the implementation.
   - Vault invariants: accounted assets ≤ USDC balance; total shares map to accounted assets; no sequence of deposits, donations and redemptions lets an account withdraw more than it put in; a redemption is always possible while deposits are paused.
   - Registry invariants: a period's commitment never changes; only the anchorer adds.
5. **Static analysis** (Slither or an equivalent verified at the time) runs in CI. Findings are fixed or recorded with a reason.
6. **Deployment by script only.** Scripts refuse any chain ID other than Base Sepolia's. Addresses, constructor arguments, compiler settings and transaction hashes are recorded in `contracts/deployments/base-sepolia.json`. Source is verified on the Base Sepolia block explorer.
7. **Keys:** the deployer and role-holder keys are testnet keys from the local sandbox signer (ADR 0009). They never hold mainnet funds.
8. **ABIs** reach the API as generated, version-controlled artifacts.
9. **The ledger stays the source of truth.** Vault shares and anchors are reconciled against it; neither replaces it.

## What "tested" does not mean

These contracts will have had no independent review. They are fit for a testnet demonstration only. That statement is repeated in each specification and in `contracts/README.md`.

## Alternatives considered

- **ERC-4626 with balance-based accounting:** standard and composable, but the donation attack surface is exactly what the owner asked to close. The vault keeps a 4626-like interface with internal accounting.
- **Per-event anchoring:** more gas, and far more linkability, for no stated benefit.
- **A third contract for layaway or merchant escrow:** those funds are fiat in the MVP; a contract would solve nothing.
- **Upgradeable contracts:** forbidden by default in the brief.

## Consequences

- The chain phase must come before the NAM vault backend.
- A second toolchain (Foundry) and a Solidity review burden enter the repository.
- Needs from the owner: a Base Sepolia RPC URL, a funded testnet key, and a block-explorer API key for verification.
