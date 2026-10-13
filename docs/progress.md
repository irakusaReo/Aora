# AORA — Progress

Read this with `CLAUDE.md` to resume work in a fresh session.

- **Goal:** sandbox MVP on Vercel and Neon ([mvp-scope.md](product/mvp-scope.md)).
- **Current phase:** Phase 3 ([plan](plans/phase-3.md)), on branch `phase-3`. Phase 2 closed with its report on 2026-10-13.
- **Last updated:** 2026-10-13

## Done

- **Phase 0** and **Phase 1** — approved.
- **Phase 2, 2A to 2D** — built, on `main`, deployed. Staging is **https://aora-api.vercel.app** (Vercel Production target; sandbox, not live). Neon project `aora` in Frankfurt, branches `main` (staging) and `development`.
- **Rulings of 2026-10-13 (third set) applied:** Clerk for authentication (ADR 0011 accepted, ADR 0019); Resend for email (ADR 0020); Africa's Talking dropped; brief §2.1 amended; open questions O-11 (phone verification), O-12 (cross-border data), O-13 (sending domain) added; setup guides for Clerk and Resend written.
- **Decisions acted on (ADR 0013):** GitHub connected to Vercel (`main` deploys to staging, pull requests get protected previews); migrations run from GitHub Actions, never the Vercel build, expand-then-contract; previews have no database; background work is a drain after each request plus a GitHub Actions schedule, at no cost. Deployment Protection confirmed as Standard Protection.

## Phase 2, 2E and 2F — merged, deployed, verified on staging (2026-10-13)

- Pull request #1 is merged; `main` deploys to staging on every push. Clerk and Resend variables are set on Vercel (Production target = AORA staging). Migration `…000500_clerk_notifications` is applied to Neon `main` and `development`.
- **Clerk (ADR 0019):** development instance `prompt-tarpon-2259`. Test mode off. Phone is **off in Clerk** (paid feature); AORA holds the phone number via `PUT /v1/me/phone`. Webhook `https://aora-api.vercel.app/v1/webhooks/clerk` subscribed to user and email events. Verified on staging with real events: user created, updated, deleted (account anonymised).
- **Resend (ADR 0020):** key with full access; webhook registered through the API; **no verified domain**, so mail goes from `onboarding@resend.dev` and only to the Resend account owner's address, often into Spam.
- **Journey J2 and the payment path pass on staging through a real Clerk session** (token obtained from Clerk's Backend API, since no web app exists yet): account provisioned on first request, PIN set and step-up, sensitive action gated, cross-tenant refused, payment to `succeeded`, payment alert delivered by Resend, reconciliation clean, trial balance zero. The outbox drained in the background after requests (`waitUntil`) with no cron call.
- **Sign-in emails through Resend work.** With "Delivered by Clerk" off for `verification_code`, Clerk's `email.created` event reaches staging and Resend delivers it (subject `[SANDBOX] [Development] … is your verification code`). The assumed payload fields (`to_email_address`, `subject`, `body`, `body_plain`) are confirmed. The template was switched to self-delivery through Clerk's Backend API at 18:30 on 2026-10-13 and is in that state now.
- Fixes made from real traffic: provider timestamps bound as bigint; Prisma client generated in the build step (Git-triggered Vercel builds were failing); tokens with no `azp` claim accepted, origin allow-list enforced in AORA's code.
- 223 tests pass locally. CI's `Lint, typecheck and test` job passes; **`Migrate staging` fails on every push to `main`** until the GitHub secret exists.

## Phase 3 checkpoints

- **3A-1 done (branch `phase-3`, not merged):** versioned tariffs with gross, fee and net on every collection ([ADR 0021](adr/0021-fees-settlement-and-payout-ledger.md)); tier limits; branches; cashier limited to their branch; collection list with cursor; fee quote. Migration `…000600_tariffs_branches` (expand-only, **not yet on staging**). 258 tests pass.
- **Next:** 3A-2 onboarding with ADR 0012 matching and review queue, staff invitation by email, operator API. Then 3A-3 web apps, 3B Daraja, 3C settlement, payouts and refunds, 3D developer API.

## Next (carried from Phase 2)

1. **Owner confirms** the sign-in code arrives (check Spam, `from:onboarding@resend.dev`). If not found, switch delivery back: `POST https://api.clerk.com/v1/templates/email/verification_code/toggle_delivery` with `{"delivered_by_clerk": true}`.
2. **End-of-phase report for Phase 2**, then stop for approval. It must include the Phase 3 credential request (Daraja sandbox) and any build-order change from Clerk and Resend.
3. Owner adds GitHub Actions secrets `STAGING_DATABASE_URL_OWNER` and `STAGING_CRON_SECRET` (values are in `.env.local` under those names).
4. Owner adds a Vercel Deployment Check on the CI job (dashboard).

## Blocked

- Nothing blocks the Phase 2 report. Scheduled jobs and automatic staging migration wait for the two GitHub secrets.

## Waiting on the owner

- Confirmation of the sign-in email; the two GitHub secrets; the Deployment Check.
- O-13: a sending domain (until then only the owner's own address receives mail, often in Spam).
- O-10: Vercel Hobby is for non-commercial use; Pro is $20 per month.
- O-11: phone verification (recommended: confirm before money is sent).
- O-5 (MTN market), O-6 (bank), O-7 (image storage): needed for Phases 4 and 5.

## Known gaps carried forward

- Members are invited by phone number; should become invitation by email (Phase 3).
- The owner's staging account has a random PIN that was not recorded; reset it by signing in again once an app exists.
- Whether Expo session tokens lack the `azp` claim is unverified (ADR 0019); confirm with the mobile apps.
- `seed.ts` and `worker.ts` use top-level await (local only; never the Vercel entry file).
- Retired tables still exist (`auth_challenge`, `session`, `sim_sms`): drop in a later release.
- React Email not yet adopted (ADR 0020).
- Daraja, Airtel, MTN and bank behaviour: nothing assumed; read from current documentation in each checkpoint.
- CBK conduct rules and the legal status of layaway not yet verified (O-8, O-9).

## How to run

See the Commands section of `CLAUDE.md`. Short version: `nvm use && pnpm db:start && pnpm db:migrate && pnpm test`. Local work uses `AUTH_PROVIDER=sandbox` and the simulated email channel.
