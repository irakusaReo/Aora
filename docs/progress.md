# AORA — Progress

Read this with `CLAUDE.md` to resume work in a fresh session.

- **Goal:** sandbox MVP in staging ([mvp-scope.md](product/mvp-scope.md)).
- **Current phase:** Phase 1 is **built and awaiting owner approval** ([plan](plans/phase-1.md)). Do not start Phase 2 before approval.
- **Last updated:** 2026-10-13

## Done

- **Phase 0** (approved): brief cleaned, open questions, ADRs 0001–0010, delivery plan, scaffold.
- **Owner rulings of 2026-10-13 applied:** ADRs 0001–0008 and 0012 accepted; ADR 0011 written (pending); C-4 resolved; working agreement and rule 10 updated in CLAUDE.md; CI actions pinned to commit SHAs; MVP scope written.
- **Phase 1** (built, not yet approved):
  - 1A — API package, three database roles with row-level security, sandbox authenticator behind `AuthProvider`, sessions, step-up guard, roles, audit trail.
  - 1B — double-entry ledger with database-enforced invariants, idempotent posting, reversals; transactional outbox with retry and dead state.
  - 1C — payment intents with an explicit state machine, AORA simulator provider, signed webhook intake, reconciliation with an exception queue, operator endpoints, OpenAPI contract.
  - Documents: `system-overview`, `domain-boundaries`, `financial-ledger`, `security-and-tenancy`, `docs/api/openapi.yaml`.
  - 110 tests pass locally. The built API and worker were run and a payment was taken through to a clean reconciliation.

## Next

1. Owner approves Phase 1, and pushes (see Blocked).
2. Owner answers the Phase 2 credential request (SMS provider sandbox).
3. Write `docs/plans/phase-2.md`. First task: the import-boundary lint rule (ADR 0002 rule 3).
4. Phase 2 scope: phone and one-time-code sign-in through the SMS sandbox, transaction PIN step-up, role permissions for `finance`, consent records, rate limiting, ledger completion (statements, balance rebuild job), sign-out.

## Blocked

- **Push to GitHub and CI.** The stored GitHub token lacks the `workflow` scope, so GitHub rejects any push that contains `.github/workflows/ci.yml`. All commits are local. The owner needs to run `gh auth refresh -h github.com -s workflow` and then `git push origin main`. **CI has never run**; the workflow (including its PostgreSQL service and schema drift check) is unproven until then.

## Known gaps carried forward

- Authentication and the payment provider are simulated.
- No rate limiting.
- `StepUpGuard` exists and is tested but protects no real endpoint yet.
- Import-direction lint rule not in place.
- GitHub Actions' `postgres:16` service image is pinned by tag, not digest.
- Local development needs Node 24 (`nvm install`); the machine default is Node 20.

## How to run

See the Commands section of `CLAUDE.md` and the README. Short version: `pnpm db:start && pnpm db:migrate && pnpm test`.

## Credential request format

When a credential, account or external value is needed, stop and ask in exactly this format:

```text
CREDENTIAL REQUEST
- What: <name of the credential or value>
- Why: <the feature and phase that need it>
- Where to get it: <official portal or doc, with steps; mark anything unsure as "to verify">
- Environment: sandbox or test only, never a live or production key
- Variable names: <EXACT_ENV_VAR_NAMES>, also added to .env.example as placeholders
- How to provide it: I will add the values to .env.local myself and reply "done". Never ask me to paste a secret into the chat.
```

Rules:

- Batch requests: at the start of each phase, list every credential that phase needs in one request.
- After "done": check each variable is present and well formed without printing, logging or committing its value; run a sandbox connectivity check; report only pass or fail.
- If a value looks like a live or production key, refuse to use it and say so.
- If a secret is pasted into the chat, write it nowhere and ask for it to be rotated.
- While waiting, continue with work that does not need the credential, using the simulator.

Expected requests: SMS provider sandbox (Phase 2); Daraja sandbox credentials and test shortcode, public HTTPS tunnel, staging cloud account (Phase 3A); Base Sepolia RPC URL and a funded testnet signer key (Phase 5).

## Decisions waiting on the owner

See the index in [open-questions.md](architecture/open-questions.md). For Phase 2: M-2 (how API keys and webhook secrets are stored) is worth settling early though it bites in 3B; D-8 (KYC provider and tier limits) and M-4 (funds-flow assumption) are needed for 3A.
