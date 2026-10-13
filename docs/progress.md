# AORA — Progress

Read this with `CLAUDE.md` to resume work in a fresh session.

- **Goal:** sandbox MVP on Vercel and Neon ([mvp-scope.md](product/mvp-scope.md)).
- **Current phase:** Phase 2 ([plan](plans/phase-2.md)), checkpoints 2E (Clerk) and 2F (Resend).
- **Last updated:** 2026-10-13

## Done

- **Phase 0** and **Phase 1** — approved.
- **Phase 2, 2A to 2D** — built, on `main`, deployed. Staging is **https://aora-api.vercel.app** (Vercel Production target; sandbox, not live). Neon project `aora` in Frankfurt, branches `main` (staging) and `development`.
- **Rulings of 2026-10-13 (third set) applied:** Clerk for authentication (ADR 0011 accepted, ADR 0019); Resend for email (ADR 0020); Africa's Talking dropped; brief §2.1 amended; open questions O-11 (phone verification), O-12 (cross-border data), O-13 (sending domain) added; setup guides for Clerk and Resend written.
- **Decisions acted on (ADR 0013):** GitHub connected to Vercel (`main` deploys to staging, pull requests get protected previews); migrations run from GitHub Actions, never the Vercel build, expand-then-contract; previews have no database; background work is a drain after each request plus a GitHub Actions schedule, at no cost. Deployment Protection confirmed as Standard Protection.

## Built, on branch `phase-2-clerk-resend`, not merged

**Merging deploys to staging, and the new code will not start without the Clerk and Resend variables. Do not merge until they are set in Vercel.**

- **2E** — `ClerkAuthProvider` behind `AuthProvider` (session tokens verified with Clerk's library; live keys refused); just-in-time account provisioning; Clerk webhook sync, idempotent and order-safe; user deletion that anonymises identity and keeps every financial record; PIN bound to the Clerk session, set only with a fresh sign-in factor; Clerk test identities refused when deployed; AORA's own codes, sessions, SMS sender and inbox removed.
- **2F** — notifications module with an email channel and a Resend adapter; once-only sending through the outbox; delivery status from Resend webhooks; payment alerts; sign-in emails from Clerk delivered and never stored; `GET /v1/notifications`.
- **Also** — background drain after requests (`waitUntil`); `scheduled-jobs.yml`; a `Migrate staging` job in CI.
- 218 tests pass locally; lint, typecheck, format and build are clean.
- **Not yet proven:** anything against a real Clerk instance or Resend account; the field names of Clerk's email event; `waitUntil` under NestJS on Vercel.

## Next

1. Owner: Clerk and Resend accounts and keys (`docs/operations/clerk-setup.md`, `resend-setup.md`), two GitHub secrets, the domain decision.
2. Set variables in Vercel; migrate staging; merge the branch; create the webhooks; hand sign-in emails to Resend.
3. Re-run J2 and the payment path on staging through Clerk with a real sign-in email.
4. End-of-phase report, Phase 3 credential requests (Daraja), and any change to the build order.

## Blocked

- 2E and 2F on staging: waiting for Clerk and Resend credentials.
- The `Migrate staging` and scheduled-jobs workflows: waiting for the two GitHub secrets.

## Waiting on the owner

- Credential request: Clerk keys and webhook secret; Resend key and webhook secret; `STAGING_CRON_SECRET` and `STAGING_DATABASE_URL_OWNER` as GitHub Actions secrets.
- O-13: a sending domain, or stay on Resend's test sender (then only the Resend account's own address can receive mail).
- O-10: Vercel's Hobby plan is for non-commercial use; AORA is commercial. Pro is $20 per month.
- O-11: how phone numbers are verified (recommended: confirm before money is sent).
- A Deployment Check in Vercel so a deployment waits for CI (dashboard step).
- O-5 (MTN market), O-6 (bank), O-7 (image storage): needed for Phases 4 and 5.

## Known gaps carried forward

- Members are invited by phone number; should become invitation by email (Phase 3).
- Retired tables still exist (`auth_challenge`, `session`, `sim_sms`): drop in a later release.
- React Email not yet adopted (ADR 0020).
- Daraja, Airtel, MTN and bank behaviour: nothing assumed; read from current documentation in each checkpoint.
- CBK conduct rules and the legal status of layaway not yet verified (O-8, O-9).

## How to run

See the Commands section of `CLAUDE.md`. Short version: `nvm use && pnpm db:start && pnpm db:migrate && pnpm test`. Local work uses `AUTH_PROVIDER=sandbox` and the simulated email channel.
