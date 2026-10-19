# Running the AORA mobile apps (sandbox)

The three Expo apps (`apps/kony-mobile`, `apps/chiwo-mobile`, `apps/kelo-mobile`) are clients of the AORA API. They run in **Expo Go** on a phone or in an emulator; no Expo account, EAS build or app-store account is needed ([phase-9.md](../plans/phase-9.md) P9-3). Everything is sandbox: the staging API, a Clerk development instance, simulated or sandbox rails, testnet USDC.

## One-time set-up (owner)

1. **Clerk Native API.** In the Clerk Dashboard for the development instance, open **Native applications** and switch on the Native API. Without it a native app cannot sign in. Clerk notes that it opens a request path that bypasses browser CAPTCHA; acceptable on a development instance capped at 100 users.
2. **Expo Go** from the Play Store or App Store on the phone.
3. Nothing to add to `.env.local`: each app's `app.config.ts` reads only `CLERK_PUBLISHABLE_KEY` (already there for the API) and, optionally, `AORA_MOBILE_API_URL` (default `https://aora-api.vercel.app`, the staging API). The file is parsed, not loaded, so no secret enters the bundler. A key that does not start `pk_test_` stops the app at start.

## Run an app

```bash
pnpm --filter kony-mobile start
```

Scan the QR code with Expo Go (Android) or the camera (iOS). The phone and the computer must be on the same network, or start with `-- --tunnel`.

To use a local API instead of staging, set `AORA_MOBILE_API_URL` in `.env.local` to the computer's LAN address (for example `http://192.168.1.20:3000`); a phone cannot reach `127.0.0.1` on the computer. The local API must use the same Clerk development instance (`AUTH_PROVIDER=clerk`), because the sandbox authenticator is for automated tests only.

## What each app does

| App | On the phone | On the web app instead |
|---|---|---|
| `kony-mobile` | Choose a workspace, accept an invitation, collect by M-Pesa (STK push) or simulator, collections with gross, fee and net, refunds, balances by type, settlements, payouts with the fee shown first, USDC treasury and withdrawal approval, PIN and phone | Onboarding, branches, team, pay codes, payout recipients, developer keys, the KELO store and listings, treasury addresses and new withdrawals, NAM Vault |
| `chiwo-mobile` | Sign-up (phone, terms), pay a shop by pay code with the fee first, payment status and receipt, activity, USDC balance, find and confirm a person and send USDC, payment requests (create, pay, cancel), NAM position, PIN and phone | Registering an on-chain address, withdrawing on chain, NAM orders and redemptions |

## Checks

- `pnpm vitest run --project mobile --project kony-mobile --project chiwo-mobile`: screens rendered with a fake API, in CI.
- `cd apps/kony-mobile && npx expo export --platform android --output-dir dist && node ../../scripts/check-mobile-bundle.mjs .`: the bundle builds, stays within budget and holds nothing secret-shaped. CI runs it for every app.
- **Device check (manual, owner walk-through):** each journey once on a mid-range Android phone on a throttled connection, including signing in, a PIN step-up and a "we are checking" state (choose the simulator scenario `timeout_then_success`).

## Security notes

- The session token is kept only by Clerk's secure token cache (Keychain, Keystore). Idempotency keys for money actions are kept in the same secure storage until the outcome is definite. Nothing else is stored on the phone; read data is cached in memory only.
- The PIN is held in memory only while it is typed and is cleared once sent.
- Every screen sits under the sandbox banner.
