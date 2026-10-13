# AORA — Progress

Read this with `CLAUDE.md` to resume work in a fresh session.

- **Goal:** sandbox MVP in staging ([mvp-scope.md](product/mvp-scope.md)).
- **Current phase:** Phase 1 ([plan](plans/phase-1.md)).
- **Last updated:** 2026-10-13

## Done

- Phase 0 approved and committed: brief cleaned, open questions, ADRs 0001–0010, delivery plan, scaffold.
- Owner rulings of 2026-10-13 applied: ADRs 0001–0008 and 0012 accepted; ADR 0011 written (pending); C-4 resolved; CLAUDE.md working agreement and rule 10 updated; CI actions pinned to commit SHAs; MVP scope written.

## In progress

- Phase 1, checkpoint 1A.

## Next

1. Checkpoint 1A, then 1B, then 1C (see the plan).
2. Phase 1 architecture documents and end-of-phase report.
3. Phase 2 credential request (SMS provider sandbox).

## Blocked

- **Push to GitHub.** The stored GitHub token lacks the `workflow` scope, so GitHub rejects any push that contains `.github/workflows/ci.yml`. Commits are local until the owner runs `gh auth refresh -h github.com -s workflow` and then `git push origin main`. CI has therefore never run (open question X-12).

## How to run

Requires Node 24 (`nvm use`) and pnpm via corepack. See the Commands section of `CLAUDE.md`.

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

See the index in [open-questions.md](architecture/open-questions.md). Nothing open blocks Phase 1.
