# AORA — Claude Code Operating Guide

This file loads at the start of every session, so it stays short. The full specification lives in the documents listed below. Read the sections relevant to a domain before working on it.

## What AORA is

AORA is a fintech platform launching in Kenya first, with expansion only after validation. It is one modular monolith with separate financial domains:

- **CHIWO**: consumer payments and money movement
- **KONY**: merchant operating system (acceptance, reconciliation, cash flow, treasury)
- **KELO**: credit and financing. Qualifying KELO merchants get a KONY workspace automatically.
- **NAM Vault**: investment and vault domain, embedded in CHIWO and KONY. Never a standalone app.

On-chain: Base only. Stablecoin: native USDC on Base only.

## Sources of truth (read before acting)

| Document | Use it for |
|---|---|
| `docs/architecture/master-development-brief.md` | Authoritative product, architecture and engineering spec |
| `docs/product/kony-competitive-lessons.md` | Requirements derived from competitor research (KONY, KELO, developer platform) |
| `docs/research/kopo-kopo-teardown.md` | Background market research. Context, not requirements. |
| `docs/architecture/open-questions.md` | Unresolved decisions. Check here before assuming anything. |
| `docs/adr/` | Accepted and proposed architecture decisions |
| `docs/architecture/delivery-plan.md` | Phases, entry and exit criteria |
| `docs/product/mvp-scope.md` | What the sandbox MVP must do, in build order |
| `docs/progress.md` | Done, next, blocked. Read this first when resuming |

If these documents conflict, the master brief wins. Record the conflict in `open-questions.md` instead of silently choosing.

## Current state

- Repository: greenfield, started 2026-10-13.
- Goal: a fully functional **sandbox MVP** (`docs/product/mvp-scope.md`) running in staging against provider sandboxes and Base Sepolia.
- Current phase: **Phase 1 built, awaiting owner approval** (`docs/plans/phase-1.md`). Do not start Phase 2 until it is approved.
- Last approved milestone: Phase 0 (2026-10-13)
- Live status, next steps and blockers: `docs/progress.md`

Update this block at the end of each approved phase.

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
10. **Sandbox only.** Do not connect live providers, move real funds, or deploy contracts to Base mainnet. Provider sandboxes and Base Sepolia testnet transactions are permitted and must be labelled sandbox. Base mainnet remains forbidden. Every sandbox record and screen is visibly labelled as sandbox.
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
- **Credentials:** when a credential, account or external value is needed, ask using the CREDENTIAL REQUEST format in `docs/progress.md`. Batch requests at the start of a phase. Never print, log or commit a value. Refuse anything that looks like a live or production key.

## Engineering practices

Carried over from the Phase 0 working agreement.

- **Build the smallest working slice.** Do not create empty directories or speculative abstractions from the target tree in §11.2. Add them when a phase needs them.
- **Write tests first for financial invariants:** journal balance, precision, idempotency, state transitions and tenant isolation.
- **Pricing and tariffs are data.** Provider fees, free bands, caps and FX rates are versioned configuration with effective dates, never hardcoded constants.
- **Docs move with code.** Update the relevant architecture doc or ADR in the same change as the code.

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
| Start local database | `pnpm db:start` (stop: `pnpm db:stop`; wipe: `pnpm db:reset`) |
| Migrate | `pnpm db:migrate` |
| Regenerate `schema.prisma` and client after a migration | `pnpm -r db:pull && pnpm db:generate` |
| Lint | `pnpm lint` |
| Typecheck | `pnpm typecheck` |
| Test | `pnpm test` (needs `pnpm db:start`; one package: `pnpm vitest run --project api`) |
| Format | `pnpm format` (check: `pnpm format:check`) |
| Build | `pnpm build` |
| Seed sandbox data | `pnpm db:seed` (after build and migrate) |
| Run API / worker | `pnpm start:api` / `pnpm start:worker` (after build; reads `.env.local`) |
| Contract tests | Not available. No smart contracts exist (ADR 0006). |

Run `format:check`, `lint`, `typecheck` and `test` before reporting any work as done. CI runs the same four, plus a check that `schema.prisma` matches the migrations.

Schema changes: write a new SQL file under `services/api/prisma/migrations/`, never edit an applied one. SQL is the source of truth; `schema.prisma` is generated from the database.

## End-of-phase report format

1. What was built, with file paths
2. Tests added, and their results
3. Decisions made, with ADR links
4. Open questions added
5. Risks or shortcuts taken
6. Proposed next step
