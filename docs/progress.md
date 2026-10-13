# AORA — Progress

Read this with `CLAUDE.md` to resume work in a fresh session.

- **Goal:** sandbox MVP on Vercel and Neon ([mvp-scope.md](product/mvp-scope.md)).
- **Current phase:** Phase 2 ([plan](plans/phase-2.md)).
- **Last updated:** 2026-10-13

## Done

- **Phase 0** and **Phase 1** — approved.
- **Rulings of 2026-10-13 (second set) applied:** hosting on Vercel and Neon (ADR 0013); rails (0014); contracts (0015); mobile (0016); KELO as a consumer BNPL marketplace (0017, 0018; brief amendments in §2.3 and §4.6); `kelo-experience.md`; `mvp-scope.md` rewritten with the new build order; M-1 to M-7 resolved; owner defaults O-1 to O-4 and open questions O-5 to O-10 recorded; CLAUDE.md updated; setup guides written.

## Built in Phase 2 so far (not yet approved)

- **2A** — import-direction lint rule with a test that plants violations; database access with no session state, proven through a transaction-mode pooler with one server connection; cron job routes (outbox, simulator webhooks, reconciliation) that are authenticated, idempotent, time-bounded and lease-protected; the deployed-environment guard that makes the fixed code impossible off a developer machine; `vercel.json` (region `fra1`, schedules); Neon bootstrap, migrate and verify scripts (written, not yet run against Neon).
- **2C** — random one-time codes behind `AuthProvider` with an `SmsSender` interface and a simulated sender; PIN set, change, lockout and step-up; sign-out.
- **2D** — permission map and a hand-written route × role matrix test; member management behind step-up with a last-admin rule enforced in the database; consent records; rate limiting in PostgreSQL.
- 187 tests pass locally and in CI; lint, typecheck, format and build are clean. `main` is pushed and the first CI run (2026-10-13) passed, including the pooled-connection tests and the schema drift check.

## 2B progress

- **Neon: done (2026-10-13).** Project `aora` (`little-block-25898321`), Frankfurt, PostgreSQL 16, branches `main` (staging) and `development`. Three roles created with SQL; migrations applied without superuser rights; `pnpm neon:verify` passes through the pooler on both branches.
- **Real check through Neon's pooler:** the built API, run locally against the development branch, refused to start with the fixed code, then signed in with a one-time code, took a payment to `succeeded` using only the cron routes, and reconciled clean.
- Found and fixed there: transactions now have explicit limits (10 s to start, 20 s to run), because the driver's 5 s default cut off the seed when run from Kenya against Frankfurt.
- **Vercel: deployed (2026-10-13).** Staging is **https://aora-api.vercel.app** (Vercel Production target; sandbox, not live), project `aora-api`, Hobby plan, function in `fra1`. Cron schedules are daily on Hobby (ADR 0013, O-10); jobs are run by hand with the cron secret meanwhile.
- **Journey J2 passes on staging**, with one-time codes read from the simulated inbox: fixed code rejected, sign-in, PIN set and step-up, a sensitive action blocked then allowed, role permissions, a payment to `succeeded`, clean reconciliation, sign-out.
- **Latency from Nairobi:** about 1.7 s on the first request after a deployment, 370–530 ms warm.
- Fixed during deployment: top-level `await` on `listen` hung every request; a type error that only Vercel's build reported; `.vercelignore` added.

## Next

1. **Finish 2B:** owner checks Deployment Protection in the dashboard; decide whether to connect GitHub for automatic deployments and the Neon preview-branch integration.
2. **2E:** read Africa's Talking's current documentation, build the `SmsSender` adapter, send a real code on staging, then remove the SMS inbox token.
3. End-of-phase report, revised build order, Phase 3 credential requests.

## Blocked

- **2B** is done except: connecting GitHub for automatic deployments, the Neon integration for preview branches, and a dashboard check of Deployment Protection.
- **2E** waits for Africa's Talking sandbox credentials.

## Waiting on the owner

- Africa's Talking sandbox credentials (2E).
- Whether to delete the old, empty Neon project `Aora` in Ohio (`lingering-grass-59855278`).
- O-10: Hobby chosen for now; decide how background work is triggered promptly before Phase 3 (Pro, request-driven draining, or an external scheduler).
- O-5 (MTN market), O-6 (bank), O-7 (image storage): needed for Phases 4 and 5, not now.

## Known gaps carried forward

- Africa's Talking, Daraja, Airtel, MTN and bank behaviour: nothing is assumed; each is read from current documentation in its checkpoint.
- CBK Digital Credit Provider conduct rules and the legal status of layaway are not yet verified (O-8, O-9).

## How to run

See the Commands section of `CLAUDE.md`. Short version: `nvm use && pnpm db:start && pnpm db:migrate && pnpm test`.
