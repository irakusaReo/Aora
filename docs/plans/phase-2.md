# Phase 2 Plan — Hosting foundation and real sign-in

- **Status:** scope approved by the owner on 2026-10-13. Proceeding.
- **Scope source:** owner's Phase 2 list; [mvp-scope.md](../product/mvp-scope.md) journey J2; [ADR 0013](../adr/0013-hosting-vercel-neon.md).
- **Test discipline:** tests strictly first for the state machines (PIN, challenge), idempotency and tenant isolation in this phase. Other code may have tests written alongside.

## Checkpoints

| | Contents | Needs from the owner |
|---|---|---|
| **2A** | Import-direction lint rule (first task). Database access with no session state, proven through a transaction-mode pooler. Cron job routes. Deployed-environment guard for the fixed code | Nothing |
| **2C** | One-time-code sign-in behind `AuthProvider` with an SMS sender interface (simulated sender until credentials). PIN set, change and step-up. Sign-out | Nothing until the Africa's Talking adapter |
| **2D** | Permission map and route × role matrix. Member management behind step-up. Consent records. Rate limiting in PostgreSQL | Nothing |
| **2B** | Neon project, roles and migrations. First Vercel deployment of the API with cron jobs. Latency measurement | Neon and Vercel accounts, CLI logins |
| **2E** | Africa's Talking adapter, from its current documentation, and a real code on staging | Africa's Talking sandbox credentials |

2A, 2C and 2D are built first because they need no credentials. 2B and 2E follow as the owner completes setup.

## 1. Import-direction rule (ADR 0002 rule 3)

ESLint `no-restricted-imports`, per directory:

- `src/platform/**` imports no module.
- `ledger`, `outbox`, `audit`, `business`, `tenancy`, `consent` import only `platform` (and `audit` where they record events).
- `identity` may import `audit`, `tenancy`, `consent`.
- `payments` may import `ledger`, `outbox`, `audit`, `identity` (guards only).
- Nothing imports `payments` except the composition root (`app.module.ts`, entry points).
- Only `src/platform/database.ts` imports the generated Prisma client class; modules import types.

The Phase 1 debt (identity reading `tenancy.membership` directly) is fixed by moving that read into `TenancyService`.

## 2. Database access for Neon

- Remove the connection `options` parameter. Every transaction starts with one statement that sets `TimeZone` to UTC and, for tenant work, `app.tenant_id`, both transaction-local.
- Roles also get `ALTER ROLE … SET timezone = 'UTC'` in the bootstrap.
- **Test through a pooler:** the isolation, clock and payment-flow tests run a second time through PgBouncer in transaction mode with a pool of one server connection, so every transaction shares one backend and any leaked session state would show. Locally and in CI this uses a PgBouncer process; on Neon, `pnpm neon:verify` runs the same checks against the development branch's pooled endpoint.
- `scripts/neon-bootstrap.mjs`: creates the three roles with SQL (so none inherits `BYPASSRLS`), random passwords, grants; writes connection strings to `.env.local`; prints no secret.
- A test asserts no AORA role has `rolbypassrls` or `rolsuper`.

## 3. Deployed-environment guard

`SandboxAuthProvider` (fixed code) may be constructed only when **both** hold:

1. no Vercel system variable is present (`VERCEL`, `VERCEL_ENV`, `VERCEL_URL`), and
2. every database URL points at this machine (`localhost`, `127.0.0.1`, `::1`).

Otherwise the process refuses to start. This is derived from where the process runs and what it talks to, not from a flag that could be set wrongly. Tests cover each condition. The default authenticator is the one-time-code provider.

## 4. Data model (one migration, `…000400_phase2`)

**identity**
- `user_account` gains `pin_hash`, `pin_set_at`, `pin_failed_attempts`, `pin_locked_until`.
- `auth_challenge.purpose` gains `pin_setup`; `step_up` is removed from use.

**tenancy**
- `membership` gains `status` (`active`, `removed`); platform role may update `role` and `status`. A trigger refuses to leave a workspace without an active admin.

**consent** (new schema; brief §7.4)
- `terms_document(id, key, version, language, title, body, body_sha256, effective_from, effective_to, unique(key, version, language))` — immutable once published.
- `consent_record(id, person_id, account_id, capacity 'personal'|'business', tenant_id null, action, terms_document_id, request_id, created_at, mode)` — append-only.

**ops** (new schema; platform role only)
- `rate_limit(bucket, window_start, count, primary key (bucket, window_start))` — `bucket` is a SHA-256 of the limit name and the key, so no phone number or address is stored.
- `job_lease(name primary key, holder, expires_at)`.

**sim**
- `sim_sms(id, phone_e164, body, created_at)` — the simulated SMS sender's outbox.

## 5. State machines

**Sign-in challenge:** unchanged from Phase 1 (`issued → consumed | expired | locked`), now with a random six-digit code per challenge.

**PIN**

```text
unset ──(one-time code verified, purpose pin_setup)──▶ set
set ──(correct PIN)──▶ set, attempts = 0, session.step_up_until = now + window
set ──(wrong PIN)──▶ set, attempts + 1 ──(attempts = limit)──▶ locked until T
locked ──(T passes)──▶ set          locked ──(one-time code, pin_setup)──▶ set (new PIN)
```

- A PIN is six digits; repeated or sequential digits are refused.
- Stored as scrypt over an HMAC with a server-side pepper (`PIN_PEPPER`), with a per-account salt. Never logged, never in audit detail.
- While locked, even the correct PIN is refused.
- Setting or changing a PIN always needs a fresh one-time code, so a stolen session cannot set one.

**Membership:** `active → removed`; role changes between `admin`, `finance`, `cashier`. The last active admin cannot be removed or demoted.

## 6. Endpoints

| Method and path | Auth | Purpose |
|---|---|---|
| `POST /v1/auth/challenges` | none, rate-limited | Unchanged contract; now sends a real code |
| `POST /v1/auth/sessions` | none, rate-limited | Unchanged |
| `DELETE /v1/auth/session` | session | Sign out (revokes the session) |
| `POST /v1/auth/pin/challenges` | session, rate-limited | Send a one-time code to set or change the PIN |
| `PUT /v1/auth/pin` | session | Set or change the PIN with that code |
| `POST /v1/auth/step-up` | session, rate-limited | Confirm with the PIN |
| `GET /v1/workspace/members` | workspace; `member.read` | List members |
| `POST /v1/workspace/members` | workspace; `member.manage`; **step-up** | Add a member by phone and role |
| `PATCH /v1/workspace/members/{id}` | workspace; `member.manage`; **step-up** | Change role or remove |
| `GET /v1/ledger/balances` | workspace; `ledger.read` | The workspace's account balances |
| `GET /v1/terms/{key}` | none | Current terms document |
| `POST /v1/consents` | session | Record consent to a terms version |
| `GET /v1/internal/cron/outbox`, `/sim-webhooks`, `/reconciliation` | `CRON_SECRET` bearer | Time-bounded jobs |
| `GET /v1/internal/sandbox/sms` | `SANDBOX_SMS_INBOX_TOKEN` bearer | Read simulated codes. Exists only while the simulated sender is active |

`POST /v1/auth/step-up/challenges` from Phase 1 is removed.

### Permissions

One map from permission to roles; routes name a permission, never a role.

| Permission | admin | finance | cashier |
|---|---|---|---|
| `payment_intent.create`, `payment_intent.read` | ✓ | ✓ | ✓ |
| `ledger.read` | ✓ | ✓ | – |
| `member.read` | ✓ | ✓ | – |
| `member.manage` | ✓ | – | – |

### Rate limits (configuration, PostgreSQL-backed)

Fixed-window counters, one `INSERT … ON CONFLICT … DO UPDATE` per check, shared by every serverless instance. PostgreSQL is enough at this scale; no Redis.

| Limit | Key | Default |
|---|---|---|
| Start sign-in | phone number | 5 per 15 minutes |
| Start sign-in | client address | 30 per 15 minutes |
| Verify code | client address | 30 per 15 minutes |
| PIN step-up | account | 10 per 15 minutes (plus the PIN lockout) |
| PIN code request | account | 5 per 15 minutes |

A limit hit returns `429 too_many_attempts`. Webhook and cron routes are not rate-limited.

## 7. Cron jobs

Each route: constant-time check of the bearer secret; a time budget (default 45 s); processes everything due; safe to run twice or to miss. Reconciliation takes a `job_lease` so runs cannot overlap. `services/api/vercel.json` declares the schedules and the `fra1` region.

## 8. Tests

| File | Covers | First? |
|---|---|---|
| `test/pin.test.ts` | PIN state machine: set needs a code; lockout; correct PIN refused while locked; unlock; never stored or logged in clear | **Yes** |
| `test/otp.test.ts` | Random code per challenge; single use; simulated sender; inbox route guarded | Alongside |
| `test/deployed-guard.test.ts` | Fixed code impossible with any Vercel variable or a non-local database | **Yes** |
| `test/pooler.test.ts` | Isolation, clock and a payment flow through transaction-mode PgBouncer with one server connection; no role can bypass RLS | **Yes** |
| `test/permissions.test.ts` | Every route × every role, default deny; step-up required where declared | **Yes** |
| `test/members.test.ts` | Tenant isolation of member management; last admin protected | **Yes** |
| `test/consent.test.ts` | Record names person, capacity, action, time, terms version; append-only | Alongside |
| `test/rate-limit.test.ts` | Limits hold across concurrent requests and separate app instances; no raw key stored | **Yes** (idempotent counting) |
| `test/cron.test.ts` | Secret required; jobs idempotent under double delivery; time budget respected; lease prevents overlap | **Yes** |
| lint | Import-direction rule fails on a planted violation | — |

## 9. Exit criteria

- All of the above pass locally and in CI.
- Staging: sign in with a real one-time code, set a PIN, complete a step-up, see cron jobs run, and reconciliation clean (journey J2).
- Cold and warm latency of the deployed API measured and reported (ADR 0013).
- `security-and-tenancy.md`, `openapi.yaml`, `.env.example` and the setup guides match the code.

## 10. Not in this phase

Merchant onboarding, tariffs, any real payment rail, any web or mobile app, API keys, chain code, KELO.

## 11. Change of plan (owner rulings, 2026-10-13): Clerk and Resend

Checkpoint 2E (Africa's Talking) is replaced by **2E (Clerk)** and **2F (notifications and Resend)**. Decisions and sources: [ADR 0019](../adr/0019-clerk-integration.md), [ADR 0020](../adr/0020-notifications.md).

**What this supersedes above:** §3 (the guard now covers the sandbox authenticator and Clerk test identities), the one-time-code and SMS parts of §4 to §6, the sign-in rate limits, and the SMS inbox route. The PIN state machine in §5 stands, with "one-time code verified" replaced by "sign-in factor verified recently on the session".

**Data model** (`…000500_clerk_notifications`, expand only): `user_account` gains `clerk_user_id`, `email`, `display_name`, `phone_verified_at`, `status`, `closed_at`, `provider_updated_at`, and `phone_e164` becomes optional; new `identity.step_up` (bound to the provider session id) and `identity.provider_event`; new schema `notifications` (`notification`, `delivery_event`); `sim.sim_email`. `auth_challenge`, `session` and `sim_sms` are retired and dropped in a later release.

**Endpoints now:** `GET /v1/me`, `PUT /v1/auth/pin`, `POST /v1/auth/step-up`, `GET /v1/notifications`, `POST /v1/webhooks/clerk`, `POST /v1/webhooks/resend`, plus those of §6 that are not sign-in. Removed: `/v1/auth/challenges`, `/v1/auth/sessions`, `/v1/auth/session`, `/v1/auth/pin/challenges`, `/v1/internal/sandbox/sms`.

**Tests added, written before the code:** `clerk-provider.test.ts` (the real Clerk verifier against a local key pair; live keys refused), `identity-sync.test.ts` (just-in-time provisioning under concurrency, webhook idempotency and ordering, phone conflicts, deletion keeps financial records, Clerk test identities refused when deployed), `pin.test.ts` (rewritten for sessions and factor age), `notifications.test.ts` (once-only sending, masking, sandbox labelling, delivery status, sign-in codes stored nowhere, the Resend adapter against a local server).

**Exit criteria added:** journey J2 and the payment path pass on staging **through Clerk, with a real sign-in email delivered by Resend**; the assumed field names of Clerk's email event are confirmed; test mode is off on the staging instance.

**Deployment order when credentials arrive:** set the Clerk and Resend variables in Vercel; run the staging migration; merge the branch (which deploys); create the two webhooks; confirm a sign-in email arrives while Clerk still delivers it; only then turn "Delivered by Clerk" off.
