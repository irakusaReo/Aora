# Vercel Setup

How to deploy AORA to Vercel. Follow the steps in order. Background and sources: [ADR 0013](../adr/0013-hosting-vercel-neon.md).

> **Vercel's "Production" environment is AORA STAGING.** Nothing deployed here is live. Every environment runs with `AORA_MODE=sandbox`, and the code refuses any other value.

- Commands marked **(to verify)** were not confirmed against Vercel's documentation; check them with `vercel <command> --help` before running.
- **[you]** steps need you. **[Claude]** steps can be run for you once the CLI is logged in. Claude asks before anything billable, anything that changes Production settings, and anything that deletes.
- Never paste a secret into the chat.

## What you end up with

| Vercel project | Root directory | When |
|---|---|---|
| `aora-api` | `services/api` | Phase 2 |
| `aora-kony-web` | `apps/kony-web` | Phase 3 |
| `aora-internal-ops` | `apps/internal-ops` | Phase 3 |
| `aora-kelo-web` | `apps/kelo-web` | Phase 5 |
| `aora-chiwo-web` | `apps/chiwo-web` | Phase 8 |

All in region `fra1`, next to the Neon database.

## Steps

1. **[you] Create a Vercel account and team** at https://vercel.com, signed in with the GitHub account that owns `irakusaReo/Aora`.

2. **[you] Choose the plan.** Decided 2026-10-13: **Hobby (free)** for now. Hobby allows each cron job once per day, so background work on staging is delayed until the daily run; see ADR 0013. Pro (billable) restores per-minute jobs and is needed before real payment callbacks in Phase 3, unless another trigger is approved.

3. **[you] Install the CLI** (version 48.4.0 or newer is required for NestJS).

   ```bash
   npm install -g vercel
   ```

4. **[you] Log in.**

   ```bash
   vercel login
   ```

5. **[you] Push the repository to GitHub** if it is not already there. Vercel deploys from Git.

6. **[Claude, after asking] Create and link the API project** from the repository root. Choose the team, create a project named `aora-api`, and set its root directory to `services/api`.

   ```bash
   vercel link --repo
   ```

7. **[you] Check three project settings** in the dashboard for `aora-api`:
   - **Settings → Functions → Function Regions:** only `fra1` (also set in `services/api/vercel.json`).
   - **Settings → Deployment Protection:** **Standard Protection** with Vercel Authentication. This protects previews and leaves the Production (staging) domain reachable, which provider callbacks need.
   - **Settings → Build and Deployment → Root Directory:** `services/api`.

8. **[Claude] Set the environment variables** below. Values are read from `.env.local` and sent to Vercel without being printed. Secrets are added as **sensitive**. **(exact `vercel env` syntax to verify)**

9. **[you] Connect Neon to Vercel for preview databases.** In the Neon Console: **Integrations → Vercel** (the Neon-managed integration), select the `aora-api` project, and enable a branch per preview deployment. Do **not** let it overwrite the Production variables set in step 8. The variable names it injects are to verify at this step.

10. **[Claude, after asking] Deploy to staging.** This deploys to the Vercel Production target, which is AORA staging.

    ```bash
    vercel deploy --prod
    ```

11. **[Claude] Verify.** Health check, cron jobs listed and authorised, a sign-in on the real URL, cold and warm latency measured from this machine. Reports pass or fail and the timings.

12. **[you] Set provider callback URLs** when each provider is integrated: always the staging domain, `https://<staging-domain>/v1/webhooks/<rail>`. Never a preview URL.

## Environment variables for `aora-api`

"Production" below means the Vercel target, which is AORA staging.

| Variable | Production (staging) | Preview | Development | Sensitive | Value |
|---|---|---|---|---|---|
| `AORA_MODE` | ✓ | ✓ | ✓ | no | `sandbox` |
| `DATABASE_URL_APP` | ✓ | from Neon integration | ✓ | yes | Pooled string, role `aora_app` |
| `DATABASE_URL_PLATFORM` | ✓ | from Neon integration | ✓ | yes | Pooled string, role `aora_platform` |
| `CRON_SECRET` | ✓ | ✓ | – | yes | Random, at least 32 characters. Vercel sends it to cron routes |
| `SANDBOX_SIM_WEBHOOK_SECRET` | ✓ | ✓ | ✓ | yes | Random. Signs the simulator's webhooks |
| `PUBLIC_API_URL` | ✓ | – | ✓ | no | The staging domain, with `https://` |
| Clerk variables | ✓ | – | ✓ | see [clerk-setup.md](clerk-setup.md) | Development-instance keys only |
| Resend variables | ✓ | – | ✓ | see [resend-setup.md](resend-setup.md) | |

Deliberately **not** on Vercel:

- `DATABASE_URL_OWNER`. Migrations run from a trusted machine or CI through the direct connection; the deployed API can never change the schema.
- Any signer key. The testnet key for the local sandbox signer stays in `.env.local` on the owner's machine (open question M-1).

The fixed sign-in code and the sandbox authenticator cannot start on Vercel whatever the variables say; see `security-and-tenancy.md`.

## Cron jobs

Defined in `services/api/vercel.json`, so they are reviewed like code. They run only on the Production (staging) deployment.

| Path | Schedule on Hobby (current) | Schedule on Pro |
|---|---|---|
| `/v1/internal/cron/outbox` | daily, 03:00 UTC | every minute |
| `/v1/internal/cron/sim-webhooks` | daily, 03:05 UTC | every minute |
| `/v1/internal/cron/reconciliation` | daily, 03:30 UTC | every 15 minutes |

On Hobby a job may start up to 59 minutes after its scheduled time. Any job can also be run by hand with the cron secret, which is how staging is exercised until the plan changes.

## Status (2026-10-13)

- Project `aora-api` (`prj_vyArztPBSRrPO7E6nEE7OzcYdVei`) exists in the team "Andre's projects" (Hobby), root directory `services/api`, framework NestJS, Node 24, function region `fra1`.
- **Staging URL: https://aora-api.vercel.app** (Vercel Production target). It is sandbox, not live.
- Production variables set: `AORA_MODE`, `DATABASE_URL_APP`, `DATABASE_URL_PLATFORM`, `CRON_SECRET`, `PIN_PEPPER`, `SANDBOX_SIM_WEBHOOK_SECRET`, `SANDBOX_SMS_INBOX_TOKEN`, `PUBLIC_API_URL`. The cron secret and inbox token are also in the owner's `.env.local` as `STAGING_CRON_SECRET` and `STAGING_SMS_INBOX_TOKEN`, so staging can be exercised by hand.
- Deployed with `vercel deploy --prod` from the repository root. **Git is not yet connected**, so pushes do not deploy.
- Journey J2 and the Phase 1 payment path pass against the staging URL.

### What was actually run (verified with the CLI's `--help`, version 63.1.2)

```bash
vercel api /v10/projects -X POST --scope <team> -f name=aora-api -f rootDirectory=services/api -f framework=nestjs
```

```bash
vercel link --yes --project aora-api --scope <team>
```

```bash
printf '%s' "$VALUE" | vercel env add NAME production --sensitive --force --scope <team>
```

```bash
vercel deploy --prod --yes --scope <team>
```

Notes: values are piped on standard input so they never appear in a command line; `vercel link` adds a `VERCEL_OIDC_TOKEN` to `.env.local` and extra lines to `.gitignore`, which should be removed; `.vercelignore` keeps local state out of the upload.

### Not done yet

- **Deployment Protection: checked on 2026-10-13 with the CLI.** The project is on Standard Protection (`all_except_custom_domains`): previews are protected, the staging domain is reachable for callbacks.
- **GitHub is connected** (2026-10-13): pushes to `main` deploy to the Production target (staging); pull requests get protected previews.
- **[you] Add a Deployment Check** so a deployment waits for CI: project Settings → Deployment Checks → Add Checks → GitHub → select the job "Lint, typecheck and test" (and "Migrate staging" once it exists). Not verified on the Hobby plan.
- Preview deployments have no database by decision (ADR 0013); step 9 (the Neon integration) is not adopted.
- Preview and Development environment variables.
