# Neon Setup

How to create the AORA databases on Neon. Follow the steps in order. **Everything here is sandbox.** Background and sources: [ADR 0013](../adr/0013-hosting-vercel-neon.md).

- The CLI commands below were checked against `neon --help` (neonctl 8.4.2) on 2026-10-13 and were run for the `aora` project that day.
- **`neon projects create` and `neon connection-string` print a full connection string, password included.** Never run them where the output is shared or logged; redirect the output into `.env.local` instead (step 6 shows how).
- Steps marked **[you]** need you; steps marked **[Claude]** can be run for you once the CLI is logged in.
- Never paste a connection string or password into the chat. They go into `.env.local`, which is git-ignored.

## What you end up with

| Thing | Value |
|---|---|
| Neon project | `aora` (`little-block-25898321`), region `aws-eu-central-1` (Frankfurt), PostgreSQL 16 to match tests and CI |
| Branch `main` (the default) | AORA **staging** |
| Branch `development` | Development |
| Database | one per branch, same name |
| Roles | `aora_owner` (migrations), `aora_app` (tenant requests), `aora_platform` (workers, operators). All three are created **with SQL**, so none can bypass row-level security |

## Steps

1. **[you] Create a Neon account** at https://neon.com. Creating a project on the Free plan is not billable; a paid plan is. Tell Claude which plan you chose.

2. **[you] Install the Neon CLI** (package `neonctl`; it provides the `neon` command).

   ```bash
   npm install -g neonctl
   ```

3. **[you] Log in.** This opens a browser window; credentials are saved to `~/.config/neon/credentials.json`. The CLI waits only 60 seconds, so sign in to the Neon Console in your browser first.

   ```bash
   neon login
   ```

4. **[Claude, after asking] Create the project** in Frankfurt. The output includes the owner's password: redirect it, do not display it.

   ```bash
   neon projects create --name aora --region-id aws-eu-central-1 --pg-version 16 --org-id <org-id> -o json > /dev/null
   ```

5. **[Claude] Create the `development` branch** from `main`.

   ```bash
   neon branches create --project-id <project-id> --name development --parent main -o json > /dev/null
   ```

6. **[Claude] Put the admin connection strings in `.env.local`** without displaying them. For each branch, the direct (not pooled) string of the default role is fetched with `neon connection-string <branch> --project-id <project-id> --role-name neondb_owner --database-name neondb` and written straight to the file as `NEON_ADMIN_URL_STAGING` and `NEON_ADMIN_URL_DEVELOPMENT`. These are used only by the bootstrap script and are never deployed.

   If the default role's password is ever exposed, reset it in the Console (branch → Roles & Databases → reset password) and repeat this step. The CLI has no reset command.

7. **[Claude] Create the three roles.** The script connects with the admin string, creates `aora_owner`, `aora_app` and `aora_platform` with SQL, gives each a random password it generates, grants `aora_owner` the right to create schemas, and writes the six resulting connection strings (direct for the owner, pooled for the other two) into `.env.local`. It prints no secret.

   ```bash
   pnpm neon:bootstrap staging
   ```

   ```bash
   pnpm neon:bootstrap development
   ```

8. **[Claude] Run the migrations** on each branch, through the **direct** owner connection.

   ```bash
   pnpm db:migrate:staging
   ```

   ```bash
   pnpm db:migrate:development
   ```

9. **[Claude] Verify.** Runs the row-level-security and ledger checks against the development branch **through the pooled connection**, and reports pass or fail only.

   ```bash
   pnpm neon:verify development
   ```

10. **[you, later] Connect Neon to Vercel** for preview branches. This is step 9 of [vercel-setup.md](vercel-setup.md).

## Variables this guide adds to `.env.local`

| Variable | Set by | Used for |
|---|---|---|
| `NEON_ADMIN_URL_STAGING`, `NEON_ADMIN_URL_DEVELOPMENT` | Claude (step 6) | Bootstrap only |
| `STAGING_DATABASE_URL_OWNER`, `DEVELOPMENT_DATABASE_URL_OWNER` | script (step 7) | Migrations, direct connection |
| `STAGING_DATABASE_URL_APP`, `DEVELOPMENT_DATABASE_URL_APP` | script | Runtime, pooled |
| `STAGING_DATABASE_URL_PLATFORM`, `DEVELOPMENT_DATABASE_URL_PLATFORM` | script | Runtime, pooled |

## Resetting

Staging is reset by the runbook written for the MVP gate, not by hand. Deleting a branch or project is destructive: Claude asks first.

## Status (2026-10-13)

Steps 1 to 9 are complete for both branches: roles created with SQL, four migrations applied through the direct connection, and `pnpm neon:verify` passes through the pooler on `main` and `development`. The development branch holds seeded sandbox data; staging is empty until the first deployment.

An older, empty project named `Aora` (`lingering-grass-59855278`, Ohio, PostgreSQL 18) also exists in the organisation. It is unused. Deleting it is the owner's decision.
