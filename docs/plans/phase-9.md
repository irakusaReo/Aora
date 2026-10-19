# Phase 9 Plan — Mobile

- **Status:** in progress (2026-10-19): 9A merged (PR #35); 9B built (PR #36); 9C built. Run mode of 2026-10-18 (CLAUDE.md): no approval stop between phases.
- **Scope source:** [mvp-scope.md](../product/mvp-scope.md) §3 (checkpoints 9A, 9B, 9C) and journey K8; [ADR 0016](../adr/0016-mobile-architecture.md) (mobile architecture), [ADR 0019](../adr/0019-clerk-integration.md) (Clerk); [kelo-experience.md](../product/kelo-experience.md).
- **Branch:** one per checkpoint (`phase-9a`, `phase-9b`, `phase-9c`). Merge rules as before: CI green on the head commit, every needed Vercel variable present, then staging health and every cron job confirmed. Phase 9 adds no migration and no Vercel project: the apps are clients of the staging API and are not hosted.
- **Test discipline:** tests strictly first for the idempotency-key store (a key survives an app restart), the outcome classifier (a timeout is "unknown", never "failed"), token storage (secure storage only), and the money formatting the apps use. Screens are tested alongside, rendered with a mocked API in CI.
- **Sandbox:** every screen shows the sandbox banner. The apps talk only to the staging API (or a local API) with a Clerk development-instance key; a `pk_live_` key is refused at start.

## Checkpoints

| | Contents | Needs from the owner |
|---|---|---|
| **9A** | Shared foundation: `packages/mobile` (sandbox banner, theme tokens, copy helper, API provider, secure idempotency-key store, outcome classifier, PIN step-up prompt, state views); `@aora/api-client` made device-safe; root Vitest project for mobile; CI bundle check. `apps/kony-mobile`: sign-in, workspace choice, invitations, balances by type, collect by M-Pesa (STK push) with pay codes, collections with gross/fee/net and refunds, settlements, payouts with fee preview and PIN, treasury view with withdrawal approval, PIN | Nothing to build. To try it on a phone: switch on Clerk's **Native API** for the development instance (dashboard, no cost) |
| **9B** | `apps/chiwo-mobile`: sign-up (phone, terms), pay a shop by pay code with fee shown first, payment status and receipt, activity, USDC balance, receive address and send to a confirmed recipient, payment requests (create, pay, cancel), NAM view, PIN | Nothing |
| **9C** | `apps/kelo-mobile`: marketplace (categories, search, listing), plan selector and plan-at-a-glance card, layaway and Pay in N checkout, credit decision with reasons (behind the flag), purchases hub, pay an instalment, statement, cancel, confirm delivery, returns and disputes. KELO merchant screens in `kony-mobile`: dashboard, orders needing action (confirm, fulfil), claims (accept, reject) | Nothing |

## 1. Decisions taken in this plan

| # | Decision | Why | Recorded in |
|---|---|---|---|
| P9-1 | **Expo SDK 58** (React Native 0.88, React 19.3.0, expo-router 58), read from Expo's `bundledNativeModules.json` on 2026-10-19. React 19.3.0 is the version the web apps already use, so the monorepo has one React | Current SDK; one React avoids duplicate-React failures in a monorepo (Expo monorepo guide, read 2026-10-19) | ADR 0016 addendum |
| P9-2 | **pnpm isolated installs stay** (no `nodeLinker: hoisted`). Expo documents support for isolated dependencies from SDK 54 and configures Metro for monorepos automatically from SDK 52, so no `metro.config.js` is written. Hoisting is the documented fallback if a library breaks | Keeps the stricter dependency graph the repo already relies on | ADR 0016 addendum |
| P9-3 | **Expo Go, no binary build.** Everything used runs in Expo Go: expo-router, expo-secure-store, expo-crypto, and Clerk's Expo SDK with **hosted authentication** (Clerk's quickstart lists it as "works in Expo Go"). Native Clerk components and passkeys, which need a development build, are not used. So no Expo or EAS account is needed in Phase 9 | Owner ruling: ask for an Expo account only when a binary build is truly needed | ADR 0016 addendum |
| P9-4 | **Sign-in is Clerk hosted authentication** (`useHostedAuth` from `@clerk/expo/hosted-auth`, Account Portal in an in-app browser), which offers the methods enabled on the instance, that is, the email code. The session token is kept by Clerk's `tokenCache` from `@clerk/expo/token-cache`, which stores it with expo-secure-store (Keychain, Keystore). Nothing else stores a token. The API already accepts a token with no `azp` claim, which is what a native client sends (`clerk-auth-provider.ts`) | ADR 0016 rule 4; ADR 0019; the least code that meets both | ADR 0019 addendum |
| P9-5 | **Configuration** comes from the repository's `.env.local` through each app's `app.config.ts` (read with `process.loadEnvFile`): the existing `CLERK_PUBLISHABLE_KEY` (public by design; parsed from the file, which is never loaded whole, so no secret enters the bundler's environment) and `AORA_MOBILE_API_URL` (default `https://aora-api.vercel.app`, the staging API). Both are passed in `extra` and read with expo-constants. A `pk_live_` key stops the app at start with a message. No new credential | No secret is ever bundled: the publishable key is public, and the API URL is not a secret | `.env.example` |
| P9-6 | **`packages/mobile`** (`@aora/mobile`) holds what the three native apps share: sandbox banner, theme, translator, API provider and hooks, idempotency-key store, outcome classifier, PIN prompt, state views and form pieces. ADR 0016 said tokens only are shared between web and native; this package is shared between native apps only. Copy stays per app | Three apps, one implementation of the safety rules | ADR 0016 addendum |
| P9-7 | **Idempotency from the device:** a money action has a named *slot* (for example `kony.payout:<recipient>:<amount>`). The key for a slot is created once with `expo-crypto`'s `randomUUID`, saved in secure storage before the first attempt, reused on every retry including after the app is killed, and cleared only on a definite outcome (success, or a refusal the API states). A slot whose outcome is unknown keeps its key, and the screen offers "check again", which repeats the request with the same key | ADR 0016 rule 2; K8 "idempotency key survives an app restart"; CLAUDE.md rule 6 | — |
| P9-8 | **Outcomes:** an API error with a code is *refused* (shown with the API's own words); `step_up_required` opens the PIN prompt and then repeats the same request with the same key; a timeout, a network failure or a 5xx is **unknown** ("We are checking"), never "failed" and never "done". Status screens read the record's own state (`status_unknown`, `reconciliation_required` shown as "being checked") | ADR 0016 rule 3; CLAUDE.md rule 7 | — |
| P9-9 | **`@aora/api-client` on a device:** a timeout fallback when `AbortSignal.timeout` is missing, and a distinct `AoraNetworkError` for a request whose outcome is unknown (timeout or no response), so callers never mistake it for a refusal. The web apps keep working unchanged | The client was written for the server side of the web apps | — |
| P9-10 | **Mobile scope per app is the daily journeys; one-off set-up stays on the web:** merchant onboarding, branches and team management, invitations sent, developer keys, KELO store enlistment and the listing editor, treasury addresses and new withdrawals, and NAM orders stay in the web apps. Each mobile app links to its web app for them. Accepting an invitation, approving a withdrawal, payouts, refunds and every consumer journey are on mobile | Set-up is done once at a desk and is long; the mobile apps stay small for modest phones (ADR 0016 rule 6). A recommended default with no money, legal or irreversible effect | mvp-scope §3 note |
| P9-11 | **Tests in CI without a device:** Vitest runs each app's tests with `react-native` aliased to `react-native-web` and jsdom, so screens render with a mocked API, including loading, empty, error, refused and unknown states. Expo modules are reached only through `packages/mobile` ports, so tests replace them with in-memory versions | ADR 0016 testing table (unit and component levels); one test runner for the repository | ADR 0016 addendum |
| P9-12 | **End-to-end on an emulator (Maestro) is deferred** to the MVP gate preparation, where it needs a development build and an Android emulator in CI; until then each journey's API behaviour is covered by the existing API journey tests, and the screens by component tests. The device check (one mid-range Android phone, throttled) is a manual step for the owner's walk-through | A development build changes P9-3 and CI cost; the API tests already prove the journeys' rules | open-questions (Eng default) |
| P9-13 | **Contract check:** a test collects every `/v1/...` path the mobile apps call and requires it in `docs/api/openapi.yaml`, with the same method | ADR 0016 contract level; the client is hand-typed, not generated | — |
| P9-14 | **Bundle budget:** CI runs `expo export --platform android` for each app and fails if the Hermes bytecode bundle exceeds 6 MB (the first app, `kony-mobile`, measured 4.3 MB on 2026-10-19) or contains secret-shaped text (`scripts/check-mobile-bundle.mjs`) | ADR 0016 rule 6 | — |
| P9-15 | **Hygiene for mobile code:** a test scans `apps/*-mobile` and `packages/mobile` for floating-point money helpers (`parseFloat`, `toFixed`, `Math.round`), `AsyncStorage`, direct `fetch` outside the API client, `console.log`, and for any write to Clerk metadata; each app's root layout must render the sandbox banner and pass Clerk the secure `tokenCache` | CLAUDE.md rules 3, 9, 10; ADR 0016 rules 4 and 7; ADR 0019 | — |
| P9-16 | **Push notifications are not built** in Phase 9 (they need a development build for Android and a push service). Email (ADR 0020) remains the channel | ADR 0016 rule 10 applies when they are added | open-questions (Eng default) |

## 2. Data model and API

No migration and no new endpoint is planned: the apps use the routes the web apps use (listed per screen below). If a screen needs a route that does not exist, it is added to the API with its OpenAPI entry, permissions-matrix row and tests, in the same checkpoint.

## 3. Screens and the routes they call

### 9A `kony-mobile`

| Screen | Routes |
|---|---|
| Sign in | Clerk hosted authentication |
| Workspaces, invitations | `GET /v1/me`, `GET /v1/workspace`, `GET /v1/me/invitations`, `POST /v1/me/invitations/{id}/accept` |
| Home: balances by type | `GET /v1/ledger/balances`, `GET /v1/assets` |
| Collect (STK push), status | `GET /v1/pay-codes`, `POST /v1/payment-intents`, `GET /v1/payment-intents/{id}` |
| Collections: gross, fee, net; refund | `GET /v1/payment-intents`, `POST /v1/payment-intents/{id}/refunds`, `GET /v1/refunds/{id}` |
| Settlements | `GET /v1/settlements` |
| Payouts | `GET /v1/payout-recipients`, `POST /v1/payouts/preview`, `POST /v1/payouts`, `GET /v1/payouts/{id}` |
| Treasury: view, approve or reject a withdrawal | `GET /v1/treasury`, `POST /v1/treasury/withdrawals/{id}/approval`, `POST /v1/treasury/withdrawals/{id}/rejection` |
| PIN and step-up | `PUT /v1/auth/pin`, `POST /v1/auth/step-up`, `PUT /v1/me/phone` |

### 9B `chiwo-mobile`

| Screen | Routes |
|---|---|
| Sign-up | `GET /v1/chiwo/me`, `PUT /v1/me/phone`, `GET /v1/terms/{key}`, `POST /v1/chiwo/sign-up` |
| Pay a shop; status and receipt (one screen, as on the web) | `POST /v1/chiwo/payments/quote`, `POST /v1/chiwo/payments`, `GET /v1/chiwo/receipts/{kind}/{id}` |
| Activity | `GET /v1/chiwo/activity` |
| USDC: balance, find and confirm a person, send | `GET /v1/chiwo/usdc`, `GET`/`POST /v1/chiwo/recipients`, `POST /v1/chiwo/recipients/{id}/confirm`, `POST /v1/chiwo/transfers` |
| Requests | `GET`/`POST /v1/chiwo/requests`, `GET /v1/chiwo/requests/{id}`, `POST /v1/chiwo/requests/{id}/pay`, `POST /v1/chiwo/requests/{id}/cancel` |
| NAM view | `GET /v1/chiwo/nam` |

### 9C `kelo-mobile` and KELO in `kony-mobile`

| Screen | Routes |
|---|---|
| Marketplace, listing, plans | `GET /v1/kelo/categories`, `GET /v1/kelo/marketplace/listings`, `GET /v1/kelo/marketplace/listings/{id}`, `GET /v1/kelo/marketplace/listings/{id}/plans` |
| Checkout (layaway, Pay in N, credit) | `POST /v1/kelo/purchases`, `GET /v1/kelo/credit/limit`, `POST /v1/kelo/credit/decisions`, `GET /v1/kelo/credit/decisions/{id}`, `GET /v1/terms/{key}` |
| Purchases hub, instalments, statement | `GET /v1/kelo/me/purchases`, `GET /v1/kelo/me/purchases/{id}`, `POST …/instalments/{seq}/pay`, `POST …/credit/instalments/{seq}/pay`, `GET …/credit/quote`, `POST …/credit/repay`, `GET …/credit/statement`, `POST …/cancel`, `POST …/confirm-delivery` |
| Credit statement | `GET /v1/kelo/me/purchases/{id}/credit/statement` |
| Returns and disputes (listed on the purchase) | `POST /v1/kelo/me/purchases/{id}/claims`, `POST …/claims/{claim}/withdraw` |
| KONY: KELO dashboard, orders, claims | `GET /v1/workspace/kelo/dashboard`, `GET /v1/workspace/kelo/purchases`, `POST …/purchases/{id}/confirm`, `POST …/purchases/{id}/fulfil`, `POST /v1/workspace/kelo/claims/{id}/accept`, `POST …/claims/{id}/reject` |

With `kelo_credit` off, credit routes answer `not_found` and the apps show no credit screen or word, as the web app does.

### 9C notes

- **Two calls, one slot:** checkout creates the purchase and takes the first payment. Both keys derive from one stored slot key (`<key>.purchase`, `<key>.pay`), so "check again" after an unknown outcome replays both and the API answers each from its record.
- **No figures computed on the phone:** a layaway card shows "paid of total" (both API figures); paying early uses the API's own `next` and `payoff` quotes and sends the quoted amount back; the statement shows the API's totals.
- **The marketplace requires sign-in on mobile:** one root gate keeps the apps simple; the web marketplace stays browsable signed out.
- **Asking for a quote** stays on the web (P9-10).

## 4. Files

- `packages/mobile/` — `src/` (banner, theme, i18n, api provider, intent keys, outcome, PIN prompt, components), `test/`, `vitest.config.ts`.
- `apps/kony-mobile/`, `apps/chiwo-mobile/`, `apps/kelo-mobile/` — `app.config.ts`, `app/` (expo-router routes, thin), `src/screens/`, `src/messages.ts`, `test/`, `vitest.config.ts`, `tsconfig.json`.
- `packages/api-client/src/client.ts` (P9-9) with tests.
- Root: `vitest.config.ts` (apps project glob), `eslint.config.js` (React Native files), `.github/workflows/ci.yml` (export and bundle budget), `.env.example` (`AORA_MOBILE_API_URL`).
- Docs: ADR 0016 and 0019 addenda, `open-questions.md`, `progress.md`, `docs/operations/mobile.md` (running in Expo Go against staging).

## 5. Tests

- `packages/mobile`: intent-key store (same key after a restart, cleared only on a definite outcome, never shared between slots); outcome classifier (timeout, network, 5xx → unknown; 4xx with code → refused; `step_up_required` → PIN); secure token cache is the only token store; translator (named placeholders, missing key fails the test); banner renders and is announced.
- `packages/api-client`: timeout fallback; `AoraNetworkError` on timeout and on a network failure.
- Each app: every screen in loading, empty, data, refused and unknown states with a mocked API; money shown from minor-unit strings with the asset's exponent; a money action sends the stored key and the same key on retry and after a simulated restart; a step-up error opens the PIN prompt and repeats with the same key; role-based presentation (a cashier sees no payout or treasury action) while the API still decides.
- Repository: hygiene scan (P9-15), contract check (P9-13), sandbox banner in every app's root layout.

## 6. Risks

- **Hosted authentication in Expo Go** depends on Clerk's redirect handling for the Expo Go scheme; it is verified on a device during the owner's walk-through. If it fails, the fallback is Clerk's custom email-code flow (also Expo Go compatible), which changes only the sign-in screen.
- **Clerk's Native API** must be switched on for the development instance before a native app can sign in. Clerk warns that it opens a request path that bypasses browser CAPTCHA; acceptable on a development instance capped at 100 users.
- **react-native-web in tests** is not React Native: layout and native-only behaviour are not tested in CI, only structure, copy and logic. The device check covers the rest.
