# Web apps on Vercel (sandbox)

| App | Vercel project | URL (Production target = AORA staging) | Root Directory |
|---|---|---|---|
| KONY merchant app | `kony-web` | https://kony-web.vercel.app | `apps/kony-web` |
| Operations console | `internal-ops` | https://internal-ops-rho.vercel.app | `apps/internal-ops` |

- Both projects are on the Hobby team `andres-projects-85e1a425`, connected to GitHub: a push to `main` deploys them; pull requests get previews.
- Variables, **Production target only**: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (public by design), `CLERK_SECRET_KEY` (sensitive), `AORA_API_URL=https://aora-api.vercel.app`. Previews have none of them, so a preview can never reach staging data.
- The apps call the API from the server side only, with the signed-in person's Clerk session token. The API's `CLERK_AUTHORIZED_PARTIES` must list each app's origin; when a domain changes, update it there and redeploy `aora-api`.
- Every page shows the sandbox banner from `packages/ui`; a test fails if an app's root layout stops rendering it.
- Operator access in `internal-ops` comes from AORA's own flag on the account (`pnpm ops:grant-operator`), never from Clerk.

## Local development

1. `pnpm build && pnpm start:api` (API on port 3000, reading `.env.local`).
2. In `apps/kony-web/.env.local` and `apps/internal-ops/.env.local`: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `AORA_API_URL=http://127.0.0.1:3000`.
3. `pnpm --filter kony-web dev` (port 3001) and `pnpm --filter internal-ops dev` (port 3002). Add `http://localhost:3001` and `http://localhost:3002` to the API's local `CLERK_AUTHORIZED_PARTIES` if you run the API with `AUTH_PROVIDER=clerk`.
