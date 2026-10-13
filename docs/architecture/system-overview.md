# AORA — System Overview

State after Phase 2. Sandbox only. Staging is https://aora-api.vercel.app (Vercel's Production target; **not live**). This document describes what exists, not what is planned; for plans see [delivery-plan.md](delivery-plan.md).

## What runs

One codebase, `services/api`, with two processes and one PostgreSQL database.

| Process | Entry point | Does |
|---|---|---|
| API | `src/main.ts` | Serves `/v1`. Signs users in, creates payment intents, receives webhooks, serves operator endpoints |
| Worker (local only) | `src/worker.ts` | A loop that drains the outbox and delivers simulator webhooks, for local development |
| Jobs (deployed) | `GET /v1/internal/cron/*` on the API | Authenticated, idempotent, time-bounded routes: outbox, simulator webhooks, reconciliation. Triggered three ways ([ADR 0013](../adr/0013-hosting-vercel-neon.md)): the API drains the outbox in the background after each request; a GitHub Actions schedule calls the routes every 5 minutes (reconciliation hourly); Vercel's daily cron is a last net |

There is no user interface, no deployment, no chain code and no real provider yet. Hosting will be Vercel and Neon; **Vercel's "Production" target is AORA staging, not live.**

## The one flow that exists

```text
user ──▶ POST /v1/auth/challenges, /v1/auth/sessions        (sandbox authenticator)
user ──▶ POST /v1/payment-intents  (Idempotency-Key)
           one transaction: intent(created) + transition + audit + outbox(submit)
worker ─▶ outbox(submit):  created ─▶ submitting (committed)
                           call simulator.collect
                           accepted ─▶ pending_provider | rejected ─▶ failed | unknown ─▶ status_unknown
simulator ▶ POST /v1/webhooks/sandbox  (signed)
           one transaction: raw payload stored (deduplicated) + outbox(webhook)
worker ─▶ outbox(webhook): one transaction: intent ─▶ succeeded + journal entry
operator ▶ POST /v1/ops/reconciliation-runs
           settlement report × intents × ledger ─▶ exceptions (record only)
```

Journal entry for a successful collection of amount *a* in KES:

| Account | Owner | Debit | Credit |
|---|---|---|---|
| `provider_clearing` (sandbox_sim) | platform | *a* | |
| `merchant_collections_pending` | merchant | | *a* |

## What is real and what is simulated

| Part | Status |
|---|---|
| PostgreSQL schema, row-level security, ledger invariants, outbox, state machine, reconciliation | Real |
| Authentication | Clerk session tokens, verified by the API; AORA maps them to its own persons and decides all access. **Implemented and tested with stand-ins; not yet run against a real Clerk instance** |
| Email | Notifications module with a Resend adapter. **Not yet run against a real Resend account** |
| PIN step-up, permissions, consent, rate limiting | Real |
| Payment provider | **Simulated.** AORA's own simulator; it imitates no real provider |
| Settlement, fees, payouts, refunds | Not built |
| Chart of accounts | A sandbox assumption (open question M-4) |

## Module map

See [domain-boundaries.md](domain-boundaries.md). Money rules: [financial-ledger.md](financial-ledger.md). Access rules: [security-and-tenancy.md](security-and-tenancy.md). API contract: [../api/openapi.yaml](../api/openapi.yaml).

## Operating it locally

`pnpm db:start`, `pnpm db:migrate`, `pnpm build`, `pnpm db:seed`, then `pnpm start:api` and `pnpm start:worker`. Details in the README.

Signals worth watching once this is deployed (none are wired to alerts yet):

- outbox rows in `dead`, and the age of the oldest `pending` row;
- payment intents in `status_unknown` or `reconciliation_required`;
- open reconciliation exceptions;
- audit events with outcome `denied`.
