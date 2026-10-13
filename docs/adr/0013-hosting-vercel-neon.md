# ADR 0013 — Hosting on Vercel and Neon

- **Status:** Accepted (owner decision, 2026-10-13). Platform facts verified against official documentation on 2026-10-13; sources are listed at the end and cited as [V1]…[N4].
- **Related:** ADR 0001, 0002, 0008; open questions D-9, M-1; `docs/operations/vercel-setup.md`, `docs/operations/neon-setup.md`

Nothing in this ADR comes from memory. Where the documentation did not answer a question, the text says "not verified".

## Decision

### Environments

| AORA name | Vercel target | Neon branch | Mode |
|---|---|---|---|
| Staging | **Production** | `main` | sandbox |
| Preview | Preview | one branch per preview (see below) | sandbox |
| Development | Development (`vercel dev`) or local | `development`, or local PostgreSQL | sandbox |

**Vercel's "Production" target is AORA staging. Nothing on Vercel is live.** Every environment sets `AORA_MODE=sandbox`, and the code accepts no other value.

### Vercel

- **One Vercel project per deployable**, each with its Root Directory inside the monorepo [V7]: `services/api`, and later `apps/kony-web`, `apps/chiwo-web`, `apps/kelo-web`, `apps/internal-ops`. Projects are linked from the repository root with `vercel link --repo` [V7]. Vercel skips builds for workspace projects a commit does not affect, provided each package has a unique name and declares its workspace dependencies [V7]. The number of projects per repository is limited by plan; the limit was **not verified** and must be checked before the fifth project is created.
- **The API runs NestJS on Vercel Functions.** Vercel supports NestJS with zero configuration; the application "becomes a single Vercel Function and uses Fluid compute by default", and the entrypoint must be one of a fixed list of file names, which includes `src/main.ts` [V1]. All function limits apply, including a 250 MB bundle [V1].
- **Function limits** (Node.js, Fluid compute) [V2]: maximum duration 300 s on Hobby; 300 s default and 800 s maximum on Pro and Enterprise. Memory 2 GB / 1 vCPU default. Request and response bodies are limited to **4.5 MB**. File descriptors: 1,024 shared across concurrent executions.
- **Cold starts:** the documentation says Fluid compute gives "automatic cold start reduction" [V1] and gives no figures. Cold-start latency for this application is therefore **not verified** and is measured in Phase 2 (see Consequences).
- **Region:** functions run in one region, `iad1` by default; it is set with `"regions"` in `vercel.json` [V6]. AORA uses **`fra1`** (see Region below).
- **Background work is Vercel Cron** calling authenticated API routes. Limits [V3]: 100 cron jobs per project on every plan; **Hobby runs a job at most once per day, with ±59 minutes precision; Pro and Enterprise run once per minute, with per-minute precision**. Behaviour [V4]: Vercel sends `Authorization: Bearer <CRON_SECRET>` when a `CRON_SECRET` environment variable exists; duration limits are those of functions; **failed invocations are not retried**; delivery is best effort, so a run can be missed or delivered twice; a slow job can overlap the next one; cron invocations do not follow redirects.
- **Deployment protection** [V5]: with Standard Protection, everything is protected **except production domains**. Provider callbacks therefore reach staging without any exemption. Preview deployments are protected; where a preview must receive a callback, use Protection Bypass for Automation, which is available on all plans and accepts the secret as a query parameter for webhook senders that cannot set headers [V8].

### Neon

- **Region `aws-eu-central-1` (Frankfurt).** Neon lists eight AWS regions and none in Africa or the Middle East [N1].
- **Pooled connection string at runtime, direct connection string for migrations.** Neon's pooler is PgBouncer in transaction mode; session `SET`, `LISTEN/NOTIFY`, SQL-level `PREPARE` and session-level advisory locks are not supported through it, and Neon says to use a direct connection for schema migrations [N2]. The pooled host adds `-pooler` to the endpoint ID [N2].
- **Tenant context is transaction-local.** `Database.withTenant` already calls `set_config('app.tenant_id', $1, true)` as the first statement of a transaction, which is the transaction-scoped form. Neon's page does not mention `SET LOCAL` explicitly [N2], so this is **proven by a test that runs through a transaction-mode pooler**, not assumed.
- **No session state at all.** The session time zone was set with a connection `options` parameter in Phase 1; that is session state and is removed. Time zone is now set inside each transaction and on the roles.
- **Roles.** Roles created through the Neon Console, CLI or API join `neon_superuser`, which has `BYPASSRLS`; roles created with SQL do not, and get only basic privileges [N3]. Therefore **`aora_owner`, `aora_app` and `aora_platform` are created with SQL** by a bootstrap script run once as the project's default role. No AORA role can bypass row-level security. A true superuser is not available on Neon [N3]; nothing in the migrations needs one (the test suite uses a superuser only for assertions).
- **Branches.** `main` serves staging; `development` serves development. Both managed Vercel integrations support a Neon branch per preview deployment [N4].

### Region

Kenya has no Vercel or Neon region. Vercel has Cape Town (`cpt1`) [V9]; Neon does not [N1]. Functions must sit next to the database [V6][V9], so the choice is the Neon region closest to Kenya that Vercel also has: **Frankfurt** (`aws-eu-central-1` and `fra1`). Singapore is the alternative and is farther. Users in Kenya reach it through Vercel's network; the latency is measured in Phase 2.

### Worker model

The Phase 1 worker loop becomes cron-triggered, authenticated, idempotent, time-bounded routes:

| Job | Schedule | Notes |
|---|---|---|
| Outbox drain | every minute | Claims with `FOR UPDATE SKIP LOCKED`, so overlapping runs are safe. Stops before its time budget ends |
| Simulator webhook delivery | every minute | Sandbox only |
| Reconciliation | every 15 minutes | Takes a database lease so two runs cannot overlap |
| Base transaction monitoring | every minute, from the chain phase | |
| Repayment reminders | hourly, from the KELO credit phase | |

Each route checks the `CRON_SECRET` bearer value in constant time. Because Vercel neither retries nor guarantees delivery [V4], every job processes "everything due", not "what this tick was for".

The API also drains the outbox opportunistically right after a request commits, so a payment does not wait up to a minute for the next tick. This relies on Fluid compute's background processing [V1]; the exact API is confirmed when it is implemented.

## Decisions of 2026-10-13 (third set)

### Deployments from GitHub

- The repository is connected to the `aora-api` project. A push to `main` deploys to Vercel's Production target (AORA staging); a pull request gets a preview, which Standard Protection keeps behind Vercel Authentication.
- **Holding a deployment until CI passes.** Vercel's Deployment Checks can import GitHub Actions results and hold a production deployment until the required checks pass before assigning it to the production domains [V10]. The required check is the CI job "Lint, typecheck and test", and once the migration job exists, that too. It is added in the project's Deployment Checks settings (a dashboard step for the owner; whether it is available on the Hobby plan is not verified). Until it is configured, what protects staging is narrower: a build that fails is never promoted, but a build that compiles and misbehaves would be.
- **Migrations never run from the Vercel build.** The deployed API does not hold the owner connection string. Migrations run in GitHub Actions, on `main` only, after tests pass, through the **direct** connection string held as a GitHub Actions secret, and can also be run by hand (`pnpm db:migrate:staging`).
- **Migrations are backward-compatible: expand, then contract.** A migration may add (tables, nullable columns, indexes) in the same release as the code that starts using it. Anything that removes or tightens (dropping a column, adding `NOT NULL`, renaming) ships in a later release, after no deployed code depends on the old shape. This is because the new schema is live before, and briefly alongside, the old code.

### Preview databases: none, for now

Pull-request previews of the API get **no database**. A Neon branch is a copy-on-write clone of its parent's data [N6], so a preview branch could inherit staging's schema, roles and data. But the bar set by the owner is not met:

1. The Neon integration provisions a connection for the project's default role, which is a member of `neon_superuser` and bypasses row-level security [N3]. AORA's API needs two specific roles' connection strings (`aora_app`, `aora_platform`), which the integration does not produce. How role passwords carry over to a branch is not stated in Neon's documentation [N6].
2. A preview would not have the pull request's own migrations, because migrations are not allowed to run in the Vercel build.
3. A clone of staging carries staging's personal data into every preview.

So previews have no `DATABASE_URL_*` variables and the API refuses to start there. **A preview can never fall back to the staging database**, because those variables exist only on the Production target. Meeting the bar later needs a GitHub Actions job per pull request that creates a branch from a seeded template, applies migrations, and sets the preview's variables; that is worth building when preview testing of the API is actually needed (probably with the web apps in Phase 3).

### Background jobs: request-triggered draining plus a free scheduled backstop

Targets: outbox events within about a minute in normal operation; reconciliation at least hourly; reminders on time.

| Option | Meets targets | Cost |
|---|---|---|
| Vercel Pro cron (per minute) | Yes | **$20 per month**, including one seat and $20 of usage credit [V11] |
| Drain the outbox after each request | Events caused by a request: yes, within seconds. Delayed events (status inquiries, reminders): no, nothing wakes them | Free |
| External scheduler calling the cron routes | Depends on its frequency | GitHub Actions, already in use: free for this repository's usage, at most every 5 minutes and not punctual |
| **Draining after requests, plus a GitHub Actions schedule** | **Yes for the first two targets; reminders within about 5 to 15 minutes of their time** | **Free** |

**Chosen: the combination, at no cost.**

- After any request that enqueues work (and after webhook intake), the API drains the outbox in the background using `waitUntil` from `@vercel/functions`, which Vercel documents for running work after the response on Fluid compute, bounded by the function's maximum duration [V12]. Its use from a NestJS server is confirmed on staging rather than from an example in the documentation.
- A GitHub Actions workflow calls the cron routes with the cron secret: outbox and simulator webhooks every 5 minutes, reconciliation hourly. It is the backstop for delayed events and for anything a background drain missed.
- Vercel's own daily cron entries stay as a third net.
- **Honest limit:** GitHub's schedule is best effort and can run minutes late. If reminders must be punctual to the minute, or status inquiries must fire within a minute of becoming due, that needs Pro cron. Nothing here commits the owner to a paid plan.

### The Hobby plan's terms

Vercel's documentation says the Hobby plan is restricted to "non-commercial, personal use only", and that commercial usage includes any deployment "used for financial gain of anyone involved in producing the project" [V11]. AORA is a commercial project even in its sandbox phase. **This is a terms question for the owner, not an engineering one**: staying on Hobby risks the account being paused. Pro costs $20 per month [V11].

## Owner decision on the plan (2026-10-13): Hobby for now

The owner chose the free Hobby plan. Consequences, all following from [V3]:

- Cron schedules in `services/api/vercel.json` are **once per day** (a more frequent expression fails the deployment on Hobby), and may fire up to 59 minutes late.
- Background work therefore does **not** run promptly on staging. An outbox event waits until the daily run unless something else triggers the job. The jobs themselves are unchanged: each still processes everything due, so nothing is lost, only delayed.
- This is enough to prove the build, sign-in, PIN, permissions and the database. It is **not** enough for the payment journeys, where a webhook or a status inquiry must be processed within seconds or minutes.
- Before Phase 3 (real M-Pesa callbacks) one of these is needed, in order of preference: upgrade to Pro and restore the per-minute schedules in the table above; or drain the outbox in the background of each request, so traffic itself drives the work (needs the Fluid compute background API verified); or an external scheduler calling the cron routes, which is another service and needs the owner's approval.
- Whether Hobby's terms allow this project's use was not verified.

## Which Vercel plan is needed

**Pro.** The outbox drain, webhook delivery and chain monitoring need per-minute cron; Hobby allows one run per day [V3]. Function duration is not the constraint: every job is bounded well under 300 s. Whether Hobby's terms permit this kind of project was not verified.

## Recommendation on preview databases

*Superseded on 2026-10-13 by "Preview databases: none, for now" above.* The earlier recommendation was: give each Vercel preview deployment its own Neon branch through a managed integration [N4]. Previews then run migrations against an isolated copy and can never touch staging data. Use the **Neon-managed** integration: its preview branches are deleted when the Git branch is deleted, while the Vercel-managed integration ties cleanup to Vercel's deployment retention, which "can delay branch deletion by months" [N4]. Billing then stays with Neon. The variable names the integration injects were **not verified** and are checked during setup.

## Measured on the first deployment (2026-10-13)

Staging is `https://aora-api.vercel.app` (Vercel Production target, function in `fra1`, Neon `main`).

- **NestJS runs on Vercel Functions from this monorepo with zero configuration.** The project's root directory is `services/api`; Vercel installs with the repository's pnpm lockfile, runs the package's `build`, and serves `src/main.ts` as one function.
- **Latency from Nairobi:** first request after a deployment about 1.7 s; warm health check 370–500 ms; warm authenticated read through the pooler 390–530 ms. That is acceptable for sign-in and for provider callbacks. No keep-warm or alternative host is needed.
- **Three things the deployment taught us, all fixed in the code:**
  1. **No top-level `await` on `listen`.** With it, every request hung for 60 s and failed with `INTERNAL_FUNCTION_INVOCATION_FAILED`, and no function log appeared. The entry file now starts the server from a function, as Vercel's example does [V1].
  2. **Vercel's build type-checks with its own resolution of global types**: the result of `fetch` had no `status` there. The two call sites cast the result structurally.
  3. **The CLI uploads the working directory.** A `.vercelignore` now excludes machine-local state (`.local`, `.env*`, `node_modules`), without which the upload fails on the local database's socket and could otherwise send local files.
- `vercel link` writes a `VERCEL_OIDC_TOKEN` into `.env.local` and appends broad patterns to `.gitignore`; both were removed.

## Alternatives considered

- **A container host for the API and worker:** keeps a long-running worker and avoids cold starts. Rejected by the owner's hosting decision; it is the fallback if cold starts prove unacceptable.
- **Vercel Queues or Workflows for background work:** mentioned in Vercel's documentation [V2][V4] but not evaluated. The outbox already gives durability inside PostgreSQL; a second durable system is not needed yet.
- **`cpt1` for functions:** closer to Kenya, but far from every Neon region.

## Consequences

- No long-running process. Anything that waits must be a database row with a due time.
- A missed cron tick delays work by one minute; it loses nothing.
- **Phase 2 exit check, done:** cold and warm latency were measured from Kenya (see above) and are acceptable.
- Uploads through the API are limited to 4.5 MB [V2]; product images need direct-to-storage uploads (decision pending, see open questions).
- Staging on the Vercel "Production" target will confuse anyone who reads "Production" literally. Every guide and dashboard note says so.
- Data sits in Frankfurt. Whether that satisfies Kenyan data-protection requirements is open question D-9.

## Sources (all read 2026-10-13)

- [V1] Vercel, "NestJS on Vercel" — https://vercel.com/docs/frameworks/backend/nestjs
- [V2] Vercel, "Vercel Functions Limits" — https://vercel.com/docs/functions/limitations
- [V3] Vercel, "Usage & Pricing for Cron Jobs" — https://vercel.com/docs/cron-jobs/usage-and-pricing
- [V4] Vercel, "Managing Cron Jobs" — https://vercel.com/docs/cron-jobs/manage-cron-jobs
- [V5] Vercel, "Deployment Protection on Vercel" — https://vercel.com/docs/deployment-protection
- [V6] Vercel, "Configuring regions for Vercel Functions" — https://vercel.com/docs/functions/configuring-functions/region
- [V7] Vercel, "Using Monorepos" — https://vercel.com/docs/monorepos
- [V8] Vercel, "Bypass Deployment Protection" — https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection
- [V9] Vercel, "Global network and regions" — https://vercel.com/docs/regions
- [N1] Neon, "Regions" — https://neon.com/docs/introduction/regions
- [N2] Neon, "Connection pooling" — https://neon.com/docs/connect/connection-pooling
- [N3] Neon, "Manage roles" — https://neon.com/docs/manage/roles
- [N4] Neon, "Vercel integration overview" — https://neon.com/docs/guides/vercel-overview
- [N5] Neon, "Neon CLI: login" — https://neon.com/docs/reference/cli-auth
- [N6] Neon, "Branching" — https://neon.com/docs/introduction/branching
- [V10] Vercel, "Deployment Checks" — https://vercel.com/docs/deployment-checks
- [V11] Vercel, pricing and Hobby plan — https://vercel.com/pricing , https://vercel.com/docs/plans/hobby , https://vercel.com/docs/limits/fair-use-guidelines
- [V12] Vercel, "Functions API Reference" (`waitUntil`) — https://vercel.com/docs/functions/functions-api-reference
