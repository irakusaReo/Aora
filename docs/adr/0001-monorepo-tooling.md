# ADR 0001 — Monorepo tooling and package manager

- **Status:** Proposed
- **Date:** 2026-10-13
- **Related:** brief §11; open questions [E-3](../architecture/open-questions.md#e-3)

## Context

The brief (§11.1) fixes a TypeScript stack across web, mobile and backend in one repository. The repository is empty. CLAUDE.md asks for the smallest working setup and no speculative structure.

## Decision

- **pnpm workspaces** as the package manager and workspace tool, version pinned through the `packageManager` field and a committed lockfile. CI installs with a frozen lockfile.
- **No task orchestrator** (Turborepo, Nx) yet. Root scripts run lint, typecheck and tests across the workspace. Add one only when build times or the dependency graph demand it, by a new ADR.
- **Node 24 LTS**, pinned in `.nvmrc`, `engines` and CI.
- **TypeScript in strict mode**, one `tsconfig.base.json` that every package extends. Pinned to the 6.0 line until the linter supports 7.x (E-3).
- **ESLint (flat config) with typescript-eslint, and Prettier** for formatting. Lint has zero tolerance for warnings in CI.
- **Vitest** as the test runner for all TypeScript packages. Its compatibility with NestJS decorator metadata is unproven here and is the first check in Phase 1; Jest is the fallback (E-3).
- Workspace globs are added when the first package of that kind is created. The initial globs are `packages/*` and `services/*` only.
- Dependencies are exact-pinned (`save-exact`). Dependency lifecycle scripts are not run unless explicitly allow-listed.

## Alternatives considered

- **npm workspaces:** fewer moving parts, but looser dependency isolation (packages can import undeclared dependencies), which matters for enforcing module boundaries.
- **Yarn:** no advantage here over pnpm.
- **Nx or Turborepo from day one:** caching and graph tooling for a repository with no packages is premature.
- **Bun as runtime and package manager:** less proven for the NestJS and Prisma stack the brief specifies.
- **Separate repositories per product:** contradicts the brief's single modular monolith.

## Consequences

- One install, one lockfile, one set of commands for the whole platform.
- pnpm's strict `node_modules` layout surfaces undeclared dependencies early; some tools may need configuration to cope with it.
- No build caching until an orchestrator is added; acceptable while the repository is small.
- Contracts (ADR 0006) use a non-Node toolchain and sit outside the pnpm workspace.
