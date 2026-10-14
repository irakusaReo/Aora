# ADR 0023 — Developer API: keys and signed webhooks

- **Status:** Accepted for the sandbox (Phase 3 scope approved by the owner, 2026-10-13)
- **Date:** 2026-10-14
- **Related:** lessons §6; open question M-2 (secrets stored as hashes; one platform signing key); CLAUDE.md rules 9 and 12; journey J7

## Context

Merchants' own systems need to call `/v1` and to hear about results without polling. Rule 9 forbids usable secrets in the database; rule 12 requires a PIN step-up for sensitive actions, which a program cannot perform.

## Decision

**API keys**

- Format `aora_sk_sandbox_` followed by 40 random characters. Shown once, in the response that creates it, and stored only as a SHA-256 hash plus a short prefix for recognition. A key with this much randomness needs no slow hash or pepper. A revoked key stays revoked; nothing about a key can change.
- Created and revoked by a workspace admin with a PIN step-up, and audited.
- A key authenticates as its workspace, with a fixed **scope mapped onto an existing role**: `collect` → the cashier role, `full` → the finance role. Permissions stay in one table, and the route × role matrix covers keys too.
- **A key can never pass a step-up**, because it has no PIN, so it can never pay out, refund, confirm a recipient, invite, or create keys or webhooks. It is accepted only on workspace routes; identity routes (`/v1/me`, PIN, onboarding) refuse it.
- Records created by a key name the key's creator as their creator (every record needs a person), and the audit event names the key (`api_key_id`).
- **Known limitation:** a key keeps working if its creator leaves the workspace; an admin must revoke it. A `collect` key sees only collections with no branch, as a branchless cashier would.

**Webhooks**

- Events: `payment_intent.succeeded|failed`, `payout.succeeded|failed`, `refund.succeeded|failed`. Written in the same transaction as the change they announce, once per subject and type, with the body stored exactly as sent.
- **Signature:** Ed25519, by one platform key (`WEBHOOK_SIGNING_PRIVATE_KEY`, in the secret store, required on deployed environments). Headers: `Aora-Event-Id`, and `Aora-Signature: t=<unix seconds>,v1=<base64 signature of "t.body">`. The public key is served at `GET /v1/webhook-signing-key`. No per-merchant secret exists, so none is stored.
- **Delivery:** at least once, from the outbox; 10-second timeout; redirects are not followed; every attempt is logged; retried with backoff up to six attempts, then `dead`. **Replay** creates a new delivery with the same event id and body, so a receiver that deduplicates on the id sees no second effect.
- **Addresses:** on a deployed environment, HTTPS only, no credentials in the URL, never a private, loopback, link-local or unique-local address. The hostname is checked again by DNS at each delivery, so a name that later points inward is refused. Registering an endpoint needs an admin and a PIN step-up.

## Consequences

- Keys and webhooks add no stored secret beyond a hash, and one key pair in the secret store.
- Rotating the signing key means receivers re-fetch the public key; a `key_id` is published to make that visible. Overlapping keys are not supported yet.
- Rate limits per key are not built in Phase 3.
