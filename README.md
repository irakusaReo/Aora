# AORA

> **Sandbox only.** This repository connects to no live provider, moves no real funds and deploys nothing to Base mainnet.

AORA is a fintech platform launching in Kenya first: one modular monolith with separate financial domains.

- **CHIWO** — consumer payments and money movement
- **KONY** — merchant operating system
- **KELO** — credit and financing
- **NAM Vault** — investments and vaults, embedded in CHIWO and KONY

**Current state: Phase 2 in progress.** The API has one-time-code sign-in, PIN step-up, role permissions, consent records, rate limiting and scheduler-triggered jobs, on top of the Phase 1 payment slice. One-time-code delivery and the payment provider are still simulated. Nothing is deployed yet; hosting will be Vercel and Neon, where **Vercel's "Production" target is AORA staging, not live**. See [docs/progress.md](docs/progress.md).

## Read first

| Document                                                                                       | What it is                                            |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| [CLAUDE.md](CLAUDE.md)                                                                         | Operating rules for this repository                   |
| [docs/architecture/master-development-brief.md](docs/architecture/master-development-brief.md) | Authoritative specification                           |
| [docs/architecture/delivery-plan.md](docs/architecture/delivery-plan.md)                       | Phases, entry and exit criteria, first vertical slice |
| [docs/progress.md](docs/progress.md)                                                           | What is done, next and blocked                        |
| [docs/architecture/system-overview.md](docs/architecture/system-overview.md)                   | What exists today and how it fits together            |
| [docs/architecture/open-questions.md](docs/architecture/open-questions.md)                     | Unresolved decisions. Check before assuming anything  |
| [docs/adr/](docs/adr/)                                                                         | Architecture decision records                         |
| [docs/product/kony-competitive-lessons.md](docs/product/kony-competitive-lessons.md)           | Requirements from competitor research                 |

## Requirements

- Node.js 24 (see `.nvmrc`)
- pnpm, at the version in the `packageManager` field of `package.json` (installed by corepack)
- PostgreSQL 16 server binaries (`initdb`, `pg_ctl`) for the local database. On Ubuntu: the `postgresql` package

## Setup

```bash
nvm install
```

```bash
corepack enable
```

```bash
pnpm install
```

```bash
cp .env.example .env.local
```

Open `.env.local` and replace each `<generate-locally>` with its own output of `openssl rand -hex 32`. `.env.local` is git-ignored; never commit it.

```bash
pnpm db:start
```

```bash
pnpm db:migrate
```

`pnpm db:start` creates a throwaway PostgreSQL cluster under `.local/pg`, listening on `127.0.0.1:54329` with trust authentication. It is for development and tests only.

## Run it

```bash
pnpm build
```

```bash
pnpm db:seed
```

```bash
pnpm start:api
```

In a second terminal:

```bash
pnpm start:worker
```

The seed creates two sandbox merchants and five accounts with phone numbers `+99900000001` (admin), `…02` (finance), `…03` (cashier), `…04` (another merchant's admin) and `…09` (platform operator). With `AUTH_PROVIDER=fixed` (local development only) the sign-in code is `000000`; it cannot be enabled on a deployed environment. The API contract is [docs/api/openapi.yaml](docs/api/openapi.yaml).

## Commands

| Command                                  | What it does                               |
| ---------------------------------------- | ------------------------------------------ |
| `pnpm install`                           | Install dependencies from the lockfile     |
| `pnpm db:start` / `db:stop` / `db:reset` | Start, stop or wipe the local database     |
| `pnpm db:migrate`                        | Apply SQL migrations                       |
| `pnpm lint`                              | ESLint, failing on any warning             |
| `pnpm typecheck`                         | TypeScript, no emit                        |
| `pnpm test`                              | Run all tests once (needs `pnpm db:start`) |
| `pnpm format` / `format:check`           | Format with Prettier, or check only        |
| `pnpm build`                             | Compile the API and worker                 |
| `pnpm db:seed`                           | Load sandbox demo data                     |
| `pnpm start:api` / `start:worker`        | Run the API or the worker                  |

CI runs `format:check`, `lint`, `typecheck` and `test` on every push to `main` and every pull request, against a PostgreSQL service container.

## Repository layout

```text
.github/workflows/   CI
docs/adr/            Architecture decision records
docs/api/            OpenAPI contract
docs/architecture/   Specification, delivery plan, open questions, system documents
docs/plans/          One plan per phase
docs/product/        Product requirements and MVP scope
docs/research/       Background research (context, not requirements)
scripts/             Local database helper
services/api/        API and worker (NestJS), SQL migrations, tests
tests/               Repository-level tests
```

Further application, integration and contract directories are created when a phase needs them.
