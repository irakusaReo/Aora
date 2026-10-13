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
- **Vercel: account created on the Hobby (free) plan.** Cron schedules are therefore daily (ADR 0013, O-10). CLI install, login, project link and first deployment are next.

## Next

1. **2B with the owner:** Neon then Vercel, one step at a time (`docs/operations/`). First unknowns to settle on the real platforms: that Vercel builds this NestJS app from `services/api`, and cold-start latency.
2. **2E:** read Africa's Talking's current documentation, build the `SmsSender` adapter, send a real code on staging, then remove the SMS inbox token.
3. End-of-phase report, revised build order, Phase 3 credential requests.

## Blocked

- **2B** waits for the Vercel CLI login.
- **2E** waits for Africa's Talking sandbox credentials.

## Waiting on the owner

- Vercel account and login; Africa's Talking sandbox credentials.
- Whether to delete the old, empty Neon project `Aora` in Ohio (`lingering-grass-59855278`).
- O-10: Hobby chosen for now; decide how background work is triggered promptly before Phase 3 (Pro, request-driven draining, or an external scheduler).
- O-5 (MTN market), O-6 (bank), O-7 (image storage): needed for Phases 4 and 5, not now.

## Known gaps carried forward

- Cold-start latency on Vercel is unmeasured until 2B.
- Africa's Talking, Daraja, Airtel, MTN and bank behaviour: nothing is assumed; each is read from current documentation in its checkpoint.
- CBK Digital Credit Provider conduct rules and the legal status of layaway are not yet verified (O-8, O-9).

## How to run

See the Commands section of `CLAUDE.md`. Short version: `nvm use && pnpm db:start && pnpm db:migrate && pnpm test`.
