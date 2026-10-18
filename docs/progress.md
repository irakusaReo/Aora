# AORA — Progress

Read this with `CLAUDE.md` to resume work in a fresh session.

- **Goal:** sandbox MVP on Vercel and Neon ([mvp-scope.md](product/mvp-scope.md)).
- **Current phase:** Phase 4 — KELO commerce ([plan](plans/phase-4.md)) is complete and on staging (end-of-phase report 2026-10-18). Next: Phase 5 — chain and contracts, under the owner's run mode of 2026-10-18 (see CLAUDE.md); the MVP gate is Phase 10.
- **Build order:** re-sequenced 2026-10-18 in [mvp-scope.md](product/mvp-scope.md) §3. Old Phase 4 (rails) is now the post-gate Rails expansion phase; later phases moved up by one.
- **Last updated:** 2026-10-18 (owner approvals 1–3 carried out; Phase 5 started)

## Owner decisions of 2026-10-18

- Phase 3 **approved**. The owner's signed-in walk-through of staging is pending and blocks nothing; anything found is fixed by rolling forward.
- All other decisions are recorded in [open-questions.md](architecture/open-questions.md#owner-rulings-2026-10-18), the [ADR 0014](adr/0014-multi-rail-multi-country.md) addendum and [country-provider-model.md](architecture/country-provider-model.md).
- **O-14 (new, open):** Safaricom's FAQ implies that a sandbox STK push approved on a real handset debits real M-Pesa funds until a next-day reversal, so the walk-through has no real-number step and the code stays test-number only until the owner decides.

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

- **3A-1 done and on `main`:** versioned tariffs with gross, fee and net on every collection ([ADR 0021](adr/0021-fees-settlement-and-payout-ledger.md)); tier limits; branches; cashier limited to their branch; collection list with cursor; fee quote. Migration `…000600_tariffs_branches` (expand-only, applied to staging 2026-10-13). 258 tests pass.
- **3A-2 done:** merchant onboarding with ADR 0012 matching (exact match never hands a workspace to a second applicant; possible duplicates wait in an operator review queue and create nothing); staff invitations by email ([ADR 0019](adr/0019-clerk-integration.md) addendum); operator API for exceptions (resolved with an audited reason), user and merchant lookup, and the audit trail; `GET /v1/workspace`. Migration `…000700_onboarding` (expand-only). 297 tests pass. Exception types proven end to end: six of eight (`stuck_status_unknown` and `ledger_mismatch` are covered by their own Phase 1 tests, not by the resolution test).
- **Owner confirmations of 2026-10-14, carried out:** sign-in codes are delivered by Clerk again ([ADR 0020](adr/0020-notifications.md) addendum, with the reverse command); the Daraja sandbox certificate is in [services/api/certs](../services/api/certs/README.md) (note: it expired in 2016); Vercel projects `kony-web` and `internal-ops` exist (no deployment yet, so their origins are not yet in `CLERK_AUTHORIZED_PARTIES`: add them at the first deploy in 3A-3); `DARAJA_CALLBACK_SECRET` and `WEBHOOK_SIGNING_PRIVATE_KEY` are on `aora-api` (Production target = staging, sensitive); retired tables dropped by migration `20261014000100_drop_retired_tables`.
- **Daraja credentials (2026-10-14):** all nine `DARAJA_*` values present and well formed in `.env.local`; sandbox OAuth token request **passes** (HTTP 200, `expires_in` 3599). The consumer key and secret are the pair that was pasted into the chat. **Owner decision, 2026-10-14: accepted risk for the sandbox; the owner cannot regenerate the pair and will create a new Daraja app with new credentials before any production use.** All `DARAJA_*` variables are on `aora-api` (Production target = staging): key, secret, passkey and initiator password as sensitive; shortcodes, initiator name and test numbers as plain configuration.
- **Operator flag granted (2026-10-14):** the owner's staging account (`ailaowano@…`, account `40c7170d…`) is a platform operator, at the owner's request in chat, through `pnpm ops:grant-operator` (audit event `identity.operator.granted`).
- **3A-3 done and deployed (2026-10-14):** `kony-web` at https://kony-web.vercel.app and `internal-ops` at https://internal-ops-rho.vercel.app (Vercel projects on Hobby, Root Directory `apps/<name>`, connected to GitHub, Clerk keys and `AORA_API_URL` on the Production target only). `CLERK_AUTHORIZED_PARTIES` on `aora-api` now also lists both origins. Shared `packages/api-client` (exact money conversion) and `packages/ui` (sandbox banner on every page, tested). CI builds both apps. **Not yet exercised with a real sign-in:** the owner's walk-through below is the check.
- **Incident, 2026-10-13:** the unfinished 3A-1 working tree reached `main` through pull request #3 while CI was red, so staging ran code whose migration had not been applied (collections and reconciliation returned 500). Fixed by applying `…000600_tariffs_branches` to staging by hand (expand-only) and merging the completed checkpoint (pull request #4). Staging health, all three jobs and `pnpm neon:verify staging` pass. Lesson: nothing merges to `main` while CI is red, and never before its migration is on staging.
- **GitHub Actions secrets** `STAGING_DATABASE_URL_OWNER` and `STAGING_CRON_SECRET` exist (2026-10-13). `Migrate staging` passes. The scheduled-jobs workflow passes its outbox and simulator steps; its reconciliation step failed only because of the incident above.
- **Daraja credentials: not in `.env.local` yet** (checked 2026-10-13: none of the `DARAJA_*` names are present). `DARAJA_CALLBACK_SECRET` and `WEBHOOK_SIGNING_PRIVATE_KEY` are generated locally (`pnpm secrets:generate`); not yet on Vercel. What Daraja's documentation says is in [providers/daraja.md](providers/daraja.md).
- **Owner decisions of 2026-10-13 (reply to the Phase 2 report):** O-11 confirmed-recipient rule approved, plus a configurable cap and cooling-off period for the first payout to a newly confirmed destination; Daraja callback token plus status query approved, with an IP allow-list as an extra layer and tokens redacted from logs (with a test); invitations by email approved; retired tables (`auth_challenge`, `session`, `sim_sms`) to be dropped in a contract migration this phase; sign-in codes to go back to Clerk delivery (Resend stays for alerts and reminders). **Not yet carried out, awaiting the owner's confirmation in chat:** the Clerk delivery switch, the certificate download, the two Vercel projects, copying variables to Vercel, and the operator flag.
- **Vercel Deployment Checks:** Vercel's documentation (vercel.com/docs/deployment-checks, last updated 2026-08-11, read 2026-10-13) states no plan restriction and lists two prerequisites: the project linked through Vercel for GitHub, and automatic aliasing for production turned on. Whether the Hobby dashboard offers it is unconfirmed. Nothing configured.
- **3B done, merged and deployed (2026-10-14, PR #11):** the `mpesa` rail goes to the real Daraja sandbox ([ADR 0022](adr/0022-daraja-integration.md)): STK push to the Daraja test number only, a per-operation token in each callback URL, a status query before anything reaches the ledger, callbacks checked against the query in either order, unknown pushes never resent, tokens kept out of logs (tested). Migration `20261014000200_mpesa` (expand-only, on staging). On staging a forged callback is refused (401). A real STK push from kony-web has not yet been run end to end on staging. Behaviour observed in the real sandbox is recorded in [providers/daraja.md](providers/daraja.md). 328 tests pass.
- **3C done, merged and deployed (PR #12, fix #13):** settlement batches and view; payout recipients confirmed by entering the number twice with a PIN (records intent, not ownership); first-payout cooling-off and cap as versioned data; payouts with the previewed fee enforced, reservation and exact release; Daraja B2C payouts (test number only) with Transaction Status when no result arrives; refunds capped by a database trigger, simulator only (X-14); kony-web Money and Refund pages. ADR 0021 and 0022 addenda. Migration `20261014000300_settlement_payouts_refunds` (expand-only). 374 tests pass.
- **3C on staging (2026-10-14, PR #12):** deployed; settlement initially failed on staging because the 3C migration's account backfill could not see workspaces through row-level security (the empty test database hid this). Fixed forward by migration `20261014000400_backfill_workspace_accounts`, applied to staging; settlement then made one batch of two collections, and a repeat run made none. A test now guards migration backfills from `tenancy.workspace`.
- **3D done, merged and deployed (2026-10-14, PR #14):** API keys (shown once, stored as hashes, scope mapped onto the cashier or finance role, never able to pass a step-up, workspace routes only); Ed25519-signed webhooks for collection, payout and refund results, with delivery log, retries, `dead` after six attempts, and replay with the same event id; public signing key endpoint; address checks against private and loopback targets; kony-web Developers page ([ADR 0023](adr/0023-developer-api.md)). Migration `20261014000500_developer` (expand-only). 397 tests pass.
- **Not yet exercised on staging with a real sign-in:** a Daraja STK push from kony-web, a B2C payout, a refund, an API key call and a webhook delivery. Their automated tests pass; the owner's walk-through is the staging check.
- **Next:** owner approval of Phase 3, then Phase 4 (more rails) after its credential request is answered.

## Phase 4 checkpoints

- **4A done (2026-10-18):** KELO store enlistment (new business or existing KONY workspace), operator vetting against category requirements, ADR 0008 provisioning (one step per transaction, backfill, audited retry, restrictions copied and enforced), twelve sandbox categories (O-15), catalogue with three listing types, stock and capacity bounds, prohibited items, moderation with revisions, public marketplace search, images through Vercel Blob client tokens (simulator until the store is connected). kony-web `/kelo` and `/w/<id>/kelo`; internal-ops `/kelo`. Migrations `20261018000100_kelo_stores`, `20261018000200_kelo_catalogue` (expand-only). ADR 0008 and 0017 addenda.

- **4A and 4B merged and on staging (2026-10-18, PR #16):** migrations `…000100` to `…000300` applied to staging first; health, KELO public routes and all four cron jobs (including the new `kelo-provisioning-backfill`) pass on staging. 4B: quotes for quote-based services; consumer row-level barrier (`withConsumer`); `apps/kelo-web` built (browse, listing, quotes, terms, purchases) but **not deployed**: its Vercel project and its origin in `CLERK_AUTHORIZED_PARTIES` need the owner's approval.
- **4C built (2026-10-18):** layaway (journey K4): plan templates, category rules, refund rules and terms as data; merchant plan offers; schedule engine (property-tested); purchases with reservation, consent, ordered instalment payments claimed before creation, held funds (`kelo_layaway_funds_held`), fulfilment by category evidence with settlement net of the discount fee, cancellation refunds by rule through the simulator. Payment intents gain `purpose`; layaway intents are excluded from merchant collections, refunds, webhooks and settlement, and reconciled against held funds. Migration `20261018000400_kelo_layaway` (expand-only). ADR 0017 and 0021 addenda.

## Next

1. **4C merged and on staging (PR #17):** migration `…000400_kelo_layaway` applied to staging first; health, plans route, layaway terms and all five cron jobs pass; reconciliation clean. 490 tests pass.
2. **kelo-web deployed (2026-10-18, owner-approved):** Vercel project `kelo-web` (Hobby, Root Directory `apps/kelo-web`, `fra1`, GitHub `main`), Production variables `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` (sensitive), `AORA_API_URL`; origin `https://kelo-web.vercel.app` added to `CLERK_AUTHORIZED_PARTIES` on `aora-api`, which was redeployed. The first deploy's browse page failed (500) because `/v1/assets` needed a session; it is now public reference data. **Flag for the owner:** `kony-web` runs in `iad1`, not `fra1`.
3. Phase 5 (chain and contracts): write `docs/plans/phase-5.md`; contracts need Foundry installed locally (ADR 0006); build against a local chain until the Base Sepolia batch (requested 2026-10-18) arrives.
2. Phase 5 (chain and contracts) needs the Base Sepolia batch (RPC URL, funded testnet signer key, explorer API key), requested on 2026-10-18 ahead of time. Until it arrives, chain work runs against a local chain.

## Owner approvals of 2026-10-18 — carried out

- **Approval 1, Vercel Blob:** public store `aora-sandbox-images` (`store_pJL8dirFLcJQiXYg`, `fra1`) created from the CLI and connected to `aora-api` (Production = staging, Development). `BLOB_READ_WRITE_TOKEN` is in `.env.local` (pass) and on Vercel; only `aora-api` needs it. A client-token upload, inspect and anonymous public read passed from the owner's machine. KELO images switch from the simulator to Blob on the next `aora-api` deploy (the adapter is chosen by the token's presence). Details and caveats: [providers/vercel-blob.md](providers/vercel-blob.md). **Two things for the owner:** the CLI's `--yes` pulled Development variables into `.env.local` itself (it merged; every key was kept, checked without printing; backup now at `.env.local.backup-20261018`, git-ignored), and Vercel created the token as a plain variable, not sensitive; making it sensitive means remove and re-add, which waits for the owner.
- **Approval 2, regions:** `aora-api` and `kelo-web` already ran in `fra1`; `kony-web` and `internal-ops` ran in `iad1`. All three apps now pin `fra1` in `apps/<name>/vercel.json`.
- **Approval 3, Base Sepolia:** sandbox signer generated by `services/api/scripts/generate-sandbox-signer.mjs` (key in `.env.local` only, pass). Public address **`0xEfBB9b5761BB2633cCB94a294628Dd63124Cedb5`** (AORA sandbox testnet wallet, Base Sepolia only). Waiting for the owner to fund it; then the key goes to `aora-api` as a sensitive variable. `BASE_SEPOLIA_RPC_URL` = `https://sepolia.base.org` for development: Base's docs say its RPCs "are rate-limited, they are not suitable for production apps" (no figure published; read 2026-10-18). A second/private RPC provider is on the pre-pilot list. **Etherscan:** its supported-chains page lists Base Sepolia as "Paid Tier Only" (read 2026-10-18), so no key is requested; contract verification uses a free verifier instead (Phase 5 plan).

## Blocked

- Nothing blocks Phase 5. Real Base Sepolia transactions wait for the wallet to be funded; until then chain work runs on a local chain.

## Waiting on the owner

- Fund the sandbox wallet with Base Sepolia ETH and testnet USDC.
- Whether to make `BLOB_READ_WRITE_TOKEN` sensitive on Vercel (remove and re-add).
- O-14: whether a real Safaricom number may be used in the Daraja sandbox.
- The signed-in staging walk-through (non-blocking).
- Pre-pilot list: [open-questions.md](architecture/open-questions.md#pre-pilot-list-carried-2026-10-18).

## Known gaps carried forward

- The owner's staging account has a random PIN that was not recorded; reset it by signing in again once an app exists.
- Whether Expo session tokens lack the `azp` claim is unverified (ADR 0019); confirm with the mobile apps.
- `seed.ts` and `worker.ts` use top-level await (local only; never the Vercel entry file).
- React Email not yet adopted (ADR 0020).
- Daraja, Airtel, MTN and bank behaviour: nothing assumed; read from current documentation in each checkpoint.
- CBK conduct rules and the legal status of layaway not yet verified (O-8, O-9).

## How to run

See the Commands section of `CLAUDE.md`. Short version: `nvm use && pnpm db:start && pnpm db:migrate && pnpm test`. Local work uses `AUTH_PROVIDER=sandbox` and the simulated email channel.
