# Neon Setup

How to create the AORA databases on Neon. Follow the steps in order. **Everything here is sandbox.** Background and sources: [ADR 0013](../adr/0013-hosting-vercel-neon.md).

- Commands marked **(to verify)** were not confirmed against Neon's documentation; check them with `neon <command> --help` before running.
- Steps marked **[you]** need you; steps marked **[Claude]** can be run for you once the CLI is logged in.
- Never paste a connection string or password into the chat. They go into `.env.local`, which is git-ignored.

## What you end up with

| Thing | Value |
|---|---|
| Neon project | `aora`, region `aws-eu-central-1` (Frankfurt) |
| Branch `main` | AORA **staging** |
| Branch `development` | Development |
| Database | one per branch, same name |
| Roles | `aora_owner` (migrations), `aora_app` (tenant requests), `aora_platform` (workers, operators). All three are created **with SQL**, so none can bypass row-level security |

## Steps

1. **[you] Create a Neon account** at https://neon.com. Creating a project on the Free plan is not billable; a paid plan is. Tell Claude which plan you chose.

2. **[you] Install the Neon CLI.** **(to verify)**

   ```bash
   npm install -g neonctl
   ```

3. **[you] Log in.** This opens a browser window; credentials are saved to `~/.config/neon/credentials.json`.

   ```bash
   neon login
   ```

4. **[Claude, after asking] Create the project** in Frankfurt. **(flags to verify)**

   ```bash
   neon projects create --name aora --region-id aws-eu-central-1
   ```

5. **[Claude] Create the `development` branch** from `main`. **(to verify)**

   ```bash
   neon branches create --name development
   ```

6. **[you] Put the admin connection strings in `.env.local`.** In the Neon Console open the project, choose **Connect**, select the **default role** and the branch, turn **Connection pooling off** (this gives the direct string), and copy it. Do this for both branches and add:

   ```text
   NEON_ADMIN_URL_STAGING=<direct connection string, branch main, default role>
   NEON_ADMIN_URL_DEVELOPMENT=<direct connection string, branch development, default role>
   ```

   These are used only by the bootstrap script in the next step and are never deployed.

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
| `NEON_ADMIN_URL_STAGING`, `NEON_ADMIN_URL_DEVELOPMENT` | you (step 6) | Bootstrap only |
| `STAGING_DATABASE_URL_OWNER`, `DEVELOPMENT_DATABASE_URL_OWNER` | script (step 7) | Migrations, direct connection |
| `STAGING_DATABASE_URL_APP`, `DEVELOPMENT_DATABASE_URL_APP` | script | Runtime, pooled |
| `STAGING_DATABASE_URL_PLATFORM`, `DEVELOPMENT_DATABASE_URL_PLATFORM` | script | Runtime, pooled |

## Resetting

Staging is reset by the runbook written for the MVP gate, not by hand. Deleting a branch or project is destructive: Claude asks first.
