# Phase 10 Plan — MVP gate

- **Status:** in progress (2026-10-19): 10A and 10B built; 10C to 10E wait for O-17 to O-20 and the funded wallet. Started on the owner's instruction of 2026-10-19 ("start Phase 10 … stopping where an owner decision is needed").
- **Scope source:** [mvp-scope.md](../product/mvp-scope.md) §3 (row 10) and §4 "Gate" (G1); every journey of §4 except J8 (Rails expansion, after the gate).
- **G1 exit tests:** reset is idempotent; health checks green; all journey scripts pass; trial balance zero; no open reconciliation exception; contract addresses match `contracts/deployments/`.
- **Branch:** one per checkpoint (`phase-10a` …), merged under the usual rules.

## What already exists

- Twelve KELO categories on staging (taxonomy data, O-15), but **no listing** on the staging marketplace.
- Every journey has automated API tests run locally and in CI (`services/api/test`), using the test-only sandbox authenticator, which is refused on staging by design (CLAUDE.md, ADR 0019).
- Health route, seven cron jobs, the reconciliation job, ledger invariants enforced by the database (entries immutable: update, delete and truncate are refused even for a superuser).

## Checkpoints

| | Contents | Needs from the owner |
|---|---|---|
| **10A** | **Demo catalogue:** an operator script `pnpm db:seed:demo [local\|staging]` that creates, through the API's own services (not HTTP, not SQL), sandbox demo stores vetted for all twelve categories, each with published listings and every plan its category allows; K2 electronics (Pay in 4), K3 solar (monthly financing with a deposit) and K4 holidays (layaway, scheduled sessions) in depth. Idempotent: a second run changes nothing. No ledger entry. | Nothing. Additive sandbox data, so it runs on staging after merge |
| **10B** | **Gate check:** `pnpm gate:check [local\|staging]`, read-only: health ok; the seven cron jobs answer 200 (staging); trial balance zero per currency; no open reconciliation exception; every category has a published listing; contract addresses equal `contracts/deployments/` (or "not deployed" as a failure with its reason). Reports pass or fail per line, never a secret | Nothing |
| **10C** | **Journey scripts:** one script per journey (J1–J7, J9–J13, K1–K7) driving the HTTP API as a client would, behind a token source. Locally and in CI they run against an in-process API with the sandbox authenticator. On staging they need signed-in sessions (O-18) | **O-18** for the staging run |
| **10D** | **Reset:** `pnpm gate:reset local` rebuilds the local database (drop, migrate, seed, demo seed) and is tested idempotent. The staging reset and its runbook wait for the owner (O-17), because it deletes staging data | **O-17** |
| **10E** | **Gate run on staging:** reset, gate check, journey scripts, then the report | O-17, O-18, the funded wallet (J9–J11 and the contract check), the `kelo_credit` flag on (O-20) |

## 1. Decisions taken in this plan

| # | Decision | Why | Recorded in |
|---|---|---|---|
| P10-1 | **Demo data goes through the services, as an operator script,** like the existing `seed.ts` and `grant-operator.mjs`: it never mints a session or uses the sandbox authenticator, so the deployed-environment guard stays intact | The sandbox authenticator must stay refused on staging; SQL inserts would skip the domain's own checks | this plan |
| P10-2 | **Demo identities are synthetic:** one sandbox merchant account per demo store with a `+999` phone, a `.test` email and an identity-provider subject (`demo_…`) that no Clerk user can ever have, so nobody can sign in as them | No real person, no Clerk account created | this plan |
| P10-3 | **Fixed demo keys:** every demo record is found by a fixed key (store idempotency key, listing title within its store), so a re-run creates nothing new | G1 "reset is idempotent"; seeding twice must be harmless | — |
| P10-4 | **Demo listings carry no image** (the image path needs Blob uploads); the screens already handle a listing without one | Keeps the seed free of external calls | — |
| P10-5 | **The gate check is read-only** and reads the ledger through the platform connection, never the owner connection; the cron calls use `STAGING_CRON_SECRET` from `.env.local`, read and never printed | Least privilege; credential protocol | — |
| P10-6 | **Journey scripts are clients, not tests of internals:** each runs over HTTP with a token source, so the same script runs locally (sandbox authenticator) and on staging (O-18) | One script per journey, as mvp-scope §4 asks | — |

## 2. Owner decisions this phase needs (recorded in open-questions)

| # | Question | Options | Recommended default |
|---|---|---|---|
| **O-17** | How is staging reset to seeded data? Ledger rows cannot be deleted (by design), so a reset means rebuilding the database | (a) Rebuild in place: drop the application schemas on the Neon `main` branch through the direct connection, re-run every migration and the role bootstrap, then seed and demo-seed. Deletes all staging records, including your own walk-through data. (b) A fresh Neon branch per gate run, with `aora-api` switched to it (a Vercel Production variable change each time; Neon branches may count against the plan). (c) No reset: run the gate on top of existing staging data, after checking it is clean | **(a)**, run by hand with a typed confirmation, only when you say so |
| **O-18** | How do journey scripts sign in on staging, where the test authenticator is refused and Clerk test mode is off? | (a) Create three gate users in the Clerk development instance through Clerk's Backend API and sign them in with Clerk sign-in tokens (creates users in your Clerk instance; uses the secret key from `.env.local`). (b) Run the scripts locally and in CI only, and cover staging with your signed-in walk-through plus the read-only gate check. (c) You sign in and run each script yourself | **(b)** for the MVP: no new authentication path on staging. (a) only if you want automated staging journeys |
| **O-19** | Mobile end-to-end on an Android emulator (P9-12) | (a) Maestro on an emulator in GitHub Actions (long runs; Actions minutes may be billable on a private repository). (b) Manual device check in the walk-through | **(b)** |
| **O-20** | Switch `kelo_credit` on for staging for the gate (K2, K3, K5, K6) | On for the gate run (an operator action you take in internal-ops `/flags`), or off and those journeys proven locally only | On for the gate run, by you |
| (existing) | Fund the sandbox wallet | Needed for J9–J11 on staging and the contract check | — |

## 3. Tests

- 10A: seeding an empty test database creates stores vetted for all twelve categories and at least one published listing in each; K2, K3, K4 listings offer their plans; a second run creates nothing; no ledger entry is written; demo accounts cannot authenticate.
- 10B: on a seeded test database the check passes; it fails on an unbalanced currency (simulated through a stub reader), on an open reconciliation exception, and on a category without a listing.
- 10C: each journey script passes against the in-process API in CI.
- 10D: running the local reset twice ends in the same state.

## 4. Files

- `services/api/src/demo-data.ts`, `services/api/src/seed-demo.ts`, `services/api/scripts/seed-demo-env.mjs`.
- `services/api/src/gate/` (check), `services/api/scripts/gate-check.mjs`.
- `services/api/test/demo-data.test.ts`, `services/api/test/gate-check.test.ts`, `services/api/test/journeys/*.test.ts`.
- `docs/operations/gate-runbook.md`; `open-questions.md` (O-17 to O-20); `progress.md`.
