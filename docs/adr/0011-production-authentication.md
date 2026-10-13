# ADR 0011 — Authentication for production

- **Status:** Proposed — **Decision pending owner input**
- **Date:** 2026-10-13
- **Related:** brief §2.1, §7.2; CLAUDE.md rules 9, 12; open question [D-6](../architecture/open-questions.md#d-6)

No vendor is recommended. Provider capabilities, limits and prices are **to verify** against each provider's documentation before any choice.

## Context

Owner ruling (2026-10-13) fixes the sandbox and MVP behaviour:

- Phase 1: a sandbox authenticator (fixed test users, simulated code).
- MVP: phone number plus a one-time code sent through an SMS provider's sandbox, and a transaction PIN for step-up.
- Everything sits behind an `AuthProvider` interface so the production choice stays open.

What production uses is still open. A phone number is an identifier, not sufficient authentication (brief §2.1): SIM swap, device change and recovery need stronger safeguards than an SMS code.

## What is decided regardless of option

- AORA's database owns the **identity domain**: person, account, business, membership, roles, sessions' link to an account. Only **credential verification** is behind `AuthProvider`.
- Authorization (roles, tenant scope, step-up policy) is always AORA's own server-side code.
- PINs and any AORA-held secret are stored only as slow salted hashes; one-time codes only as hashes with expiry and attempt limits.
- Session tokens are random, stored hashed, revocable, and bound to a device record.
- Step-up is a policy on the action, not on the provider: the action names the assurance it needs; the provider supplies it.

## Options

| | A. Self-built | B. Self-hosted identity server | C. Managed identity provider |
|---|---|---|---|
| What it is | AORA implements code delivery, PIN, passkeys, device binding and recovery itself | An open-source identity server run in AORA's own infrastructure | A hosted identity service |
| Who stores credentials | AORA | AORA (inside the identity server) | The provider |
| Fit with phone + code + PIN | Exact; AORA defines the flow | Usually needs custom flows or extensions (to verify per product) | Depends on the provider's phone and custom-factor support (to verify) |
| Control over SIM-swap and recovery policy | Full | High | Limited to what the provider exposes |
| Security burden on AORA | Highest: AORA owns every flaw in the flows | Medium: patching and operating a security-critical server | Lowest for credential handling; highest dependency |
| Data residency | Wherever AORA hosts | Wherever AORA hosts | Wherever the provider hosts (to verify against D-9) |
| Cost shape | Engineering time, SMS fees | Engineering and operations time, SMS fees | Per-user or per-authentication fees plus SMS (to verify) |
| Lock-in | None | Low to medium | Medium to high; mitigated by `AuthProvider` |
| Outage impact | AORA's own | AORA's own | Provider outage stops sign-in |

Hybrid is possible: a managed or self-hosted service for primary sign-in, with the transaction PIN and step-up policy kept in AORA.

## Engineering view (not a decision)

- The MVP flow (phone, code, PIN) is effectively option A at small scale. It is acceptable for a sandbox. Taking it to production means AORA owns account recovery and SIM-swap defence, which is where consumer fintech accounts are usually lost.
- Whatever is chosen, add a factor that does not depend on the phone number (passkey or device-bound key) before live money.
- The transaction PIN should stay in AORA in every option: it authorises AORA's own financial actions.

## What is needed from the owner

1. Option A, B, C or a hybrid.
2. Hosting constraints from D-9.
3. Whether an SMS code remains an accepted primary factor at launch.

## Consequences of leaving this open

- Nothing in the sandbox MVP is blocked.
- Production readiness (Phase 13) is blocked.
