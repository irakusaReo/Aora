# MVP gate runbook (sandbox)

How to bring AORA staging to the state the MVP gate (G1, [mvp-scope.md](../product/mvp-scope.md) §4) asks for, and check it. Everything here is sandbox: AORA staging is Vercel's "Production" target and is not live. Plan: [phase-10.md](../plans/phase-10.md).

## 1. Check (read-only, any time)

```bash
pnpm --filter @aora/api build
```

```bash
pnpm gate:check staging
```

Add `--cron` to also call the seven cron jobs (they run their idempotent work). Each line prints PASS or FAIL with a short reason and no secret:

| Line | What it proves |
|---|---|
| api health | `/v1/health` answers ok, database ok, mode sandbox (chain shown as information) |
| trial balance is zero in every asset | debits equal credits per asset over every posting |
| every running balance equals its postings | no account balance has drifted from its postings |
| no open reconciliation exception | the reconciliation queue is empty |
| every category has a published listing | the demo catalogue covers all twelve categories |
| contract addresses match contracts/deployments | the API's configured contracts are the deployed ones |
| cron … (with `--cron`) | each scheduled route answers 200 |

`pnpm gate:check` (no target) checks the local database and an API on `PUBLIC_API_URL`.

## 2. Demo catalogue

```bash
pnpm db:seed:demo staging
```

Creates, through the API's own services, five sandbox demo stores vetted for all twelve categories, thirteen published listings and every plan their categories allow. Safe to run again: a second run changes nothing. Credit plans (Pay in 4, monthly financing) can only be offered while `kelo_credit` is on, so **run it again after switching the flag on** to add them. Demo accounts are synthetic: `+999` numbers, `.test` emails, `demo_` subjects no Clerk user can have.

## 3. Reset (waits for the owner: O-17)

Ledger entries cannot be deleted by anyone (by design), so "reset staging" means rebuilding the database. No reset command for staging exists until the owner chooses how ([open-questions.md](../architecture/open-questions.md) O-17). Locally:

```bash
pnpm db:reset
```

then `pnpm db:migrate && pnpm db:seed && pnpm db:seed:demo`.

## 4. Journeys and their automated proof

Each journey's exit tests run locally and in CI on every change. How they run against staging waits for O-18.

| Journey | Automated tests (`services/api/test/` unless stated) | On staging today |
|---|---|---|
| J1 sign in, intent, webhook, ledger, reconciliation | `payment-flow` | Walk-through |
| J2 sign-in, PIN, step-up, roles | `auth`, `clerk-provider`, `deployed-guard`, `pin`, `permissions`, `rate-limit`, `audit` | Walk-through |
| J3 onboarding, branches, staff | `onboarding`, `branches`, `members`, `invitations` | Walk-through |
| J4 M-Pesa collection, gross/fee/net, settlement | `daraja`, `payment-intent`, `settlement`, `pricing` | Walk-through (test number only, O-14) |
| J5 operator exceptions, look-ups, audit | `ops`, `reconciliation` | Walk-through |
| J6 payout with fee preview, refund | `payouts`, `daraja-b2c`, `refunds` | Walk-through |
| J7 API key, idempotent `/v1`, signed webhook, replay | `developer`, `webhook` | Walk-through |
| J9 USDC in and out with approval | `chain-startup`, `chain-operations`, `chain-observer`, `chain-treasury` (local chain) | **Waits for the funded wallet** |
| J10 three-way reconciliation, anchoring | `chain-reconciliation` | **Waits for the funded wallet** |
| J11 NAM fund, hold, withdraw | `nam` | **Waits for the funded wallet** |
| J12 CHIWO sign-up, pay, USDC, requests, receipts | `chiwo-payments`, `chiwo-usdc` | Walk-through (USDC on chain waits for the wallet) |
| J13 NAM in CHIWO and KONY | `chiwo-nam`, `nam` | **Waits for the funded wallet** |
| K1 enlist, provisioning, listing | `kelo-provisioning`, `kelo-catalogue` | Walk-through |
| K2 Pay in N, electronics | `kelo-credit`, `kelo-credit-repayment`, `kelo-credit-repayments` | Needs `kelo_credit` on (O-20) |
| K3 monthly financing, solar | `kelo-credit`, `kelo-credit-schedule`, `kelo-credit-repayments` | Needs `kelo_credit` on (O-20) |
| K4 layaway, holidays | `kelo-layaway`, `kelo-schedule` | Walk-through (simulator rail) |
| K5 return pauses and reduces | `kelo-credit-returns` | Needs `kelo_credit` on (O-20) |
| K6 decline with reasons | `kelo-credit` | Needs `kelo_credit` on (O-20) |
| K7 merchant dashboard | `kelo-dashboard`, `kelo-credit-returns` | Walk-through |
| K8 the same on mobile | `apps/kelo-mobile/test`, `apps/kony-mobile/test` | Device check (O-19) |
| Demo data in twelve categories | `demo-data` | After `pnpm db:seed:demo staging` |
| G1 gate check | `gate-check` | `pnpm gate:check staging --cron` |

## 5. Gate run order (once O-17 to O-20 are answered and the wallet is funded)

1. Reset staging (O-17), or confirm the existing data is clean.
2. Deploy the contracts and switch the chain on (CLAUDE.md, Current state).
3. `pnpm db:seed:demo staging`; switch `kelo_credit` on (O-20); run the demo seed again.
4. Journey scripts or the walk-through (O-18), with the device check (O-19).
5. `pnpm gate:check staging --cron`: every line PASS.
