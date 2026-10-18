# Phase 5 Plan — Chain and contracts

- **Status:** in progress (started 2026-10-18). Run mode of 2026-10-18 (CLAUDE.md): no approval stop between phases.
- **Scope source:** [mvp-scope.md](../product/mvp-scope.md) §3 (checkpoints 5A to 5C), journeys J9 and J10; brief §3.1–§3.8, §13.2; [ADR 0004](../adr/0004-base-integration.md), [ADR 0005](../adr/0005-native-usdc-policy.md), [ADR 0006](../adr/0006-smart-contract-toolchain.md), [ADR 0009](../adr/0009-wallet-and-signing.md) interim ruling, [ADR 0015](../adr/0015-contract-scope-and-safety.md); [delivery-plan.md](../architecture/delivery-plan.md) Phase 5 proof list.
- **Branch:** `phase-5`. Merge to `main` only when CI passes, every Vercel variable the code needs exists, and new migrations are already on staging. All migrations are expand-only.
- **Test discipline:** tests strictly first for the chain-operation state machine, transfer verification, startup verification, signer guards, idempotency of observation and crediting, the ledger postings, tenant isolation of treasury data, withdrawal approval, and every contract (unit, fuzz, invariant).
- **Base Sepolia only (84532).** No mainnet entry exists anywhere in the repository. Every chain record and screen is labelled sandbox.

## Checkpoints

| | Contents | Needs from the owner |
|---|---|---|
| **5A** | `chain` module: static chain config with provenance; startup verification (chain ID, code at the USDC address, decimals, ledger exponent); viem clients; `Signer` interface and the sandbox development signer with its guards; chain-operation state machine; inbound transfer observation and content verification; confirmation policy as data; local-chain test harness (anvil) | Nothing. Real Base Sepolia reads need nothing; real transactions need the funded wallet (requested 2026-10-18) |
| **5B** | `contracts/` with Foundry: specs, tests first, `NamUsdcVault`, `AnchorRegistry`; static analysis; deployment scripts that refuse any chain but 84532; deploy to Base Sepolia; source verification; generated ABIs for the API | The funded wallet, for the deployment step only |
| **5C** | KONY USDC treasury: registered sender addresses (proved by signature), deposit crediting after the confirmation policy, withdrawals with a second approver and step-up, submitted through the signer; three-way reconciliation (ledger, chain, operation records); anchoring job; `kony-web` Treasury page; ops views | The funded wallet, for staging runs |

## 1. Decisions taken in this plan

| # | Decision | Why | Recorded in |
|---|---|---|---|
| P5-1 | **viem 2.57.2, pinned exact**, the newest 2.x release at least two weeks old on 2026-10-18 (2.57.7 was four days old). Only `services/api/src/modules/chain` imports it (lint rule) | ADR 0004; supply-chain caution | ADR 0004 addendum |
| P5-2 | **The local chain impersonates Base Sepolia.** Tests run anvil with `--chain-id 84532` and place a 6-decimal test token's code at the configured USDC address (`anvil_setCode`). The production config entry is exercised unchanged, and the signer's chain guard is never relaxed for tests. Wrong-chain, missing-code and wrong-decimals cases use a second anvil or altered code | One config, no test-only bypass of a safety guard | this plan |
| P5-3 | **No mainnet fork in tests** (E-4 stays open). Nothing forks Base mainnet; a fork of Base Sepolia is not needed either | Keeps rule 10 untouched | — |
| P5-4 | **One AORA sandbox wallet holds all USDC; customers hold ledger claims** (ADR 0009 interim, M-3/M-4). Address `0xEfBB9b5761BB2633cCB94a294628Dd63124Cedb5`, labelled "AORA sandbox testnet wallet" wherever shown | Owner decision, 2026-10-18 | ADR 0009 addendum |
| P5-5 | **Attribution of inbound USDC by registered sender address.** A merchant registers an external address by signing an AORA challenge with it (EIP-191 personal message, verified server-side). A confirmed inbound transfer from a registered address credits that workspace; a transfer from an unregistered address is never credited and opens `unattributed_deposit`. The challenge text names the workspace by an opaque reference only, and nothing is ever written on-chain | One shared wallet cannot tell senders apart otherwise; no personal data on-chain (rule 8) | this plan, ADR 0004 addendum |
| P5-6 | **Confirmation policy is versioned data** (`chain.confirmation_policy`: minimum confirmations, and a larger number above a high-value threshold, with effective dates). Seed values are set in 5A after reading Base's documentation on block times and finality, with source and date | CLAUDE.md: policy is data; brief §3.4 | providers/base-sepolia.md |
| P5-7 | **Network fees (Base Sepolia ETH) are recorded on each chain operation** (gas used, effective gas price) **but not posted to the ledger in the sandbox.** Testnet ETH has no value; ledgering gas (an ETH asset and a gas-expense account) is on the pre-pilot list | Keeps the sandbox ledger to assets with an accounting meaning | open-questions pre-pilot list |
| P5-8 | **Contract verification uses Sourcify (free, no account) instead of Etherscan** (resolved in 5B: Foundry 1.8.4 supports it and Sourcify lists 84532 as supported). Etherscan's supported-chains page lists Base Sepolia as "Paid Tier Only" (read 2026-10-18), and a paid plan is a billable resource. No `ETHERSCAN_API_KEY` is requested. Which free verifier Foundry supports for Base Sepolia is confirmed from Foundry's and the verifier's documentation in 5B | Approval 3 asked for the key only for verification | ADR 0015 addendum |
| P5-9 | **Withdrawals need two people**: a finance or admin member creates one, a *different* admin approves with a PIN step-up. Destinations are checked (checksummed EOA, not the zero address, not the USDC contract, not AORA's wallet, no code at the address) and capped by versioned per-tier limits | Journey J9; rule 12 | ADR 0021 addendum |
| P5-10 | **The anchoring leaf** is `keccak256(salt ‖ entry_id ‖ posting digest)`, where the posting digest covers account type, direction, amount and asset only (no tenant identifier). The per-period salt is 32 random bytes held in the database for the platform role only and never published. Periods are UTC days | ADR 0015; rule 8 | contracts/spec/AnchorRegistry.md |
| P5-11 | **Background chain work is cron-triggered and time-bounded** (`chain-observe`, `chain-confirm`, `chain-anchor`), scanning bounded block ranges from a stored cursor. A missed or repeated run is harmless: observation is unique on `(tx_hash, log_index)`, crediting is one journal entry per observed transfer | ADR 0013 | — |
| P5-13 | **Vault invariant 3 is tested in two exact parts** (aggregate redemptions ≤ deposits with exact accounting; per account, at most the rounding dust others left). The fuzzer showed rounding dust accrues to remaining holders, as in any share vault | A strict per-account cap breaks share transfers | ADR 0015 addendum |
| P5-14 | **The API's `tsconfig.json` states `module`, `moduleResolution` and `strict` itself**: Vercel's Node builder reads that file without following `extends`, fell back to `strict: false`, and viem's types failed its type-check | Found by reproducing Vercel's build locally (`vercel build`) | this plan |
| P5-12 | **The public Base Sepolia RPC for development and staging** (`https://sepolia.base.org`). Base says its RPCs "are rate-limited, they are not suitable for production apps" (docs.base.org, read 2026-10-18). Calls are few and bounded; a second, independent provider (D-11) is on the pre-pilot list | Owner approval 3 | providers/base-sepolia.md |

## 2. Data model

New schema `chain`. Every table carries `mode` (`sandbox` only) and `network` (`base-sepolia` only, by check constraint).

**5A `…20261018000500_chain`**
- `ledger.asset` row `USDC`, kind `token`, exponent 6. Startup refuses if this differs from the chain config or from the contract's `decimals()`.
- `chain.confirmation_policy(id, version, effective_from, effective_to, min_confirmations, high_value_threshold, high_value_confirmations)`.
- `chain.scan_cursor(name primary key, last_block bigint)`.
- `chain.observed_transfer(id, tx_hash, log_index, block_number, block_hash, token_address, from_address, to_address, amount numeric(78,0), status, confirmations, observed_at, confirmed_at, tenant_id null, journal_entry_id null)`; unique `(tx_hash, log_index)`. Status: `observed → confirmed → credited | unattributed`, `observed → dropped` (block reorganised away). Amount stored exactly (`numeric(78,0)`), converted to `bigint` for the ledger only after a range check.
- `chain.operation(id, tenant_id null, kind, idempotency_key unique, status, from_address, to_address, token_address, amount numeric(78,0), nonce, tx_hash, submitted_at, block_number, block_hash, confirmations, gas_used, effective_gas_price, failure_reason, related_entry_ids uuid[])` plus `chain.operation_transition` (append-only). Kinds: `usdc_transfer`, `contract_deploy`, `anchor_commit`, `vault_deposit`, `vault_redeem` (the last two used from Phase 6). Holds every field of brief §3.5.

**5C `…chain_treasury`**
- `chain.registered_address(id, tenant_id, address, label, challenge_id, status, registered_by, revoked_at)`; one active row per address across all tenants (an address cannot credit two workspaces).
- `chain.address_challenge(id, tenant_id, nonce, message, expires_at, used_at)`.
- `chain.withdrawal(id, tenant_id, amount, destination, status, created_by, approved_by, operation_id, idempotency_key)`; `check (approved_by <> created_by)`.
- `chain.withdrawal_limit(tier, version, effective_from, per_withdrawal_max, daily_max)`.
- `chain.anchor_period(period_id, salt bytea, root bytea, entry_count, status, operation_id)`; `chain.anchor_leaf(period_id, entry_id, leaf)`.
- Ledger accounts: platform `chain_wallet_usdc` (debit-normal: USDC held in AORA's wallet); per-tenant `merchant_usdc_available` and `merchant_usdc_withdrawals_in_flight` (credit-normal). USDC never shares an account, a balance or a screen figure with KES (rule 5).
- Reconciliation exception types added: `unattributed_deposit`, `unexpected_asset`, `chain_balance_mismatch`, `chain_operation_mismatch`, `anchor_mismatch`.

## 3. State machines

- **Chain operation** (brief §3.4, ADR 0004): `prepared → authorization_pending → submitted → pending_confirmation → confirmed`; `submitted | pending_confirmation → reverted | failed`; `prepared | authorization_pending → failed`; `submitted → status_unknown` when the send call times out or errors after signing; `status_unknown → pending_confirmation | confirmed | reverted | reconciliation_required` only through a query by hash or by sender nonce; anything `→ reconciliation_required`, which has no automatic exit. `submitted` is committed before the RPC call, with the signed transaction's hash and nonce, so a crash can always be recovered by query. **Nothing in `status_unknown` is ever re-sent.** A returned hash moves an operation to `submitted`, never further.
- **Observed transfer:** `observed → confirmed` once the confirmation policy is met and the block hash still matches; `confirmed → credited` (one journal entry) or `→ unattributed` (exception); `observed → dropped` if the block hash changed and the log is gone.
- **Withdrawal:** `requested → approved → submitting → (operation states) → completed | failed`, `requested → rejected | expired`; funds move to "withdrawals in flight" on approval and back on failure by a compensating entry.
- **Anchor period:** `open → closed (root computed) → committed (operation confirmed)`; `committed` is final.

## 4. Endpoints (all `/v1`)

- 5A: none public. `GET /v1/health` gains a `chain` check (chain ID and token verified at startup; head block reachable).
- 5C (workspace, role-checked, tenant-scoped): `POST /workspaces/{id}/treasury/address-challenges`, `POST /workspaces/{id}/treasury/addresses`, `GET /workspaces/{id}/treasury/addresses`, `DELETE /workspaces/{id}/treasury/addresses/{addressId}` (revoke, not delete), `GET /workspaces/{id}/treasury` (USDC available and in flight, deposit instructions with the sandbox wallet address and the labelled network), `GET /workspaces/{id}/treasury/transfers`, `POST /workspaces/{id}/treasury/withdrawals` (Idempotency-Key), `POST /workspaces/{id}/treasury/withdrawals/{wid}/approve` (step-up), `POST …/reject`. Operator: `GET /ops/chain/operations`, `GET /ops/chain/anchors`. Cron: `GET /internal/cron/chain-observe`, `chain-confirm`, `chain-anchor`. All in `docs/api/openapi.yaml`.

## 5. Tests (written first where the discipline requires it)

- **Startup (5A):** refuses on wrong chain ID; no code at the USDC address; wrong `decimals()`; ledger exponent differs; development signer with `AORA_MODE` other than sandbox; development signer on any chain but 84532; a signer key that is malformed. No sandbox config contains chain ID 8453 (a hygiene test scans the repository).
- **Verification (5A):** a transfer counts only if the receipt succeeded and the decoded `Transfer` event comes from the configured contract with the expected recipient and amount; another token to the wallet is never credited (`unexpected_asset`); a hash alone is never accepted; reverted, dropped (reorganised), replaced and delayed transactions reach the right state; duplicate observation is idempotent.
- **State machine (5A):** every allowed and forbidden transition; `status_unknown` is never re-sent; recovery by hash and by nonce.
- **Contracts (5B), Foundry:** unit, fuzz and the invariants of ADR 0015 (accounted assets ≤ balance; shares map to accounted assets; no deposit/donation/redeem sequence withdraws more than was put in; redemption always possible while deposits are paused; a period's commitment never changes; only the anchorer adds).
- **Treasury (5C):** signature-proved registration (wrong signer, expired or reused challenge refused); credit only after the policy; unregistered sender never credited; withdrawal needs a second admin with step-up; same person cannot approve; limits enforced; tenant isolation of every treasury table; trial balance zero after each flow.
- **Reconciliation (5C):** clean on seeded data; flags each injected difference (ledger vs chain balance, missing operation, extra transfer, wrong amount); an on-chain transfer never settles an unrelated obligation; the anchored root recomputes from the ledger; no personal data in any transaction's calldata (test decodes every AORA-sent transaction).

## 6. Files

- `services/api/src/modules/chain/`: `config.ts` (the one place the USDC address lives, with provenance), `startup.ts`, `client.ts`, `signer.ts`, `operations.ts` (state machine), `observer.ts`, `verify.ts`, `treasury.service.ts`, `treasury.controller.ts`, `reconciliation.ts`, `anchoring.ts`, `abi/` (generated).
- `services/api/test/chain-*.test.ts`, `services/api/test/support/anvil.ts`.
- `contracts/`: `foundry.toml`, `src/NamUsdcVault.sol`, `src/AnchorRegistry.sol`, `test/`, `script/`, `spec/`, `deployments/base-sepolia.json`, `README.md`.
- `apps/kony-web/app/w/[workspaceId]/treasury/`; `apps/internal-ops/app/chain/`.
- Docs: `docs/providers/base-sepolia.md` (what Base's and Circle's docs say, with dates), `docs/architecture/base-and-usdc.md`, `docs/operations/base-transaction-runbook.md`, ADR addenda 0004, 0009, 0015, 0021.
- CI: Foundry installed through its official action, pinned; `forge test` and static analysis jobs; anvil available to the API tests.
