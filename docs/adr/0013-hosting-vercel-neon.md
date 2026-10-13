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

Give each Vercel preview deployment its own Neon branch through a managed integration [N4]. Previews then run migrations against an isolated copy and can never touch staging data. Use the **Neon-managed** integration: its preview branches are deleted when the Git branch is deleted, while the Vercel-managed integration ties cleanup to Vercel's deployment retention, which "can delay branch deletion by months" [N4]. Billing then stays with Neon. The variable names the integration injects were **not verified** and are checked during setup.

## Alternatives considered

- **A container host for the API and worker:** keeps a long-running worker and avoids cold starts. Rejected by the owner's hosting decision; it is the fallback if cold starts prove unacceptable.
- **Vercel Queues or Workflows for background work:** mentioned in Vercel's documentation [V2][V4] but not evaluated. The outbox already gives durability inside PostgreSQL; a second durable system is not needed yet.
- **`cpt1` for functions:** closer to Kenya, but far from every Neon region.

## Consequences

- No long-running process. Anything that waits must be a database row with a due time.
- A missed cron tick delays work by one minute; it loses nothing.
- **Phase 2 exit check:** measure cold and warm latency of the deployed API from Kenya. If a cold start makes sign-in or a provider callback time out, stop and present options (keep-warm, splitting the function, or a different host for the API) with a recommendation. No other host is chosen silently.
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
