# Phase 6 Plan — NAM Vault

- **Status:** in progress (started 2026-10-18). Run mode of 2026-10-18 (CLAUDE.md): no approval stop between phases.
- **Scope source:** [mvp-scope.md](../product/mvp-scope.md) §3 (checkpoints 6A, 6B), journeys J11 and J13 (KONY side; CHIWO's side is 7C); brief §6.1–§6.5, §7.1; [ADR 0015](../adr/0015-contract-scope-and-safety.md) and [contracts/spec/NamUsdcVault.md](../../contracts/spec/NamUsdcVault.md); [ADR 0009](../adr/0009-wallet-and-signing.md) interim ruling.
- **Branch:** `phase-6`. Merge rules as before; migrations expand-only and on staging first.
- **Test discipline:** tests strictly first for the order and redemption state machines, the ledger postings, idempotency, tenant isolation, and the rule that a holding follows contract state only.
- **Testnet only, no yield.** Nothing in the API or on any screen states or implies a return, rate or yield (brief §6.1). Every NAM record and screen is labelled sandbox.
- **Staging needs the deployed vault.** Until the owner funds the sandbox wallet and `NamUsdcVault` is deployed, NAM is off on staging (`chain_unavailable` / `nam_unavailable`) and everything is built and tested against the local chain.

## Checkpoints

| | Contents | Needs from the owner |
|---|---|---|
| **6A** | NAM module: product and disclosure as data; business investor profile per workspace; orders (fund from the USDC treasury → vault deposit) and redemptions (vault redeem → USDC treasury) as explicit state machines driven by chain operations; holdings from confirmed `Deposit`/`Withdraw` events only; ledger postings; NAM reconciliation against the vault; API | Nothing (local chain) |
| **6B** | `kony-web` NAM page: disclosure and consent, funding, order and holding shown separately, redemption; cashier sees nothing | Nothing |

## 1. Decisions taken in this plan

| # | Decision | Why | Recorded in |
|---|---|---|---|
| P6-1 | **One product**, "NAM USDC Vault (sandbox)", type `smart_contract_vault`, on `NamUsdcVault` (Base Sepolia). Product facts are data (`nam.product`): who controls the assets (AORA's sandbox testnet wallet holds the shares), what the customer owns (a ledger claim on those shares), fees (none, as data), returns (none claimed), withdrawals (redeem at any time; deposits can be paused, redemptions cannot) | Brief §6.1 requires each product to state these | ADR 0015 addendum |
| P6-2 | **Investor profiles are explicit**: `nam.investor_profile(kind business, tenant_id)` now; `kind personal` for CHIWO in 7C. A business profile belongs to a workspace, never to a person | Brief §7.1; J13 keeps the contexts apart | this plan |
| P6-3 | **KONY funds NAM from its USDC treasury** (`merchant_usdc_available`). No fiat conversion in this phase | The treasury exists (5C); conversion is a labelled simulator later (owner decision) | — |
| P6-4 | **Funding, order and holding are separate states** (J11). *Funding*: the amount is reserved in the ledger. *Order*: the vault deposit as a chain operation. *Holding*: shares, written only from the confirmed receipt's `Deposit` event emitted by the vault for AORA's wallet. A request, a signature or a hash never creates a holding | Brief §6.3: no balance because a deposit was requested | this plan |
| P6-5 | **Ledger:** platform `nam_vault_usdc` (USDC in the vault, at accounted value); workspace `merchant_nam_funding_pending` and `merchant_nam_holding` (principal in the vault, at cost). Order confirmed: wallet → vault (platform) and pending → holding (workspace). Redemption confirmed for `s` of the profile's `S` shares returning `a`: vault → wallet by `a`; holding released by cost × s ÷ S (floor; the whole remainder when `s = S`), `a` to `merchant_usdc_available`, and the difference to platform `nam_vault_rounding` | Exact integers; shares are not money and live in `nam.holding`, not the ledger (rule 5) | ADR 0021 addendum |
| P6-6 | **One-time USDC approval of the vault** by AORA's wallet (maximum allowance, chain operation `usdc_approve`), made when an order first needs it and confirmed before any deposit is signed. Safe because only AORA's wallet ever calls `deposit`, and the vault can only pull from `msg.sender` | Keeps each order to one deposit transaction | ADR 0015 addendum |
| P6-7 | **Permissions:** `nam.read` (admin, finance), `nam.invest` (admin, finance; step-up for orders and redemptions). Cashiers see and do nothing | J13; rule 12 | — |
| P6-8 | **Disclosure as a versioned terms document** (`nam_vault_disclosure`); an order records business-capacity consent to the current version and is refused for any other version | Brief §6.1; consent module exists | — |
| P6-9 | **Vault address** in `BASE_SEPOLIA.contracts.namUsdcVault` (null until deployed; tests override like the registry). Before first use the API checks the vault's `asset()` is the configured USDC and its `guardian()` is AORA's wallet | ADR 0005 spirit: only verified addresses | ADR 0004 addendum |
| P6-10 | **NAM reconciliation** (in the chain job): the vault's `balanceOf(AORA wallet)` equals the sum of all holdings' shares; the vault's `accountedAssets` equals the ledger's `nam_vault_usdc`; each holding change matches a confirmed event. Differences open `nam_mismatch` | Brief §6.3 "reconciliation differences" | — |
| P6-11 | **No yield anywhere:** a test scans NAM API responses and the NAM page's source for "yield", "APY", "APR", "interest" and "return" used as a figure; the current value shown is `convertToAssets(shares)` from the contract, labelled as such, never a rate | J11 exit test | — |

## 2. Data model (`…20261019000100_nam`, expand-only)

- `nam.product(id, code, name, kind, vault_address null, asset_code, fee_bps, terms_key, mode)`; one row.
- `consent.terms_document` row: `nam_vault_disclosure` v1 (sandbox text, no yield claims).
- `nam.investor_profile(id, kind, tenant_id null, person_id null, created_at)`; `check ((kind = 'business') = (tenant_id is not null))`; unique per tenant.
- `nam.order(id, profile_id, tenant_id, idempotency_key, request_hash, amount, status, consent_id, operation_id null, shares null, failure_reason, created_by)`; status `funding_reserved → depositing → holding_confirmed | failed | reconciliation_required`.
- `nam.redemption(id, profile_id, tenant_id, idempotency_key, request_hash, shares, status, operation_id null, assets null, created_by)`; status `requested → redeeming → completed | failed | reconciliation_required`.
- `nam.holding(profile_id primary key, tenant_id, shares numeric(78,0), cost_basis bigint)`; changed only by a confirmed order or redemption, with `nam.holding_change` append-only (event, tx hash, log index, shares delta).
- Ledger account types: `nam_vault_usdc`, `nam_vault_rounding` (platform), `merchant_nam_funding_pending`, `merchant_nam_holding` (workspace).
- `chain.operation.kind` gains `usdc_approve`. Exception type `nam_mismatch`.
- Row-level security on every tenant table; the platform role writes.

## 3. State machines

- **Order:** `funding_reserved` (ledger reservation and consent in one transaction) → `depositing` (approval confirmed if needed; deposit operation prepared and submitted) → `holding_confirmed` (operation confirmed **and** the receipt has the vault's `Deposit` event for AORA's wallet with exactly the order's assets; shares from the event) | `failed` (operation reverted or failed: reservation released) | `reconciliation_required` (operation unresolved, or the receipt disagrees: reservation kept, exception opened).
- **Redemption:** `requested` (shares checked against the holding, step-up) → `redeeming` (redeem operation submitted) → `completed` (confirmed, and the vault's `Withdraw` event carries the shares and the assets; holding and ledger updated) | `failed` | `reconciliation_required`. Shares stay counted in the holding until `completed`; a second redemption cannot spend shares already being redeemed.

## 4. Endpoints (workspace routes, `Aora-Workspace-Id`)

`GET /v1/nam` (product facts, current disclosure, the profile's holding with shares and the contract's current value of them, funding pending, sandbox label), `POST /v1/nam/orders` (Idempotency-Key, step-up, `{amount_minor, disclosure_version}`), `GET /v1/nam/orders`, `POST /v1/nam/redemptions` (Idempotency-Key, step-up, `{shares}` or `{all: true}`), `GET /v1/nam/redemptions`. Driven by `/v1/internal/cron/chain`. All in `docs/api/openapi.yaml`.

## 5. Tests (first where the discipline requires it)

Order: refused without consent to the current disclosure, above the available USDC, or by a cashier; reserves on request; holding appears only after the confirmed deposit event, never on request or hash; the approval happens once; a reverted deposit releases the reservation; an unresolved one goes to `reconciliation_required` and keeps it. Redemption: refused above the holding (including shares already being redeemed); completes only after confirmation; ledger and holding exact, including a full redemption. Tenant isolation of every NAM table and route. NAM reconciliation clean, and each injected difference flagged. The no-yield scan. Vault invariants still hold (Foundry, unchanged).

## 6. Files

`services/api/src/modules/nam/` (`nam.service.ts`, `nam.controller.ts`, `nam-reconciliation.ts`), migration, `services/api/test/nam-*.test.ts`, `apps/kony-web/app/w/[workspaceId]/nam/`, docs (ADR 0015 and 0021 addenda, `docs/providers/base-sepolia.md` once the vault is deployed).
