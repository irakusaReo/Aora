# AnchorRegistry — specification

> **Testnet demonstration only.** This contract has had no independent review. It is deployed to Base Sepolia only (ADR 0015).

## Purpose

Publishes one commitment per ledger period: the Merkle root of that period's journal-entry digests, with a period identifier and an entry count (brief §3.1, §8.1; ADR 0015). Anyone holding the off-chain data can recompute the root and check it against the chain; nobody can read the ledger from the chain. It holds no funds.

## State

| Name       | Type                                  | Meaning                                                                        |
| ---------- | ------------------------------------- | ------------------------------------------------------------------------------ |
| `owner`    | OpenZeppelin `Ownable2Step`           | The admin. Can rotate the anchorer; ownership moves only by propose and accept |
| `anchorer` | `address`                             | The only address that may add a commitment                                     |
| `anchors`  | `mapping(bytes32 periodId => Anchor)` | `Anchor { bytes32 root; uint64 entryCount; uint64 anchoredAt; }`               |

`periodId` is `keccak256` of the period's label, for example `keccak256("ledger-day:2026-10-18")`. The label format is fixed by the API (phase-5 plan P5-10).

## Functions

- `anchor(bytes32 periodId, bytes32 root, uint64 entryCount)`: anchorer only. Reverts if `root` is zero or the period is already anchored. Stores the commitment with `block.timestamp` and emits `Anchored`.
- `anchorOf(bytes32 periodId) returns (Anchor)`: view.
- `setAnchorer(address)`: owner only; reverts on the zero address; emits `AnchorerChanged`.
- `transferOwnership`, `acceptOwnership`: OpenZeppelin `Ownable2Step`. `renounceOwnership` is disabled (it reverts), so the anchorer can always be rotated.

No function changes or deletes a stored commitment. No upgrade path, no `delegatecall`, no self-destruct.

## Access control

| Function                                | Who                      |
| --------------------------------------- | ------------------------ |
| `anchor`                                | `anchorer`               |
| `setAnchorer`                           | `owner`                  |
| `transferOwnership` / `acceptOwnership` | `owner` / proposed owner |

## Invariants (tested)

1. Once a period is anchored its commitment never changes.
2. Only the anchorer adds commitments; after rotation the old anchorer cannot.
3. The zero root is never stored.

## Events

`Anchored(bytes32 indexed periodId, bytes32 root, uint64 entryCount)`, `AnchorerChanged(address previous, address current)`, and `Ownable2Step`'s ownership events.

## Emergency controls and risks

- Rotating the anchorer is the emergency control. A compromised anchorer can publish a wrong root for a period not yet anchored; it cannot rewrite an existing one. A wrong root is detected by recomputation and corrected by publishing a superseding notice under a new period identifier, never by deletion (ADR 0015).
- A compromised owner can install a hostile anchorer, with the same limit.

## Privacy analysis (CLAUDE.md rule 8)

- On chain: a period identifier derived from a date label, a 32-byte root and a count. Nothing per customer, per tenant or per transaction.
- A leaf (computed off chain) is `keccak256(salt ‖ entry_id ‖ posting_digest)`. The posting digest covers account type, direction, amount and asset only: no tenant identifier, no phone number, no name. The per-period salt is 32 random bytes kept in AORA's database for the platform role and never published, so a leaf cannot be confirmed by guessing an entry's contents.
- The root reveals only that some set of entries existed. The entry count reveals the period's volume of journal entries, which AORA accepts for a testnet demonstration.
