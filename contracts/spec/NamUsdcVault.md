# NamUsdcVault — specification

> **Testnet demonstration only.** This contract has had no independent review. It is deployed to Base Sepolia only and must never hold real funds (ADR 0015).

## Purpose

A single-asset vault for the NAM product (brief §6.2–§6.4, ADR 0015). It holds native USDC and issues shares that represent a claim on the USDC the vault has accounted for. It has no yield strategy, no lending and no external calls other than to the USDC contract. The AORA ledger stays the source of truth; vault shares are reconciled against it (ADR 0015 rule 9).

## State

| Name                  | Type                 | Meaning                                                                                                                                                             |
| --------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `asset`               | `IERC20`, immutable  | Native USDC. Fixed at construction; the deployment script refuses any address other than the one in the API's verified chain config, and any chain other than 84532 |
| `guardian`            | `address`, immutable | May pause and unpause deposits. Nothing else                                                                                                                        |
| `accountedAssets`     | `uint256`            | USDC the vault owes shareholders. Changed only by `deposit` and `redeem`; never read from the token balance                                                         |
| `depositsPaused`      | `bool`               | When true, `deposit` reverts. Redemptions are never affected                                                                                                        |
| ERC-20 share balances | OpenZeppelin `ERC20` | Shares: name "AORA NAM Vault Share (Sandbox)", symbol `namUSDC-SBX`, decimals = asset decimals + `DECIMALS_OFFSET`                                                  |
| `DECIMALS_OFFSET`     | constant `6`         | Virtual-share offset against the first-depositor attack                                                                                                             |

## Functions

- `deposit(uint256 assets, address receiver) returns (uint256 shares)`: reverts if paused, if `assets == 0`, if `receiver` is the zero address, or if the computed `shares == 0`. Pulls `assets` from the caller with `transferFrom` and reverts unless the vault's balance rose by exactly `assets`. Mints `shares` to `receiver`. `shares = assets × (totalSupply + 10^offset) ÷ (accountedAssets + 1)`, rounded down.
- `redeem(uint256 shares, address receiver, address owner) returns (uint256 assets)`: burns `shares` from `owner` (spending the caller's allowance when the caller is not the owner) and transfers `assets` to `receiver`. `assets = shares × (accountedAssets + 1) ÷ (totalSupply + 10^offset)`, rounded down. Reverts if `assets == 0`. Works whether or not deposits are paused.
- Views, ERC-4626-like: `totalAssets()` (= `accountedAssets`), `convertToShares`, `convertToAssets`, `previewDeposit`, `previewRedeem`, `maxDeposit` (0 while paused), `maxRedeem(owner)` (= share balance).
- `pauseDeposits()`, `unpauseDeposits()`: guardian only.

There is no `mint`, no `withdraw` by asset amount, no sweep, no owner, no upgrade path, no `delegatecall` and no self-destruct.

## Rounding

Every conversion rounds in the vault's favour: shares issued on deposit and assets paid on redemption both round down.

## Access control

| Function                           | Who                                               |
| ---------------------------------- | ------------------------------------------------- |
| `deposit`                          | anyone (shares go to `receiver`)                  |
| `redeem`                           | the owner of the shares, or someone they approved |
| `pauseDeposits`, `unpauseDeposits` | `guardian`                                        |

## Invariants (tested with Foundry invariant tests)

1. `accountedAssets ≤ asset.balanceOf(vault)`.
2. Converting all shares returns at most `accountedAssets`. Because of the virtual shares, redeeming every share can leave rounding dust (a base unit or two) in `accountedAssets` with no shares outstanding; nobody can take it, and it slightly raises the price for the next depositor. (Corrected 2026-10-18: an earlier draft claimed no shares implied no accounted assets.)
3. The vault never pays out value nobody deposited: across all accounts, redemptions never exceed deposits, and `accountedAssets` equals deposits minus redemptions exactly. Per account, no sequence of deposits, donations and redemptions lets an account redeem more than it deposited **plus the rounding dust other operations left behind** (under one base unit per operation). Found by the invariant fuzzer on 2026-10-18: rounding down on redemption leaves dust in `accountedAssets`, which accrues to the remaining shareholders, as in any share-based vault. A strict per-account cap would need per-account principal tracking and would break share transfers; ADR 0015's addendum records the corrected statement.
4. Redemption is always possible while deposits are paused.
5. Only `deposit` and `redeem` change `accountedAssets`.

## Events

ERC-4626's `Deposit(sender, owner, assets, shares)` and `Withdraw(sender, receiver, owner, assets, shares)`; `DepositsPaused(guardian)`, `DepositsUnpaused(guardian)`; ERC-20 `Transfer` for shares.

## Emergency controls and risks

- Pausing deposits stops new exposure during an incident. A compromised guardian can only deny new deposits. It cannot trap, move or take funds, and cannot mint shares.
- The guardian cannot be changed: rotation would need a redeployment. Accepted for a testnet demonstration.
- USDC sent directly to the vault, and any token other than USDC, stays in the contract untouched. There is no sweep function, by design.
- USDC itself can pause or blocklist addresses; if it does, deposits and redemptions involving those addresses revert. The vault cannot work around the token.

## Privacy analysis (CLAUDE.md rule 8)

The contract stores addresses and amounts only. In the MVP every share is held by AORA's sandbox wallet, with per-customer claims in AORA's ledger (ADR 0009 interim), so no customer address appears on chain. The vault takes no free-form data: no memo, no reference, no identifier that could carry personal data.
