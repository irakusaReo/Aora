# AORA — Claude Code Operating Guide

This file loads at the start of every session, so it stays short. The full specification lives in the documents listed below. Read the sections relevant to a domain before working on it.

## What AORA is

AORA is a fintech platform launching in Kenya first, with expansion only after validation. It is one modular monolith with separate financial domains:

- **CHIWO**: consumer payments and money movement
- **KONY**: merchant operating system (acceptance, reconciliation, cash flow, treasury)
- **KELO**: a consumer buy-now-pay-later marketplace with a merchant side (owner amendment, 2026-10-13). Merchants who enlist get a KONY workspace automatically. Merchant cash advances are deferred until after the MVP.
- **NAM Vault**: investment and vault domain, embedded in CHIWO and KONY. Never a standalone app.

On-chain: Base only. Stablecoin: native USDC on Base only.

## Sources of truth (read before acting)

| Document | Use it for |
|---|---|
| `docs/architecture/master-development-brief.md` | Authoritative product, architecture and engineering spec |
| `docs/product/kony-competitive-lessons.md` | Requirements derived from competitor research (KONY, KELO, developer platform) |
| `docs/research/kopo-kopo-teardown.md` | Background market research. Context, not requirements. |
| `docs/architecture/open-questions.md` | Unresolved decisions. Check here before assuming anything. |
| `docs/architecture/country-provider-model.md` | Markets and rails, and which rails are real or simulated |
| `docs/adr/` | Accepted and proposed architecture decisions |
| `docs/architecture/delivery-plan.md` | Phases, entry and exit criteria |
| `docs/product/mvp-scope.md` | What the sandbox MVP must do, in build order |
| `docs/product/kelo-experience.md` | KELO UX rules. Read before building any KELO screen |
| `docs/operations/` | Setup guides and runbooks (Neon, Vercel) |
| `docs/progress.md` | Done, next, blocked. Read this first when resuming |

If these documents conflict, the master brief wins. Record the conflict in `open-questions.md` instead of silently choosing.

## Current state

- Repository: greenfield, started 2026-10-13.
- Goal: a fully functional **sandbox MVP** (`docs/product/mvp-scope.md`) on Vercel and Neon, against provider sandboxes and Base Sepolia.
- Current phase: **Phase 10 — MVP gate** is next and is a **stop point for the owner** (run mode). **Phase 9 (Mobile) is built and merged** (PRs #35–#37, plan `docs/plans/phase-9.md`): Expo SDK 58 apps `apps/kony-mobile` (with the KELO merchant screens), `apps/chiwo-mobile` and `apps/kelo-mobile`, the shared `packages/mobile` (sandbox banner, idempotency keys in secure storage that survive a restart, "we are checking" for unknown outcomes, PIN step-up), running in Expo Go against staging with no Expo or EAS account (`docs/operations/mobile.md`); signing in on a phone needs the owner to switch on Clerk's Native API for the development instance. Set-up tasks stay on the web apps (P9-10); emulator end-to-end tests are deferred to the gate preparation (P9-12). **Phase 8 (KELO credit) is built, merged and on staging** (PRs #30–#33, plan `docs/plans/phase-8.md`): credit behind the `kelo_credit` flag (data in `ops.feature_flag`, **off on staging**; an operator switches it in internal-ops `/flags` with a PIN and a reason), decisions, agreements, repayments with interest only to the day, the daily `kelo-credit` collections job (the seventh cron job), returns and disputes with clawback, and the merchant's KELO dashboard. Kenya's credit conduct rules (the CBK Non-Deposit Taking Credit Providers Regulations, 2026) are read in `docs/compliance/kenya-credit-conduct.md`. Phase 7 (CHIWO web, PRs #25–#27) is on staging; `chiwo-web` is deployed at https://chiwo-web.vercel.app and `kelo-web` at https://kelo-web.vercel.app. Phases 5 (chain and contracts, PRs #20–#22) and 6 (NAM Vault, PR #23) are built, merged and on staging, but the chain is **switched off on staging** until the owner funds the sandbox wallet `0xEfBB9b5761BB2633cCB94a294628Dd63124Cedb5`. After funding: put `SANDBOX_SIGNER_PRIVATE_KEY` (sensitive), `BASE_SEPOLIA_RPC_URL` and `BASE_SEPOLIA_SCAN_START_BLOCK=48284000` on `aora-api`. Then deploy the contracts with `node contracts/scripts/deploy.mjs` (Sourcify verification, no Etherscan key), copy both addresses into `BASE_SEPOLIA.contracts` with the record in `contracts/deployments/`, and attribute the faucet deposits in internal-ops `/chain`. Run mode: build the remaining MVP phases in the order of `docs/product/mvp-scope.md` §3, stopping only for a needed credential, an owner decision with no safe default, unfixable CI or staging, a CLAUDE.md rule, a billable resource, a Vercel Production setting or a delete, or the MVP gate.
- Rails: M-Pesa through Daraja is the only real rail in the MVP; Airtel, MTN, Vodacom and the bank wait for the post-gate Rails expansion phase. Do not request their credentials until the owner says so.
- Last approved milestone: Phase 3 (2026-10-18); Phases 4–9 were built under the run mode. The owner's signed-in staging walk-through is pending and blocks nothing.
- Live status, next steps and blockers: `docs/progress.md`

Update this block at the end of each approved phase.

## MVP scope in one screen

Full detail and build order: `docs/product/mvp-scope.md`.

- **Platform:** email-code sign-in through Clerk (the phone number stays required as the financial identity), AORA transaction-PIN step-up, email notifications through Resend, tenants and roles, audit, ledger (KES, USDC and per-rail currencies), outbox, reconciliation, versioned tariffs.
- **KONY:** merchant onboarding, branches and staff, collections, payouts, refunds, settlement, USDC treasury, developer API. Web and mobile.
- **KELO:** consumer BNPL marketplace (web and mobile) plus a KELO section in the merchant's KONY workspace. Plan types: Pay in N, monthly financing, layaway; asset financing in the data model only. All credit behind a feature flag.
- **CHIWO:** consumer sign-up, pay a merchant, send and receive USDC, requests, receipts. Web and mobile.
- **NAM Vault:** one product inside CHIWO and KONY, backed by an AORA vault contract on Base Sepolia.
- **Rails:** M-Pesa (Daraja, Kenya) is the only real rail. Airtel Money, MTN MoMo, Vodacom M-Pesa and the bank stay on the simulator until the post-gate Rails expansion phase (`docs/architecture/country-provider-model.md`).
- **Contracts:** at most three AORA contracts, Base Sepolia only, Foundry, non-upgradeable.
- **Apps:** `kony-web`, `chiwo-web`, `kelo-web`, `internal-ops` (Next.js); `kony-mobile`, `chiwo-mobile`, `kelo-mobile` (Expo). Business logic stays in the API.
- **Out of scope:** card acceptance, a real fiat-to-USDC conversion provider, production custody, live money, mainnet, merchant cash advances, device-lock integration, in-store QR for KELO.

## Non-negotiable rules

1. **Base only.** Never add another chain, a chain-selection abstraction, or Bitcoin Lightning in any form.
2. **Native USDC only.** The token address lives only in verified, environment-specific chain config. Reject every other token contract, including bridged USDC (USDbC) and USDT.
3. **No floating point for money.** Use integer minor units or exact decimals for fiat. Use exact integer token units for USDC, with decimals taken from verified config. Never assume two decimal places.
4. **The double-entry internal ledger is mandatory.** Posted entries are immutable, and corrections are compensating entries. On-chain records never replace accounting.
5. **Never conflate balances.** Collections, settled funds, available cash, USDC balances, investment holdings and credit limits are distinct types and must be modelled separately.
6. **Every financial write is idempotent.** A timeout means the state is unknown, not that the operation failed: query or reconcile before any retry. Never automatically resubmit an on-chain transaction whose status is unknown.
7. **Use explicit state machines** for payments, transfers, deposits, withdrawals, orders and provisioning. Include `status_unknown` and `reconciliation_required` states. A transaction hash or a signature does not mean the operation is complete.
8. **No personal data on-chain.** That includes phone numbers, KYC/KYB data, and hashes that could be linked back to them.
9. **Secrets never go in code, config files, database fields or logs.** This covers private keys, seed phrases and API keys. `.env.example` contains placeholders only.
10. **Sandbox only.** Do not connect live providers, move real funds, or deploy contracts to Base mainnet. Provider sandboxes and Base Sepolia testnet transactions are permitted and must be labelled sandbox. Base mainnet remains forbidden, for contracts and for transfers. Every sandbox record and screen is visibly labelled as sandbox.
11. **Never invent provider capabilities.** If the repo does not document how an M-Pesa, bank, wallet or investment provider behaves, stub it behind the adapter interface and log it in `open-questions.md`.
12. **Authorization is enforced server-side.** Every query applies role checks and tenant isolation. Sensitive financial actions require step-up authentication. Access to a KONY workspace never by itself grants payment, financing, investment or payout authority.

## How we work

- **Plan once per phase.** Write `docs/plans/phase-N.md` covering the data model, state machines, endpoints, tests and files. If I have already approved the phase's scope in a prompt, proceed after writing the plan. Otherwise, wait for my approval.
- **Inside an approved plan, keep working without asking.** Stop only when:
  (a) you need a credential or external account from me,
  (b) you reach a decision marked "owner" in `open-questions.md`,
  (c) you need to deviate materially from the plan, or
  (d) the phase ends.
- **Commit at each checkpoint once tests pass,** using conventional commit messages. Never commit `.env.local`.
- **Keep `docs/progress.md` current:** what's done, what's next and what's blocked. A fresh session must be able to resume from `CLAUDE.md` and `progress.md` alone.
- **Credentials:** follow the credential protocol below, exactly.

## Engineering practices

Carried over from the Phase 0 working agreement.

- **Build the smallest working slice.** Do not create empty directories or speculative abstractions from the target tree in §11.2. Add them when a phase needs them.
- **Write tests strictly first** for ledger invariants, state machines, idempotency, tenant isolation and every smart contract: the failing test is committed to the working tree before the code that satisfies it. For other code, tests written alongside are fine.
- **Pricing, tariffs and credit terms are data.** Provider fees, free bands, caps, FX rates, plan types, tenors, deposits, limits, late charges and category rules are versioned configuration with effective dates, never hardcoded constants.
- **KELO never shows a spending limit as a balance or as cash,** and stores purchase data only, never health information.
- **No provider behaviour from memory.** Read the provider's current documentation in the phase that integrates it, and record source and date.
- **Docs move with code.** Update the relevant architecture doc or ADR in the same change as the code.

## Hosting and deployed environments (ADR 0013)

- **Hosting is Vercel plus Neon.** Do not add another host, queue, cache or database without asking.
- **Every Vercel environment runs in sandbox mode.** Vercel's "Production" target is **AORA staging**. It is not live and must never be described as live.
- **Region:** Vercel functions in `fra1`, Neon in `aws-eu-central-1` (Frankfurt), the closest pair available to Kenya. Keep them together.
- **Database:** pooled connection string at runtime, direct connection string for migrations only. Tenant context is set per transaction (`set_config(..., true)`), never per session. Application roles are created with SQL so they never inherit `BYPASSRLS`.
- **Background work is cron-triggered, idempotent and time-bounded.** No long-running process. A missed or duplicated cron run must be harmless. Work is driven by a background drain after requests plus a GitHub Actions schedule calling the secret-protected cron routes (ADR 0013); Vercel's own cron is daily on the Hobby plan.
- **The API entry file must not use top-level `await`** to start the server: on Vercel that hangs every request.
- **Provider callbacks** go to the staging (Vercel Production) domain and are always signature-checked. Deployment protection is never a substitute for a signature check.
- **Secrets** live in Vercel environment variables marked sensitive. `.env.local` is for the owner's machine only. A testnet signer key may be in `.env.local` only for the local sandbox signer.
- **Authentication is Clerk (ADR 0019); AORA's database remains the authority for persons, tenants, roles, permissions, consent and RLS context.** Never use Clerk Organizations or roles for authorization, and never write anything to Clerk metadata. Clerk holds email and name only; the phone number (the financial identity) is collected and held by AORA. Only development-instance keys; a live key is refused.
- **No fixed sign-in code on a deployed environment.** The sandbox authenticator (tests only) is refused unless the process is on a developer machine with local databases. Clerk's test mode (`+clerk_test` addresses, fixed code) must be off on the staging instance, and the API refuses `+clerk_test` users when deployed. Both have tests. Neither is a config flag.
- **Email goes through the notifications module (ADR 0020), never straight to Resend.** Emails mask account and phone details, carry nothing that authorises an action, and are marked sandbox.
- **Migrations never run from the Vercel build.** They run from GitHub Actions or by hand, through the direct connection, and are backward-compatible: expand first, contract in a later release.
- **Preview deployments have no database** and must never be pointed at staging's.
- **Ask before** any command that creates a billable resource, changes Vercel Production settings, or deletes anything.
- Local PostgreSQL remains the database for unit and integration tests and for CI.

## Credential protocol

When a credential, account or external value is needed, ask in exactly this format:

```text
CREDENTIAL REQUEST
- What: <name>
- Why: <the feature and phase that need it>
- Where to get it: <official portal or documentation, with steps; mark anything uncertain "to verify">
- Environment: sandbox or test only, never live or production
- Variable names: <EXACT_ENV_VAR_NAMES>, also added to .env.example as placeholders
- How to provide it: I add the values to .env.local myself (or to Vercel for deployed environments) and reply "done". Never ask me to paste secrets into the chat.
```

- At the start of each phase, batch every credential that phase needs into one request.
- After "done", verify each value is present and well-formed without printing, logging or committing it. Run a sandbox connectivity check and report only pass or fail.
- Refuse any value that looks like a live or production key, and say so.
- If a secret is pasted into the chat by mistake, write it nowhere and ask for it to be rotated.
- While waiting, continue the work that does not need the credential, using the simulator.

## Definition of done (summary of brief §16)

A feature is done only when all of these hold:

- Domain ownership is documented.
- Its data model and API contract are defined.
- Authorization is enforced.
- Failure and unknown states are handled.
- Financial writes are idempotent.
- Financial records are auditable.
- Reconciliation is defined.
- Tests pass.
- No secrets are committed.
- Logs and alerts are actionable.
- Documentation is updated.
- Sandbox functionality is clearly distinguished from live.

## Commands

Requires Node 24 (`nvm use`), pnpm through corepack (`corepack enable`), and PostgreSQL 16 server binaries for the local database.

| Task | Command |
|---|---|
| Install | `pnpm install` (CI: `pnpm install --frozen-lockfile`) |
| Start local database and pooler | `pnpm db:start` (stop: `pnpm db:stop`; wipe: `pnpm db:reset`). Also starts PgBouncer in transaction mode on port 54330 for the pooled-connection tests |
| Migrate | `pnpm db:migrate` |
| Regenerate `schema.prisma` and client after a migration | `pnpm -r db:pull && pnpm db:generate` |
| Lint | `pnpm lint` |
| Typecheck | `pnpm typecheck` |
| Test | `pnpm test` (needs `pnpm db:start`; one package: `pnpm vitest run --project api`) |
| Format | `pnpm format` (check: `pnpm format:check`) |
| Build | `pnpm build` |
| Seed sandbox data | `pnpm db:seed` (after build and migrate) |
| Run API / worker | `pnpm start:api` / `pnpm start:worker` (after build; reads `.env.local`) |
| Neon: create roles | `pnpm neon:bootstrap staging\|development` (needs `NEON_ADMIN_URL_*` in `.env.local`) |
| Neon: migrate | `pnpm db:migrate:staging`, `pnpm db:migrate:development` (direct connection) |
| Neon: verify through the pooler | `pnpm neon:verify staging\|development` (pass or fail only) |
| Deploy to staging | `vercel deploy --prod --yes --scope andres-projects-85e1a425` from the repository root (Vercel "Production" is AORA staging). Ask first |
| Contract tests | `cd contracts && forge test` (Foundry v1.8.4; `git submodule update --init --recursive` first). The API's chain tests need `anvil` on the PATH or in `~/.foundry/bin` |

Run `format:check`, `lint`, `typecheck` and `test` before reporting any work as done. CI runs the same four, plus a check that `schema.prisma` matches the migrations.

Schema changes: write a new SQL file under `services/api/prisma/migrations/`, never edit an applied one. SQL is the source of truth; `schema.prisma` is generated from the database.

## End-of-phase report format

1. What was built, with file paths
2. Tests added, and their results
3. Decisions made, with ADR links
4. Open questions added
5. Risks or shortcuts taken
6. Proposed next step
