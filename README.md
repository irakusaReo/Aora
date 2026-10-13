# AORA

> **Sandbox only.** This repository connects to no live provider, moves no real funds and deploys nothing to Base mainnet.

AORA is a fintech platform launching in Kenya first: one modular monolith with separate financial domains.

- **CHIWO** — consumer payments and money movement
- **KONY** — merchant operating system
- **KELO** — credit and financing
- **NAM Vault** — investments and vaults, embedded in CHIWO and KONY

**Current phase: Phase 0 — bootstrap and planning.** There is no application code yet. The repository contains the specification, proposed architecture decisions, a delivery plan and the workspace tooling.

## Read first

| Document                                                                                       | What it is                                            |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| [CLAUDE.md](CLAUDE.md)                                                                         | Operating rules for this repository                   |
| [docs/architecture/master-development-brief.md](docs/architecture/master-development-brief.md) | Authoritative specification                           |
| [docs/architecture/delivery-plan.md](docs/architecture/delivery-plan.md)                       | Phases, entry and exit criteria, first vertical slice |
| [docs/architecture/open-questions.md](docs/architecture/open-questions.md)                     | Unresolved decisions. Check before assuming anything  |
| [docs/adr/](docs/adr/)                                                                         | Architecture decision records                         |
| [docs/product/kony-competitive-lessons.md](docs/product/kony-competitive-lessons.md)           | Requirements from competitor research                 |

## Requirements

- Node.js 24 (see `.nvmrc`)
- pnpm, at the version in the `packageManager` field of `package.json`

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
cp .env.example .env
```

`.env` is git-ignored. `.env.example` contains placeholders only; never commit real values.

## Commands

| Command             | What it does                           |
| ------------------- | -------------------------------------- |
| `pnpm install`      | Install dependencies from the lockfile |
| `pnpm lint`         | ESLint, failing on any warning         |
| `pnpm typecheck`    | TypeScript, no emit                    |
| `pnpm test`         | Run the test suite once                |
| `pnpm test:watch`   | Run tests in watch mode                |
| `pnpm format`       | Format with Prettier                   |
| `pnpm format:check` | Check formatting without writing       |

CI runs `format:check`, `lint`, `typecheck` and `test` on every push to `main` and every pull request.

Commands for the dev server, database migrations and contract tests do not exist yet. They are added in the phase that introduces them.

## Repository layout

```text
.github/workflows/   CI
docs/adr/            Architecture decision records
docs/architecture/   Specification, delivery plan, open questions
docs/product/        Product requirements
docs/research/       Background research (context, not requirements)
tests/               Repository-level tests
```

Application, service, integration and contract directories are created when a phase needs them.
