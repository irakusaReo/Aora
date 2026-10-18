# Web apps on Vercel (sandbox)

| App | Vercel project | URL (Production target = AORA staging) | Root Directory |
|---|---|---|---|
| KONY merchant app | `kony-web` | https://kony-web.vercel.app | `apps/kony-web` |
| Operations console | `internal-ops` | https://internal-ops-rho.vercel.app | `apps/internal-ops` |
| KELO marketplace | `kelo-web` | https://kelo-web.vercel.app | `apps/kelo-web` |

- All three projects are on the Hobby team `andres-projects-85e1a425`, connected to GitHub: a push to `main` deploys them; pull requests get previews.
- Variables, **Production target only**: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (public by design), `CLERK_SECRET_KEY` (sensitive), `AORA_API_URL=https://aora-api.vercel.app`. Previews have none of them, so a preview can never reach staging data.
- Function region: `kelo-web` runs in `fra1` (created 2026-10-18, owner-approved). **`kony-web` is in `iad1`**, contrary to the `fra1` rule in CLAUDE.md; moving it is a Production setting change and waits for the owner.
- kelo-web browses without sign-in: it reads only public routes (`/v1/kelo/categories`, `/v1/kelo/marketplace/…`, `/v1/assets`, `/v1/terms/…`) until a buyer signs in.
- The apps call the API from the server side only, with the signed-in person's Clerk session token. The API's `CLERK_AUTHORIZED_PARTIES` must list each app's origin; when a domain changes, update it there and redeploy `aora-api`.
- Every page shows the sandbox banner from `packages/ui`; a test fails if an app's root layout stops rendering it.
- Operator access in `internal-ops` comes from AORA's own flag on the account (`pnpm ops:grant-operator`), never from Clerk.

## Local development

1. `pnpm build && pnpm start:api` (API on port 3000, reading `.env.local`).
2. In `apps/kony-web/.env.local` and `apps/internal-ops/.env.local`: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `AORA_API_URL=http://127.0.0.1:3000`.
3. `pnpm --filter kony-web dev` (port 3001) and `pnpm --filter internal-ops dev` (port 3002). Add `http://localhost:3001` and `http://localhost:3002` to the API's local `CLERK_AUTHORIZED_PARTIES` if you run the API with `AUTH_PROVIDER=clerk`.

## KELO screens (Phase 4A)

- **kony-web `/kelo`:** enlist a store, as a new business or from a KONY workspace you administer; see each store's vetting and provisioning status.
- **kony-web `/w/<workspace>/kelo`:** the KELO section of a workspace: listings, new drafts, and per listing its variants and stock, dated sessions, photos and "Send for review".
- **internal-ops `/kelo`:** store vetting (attest each category requirement; optional restrictions), provisioning records that need an operator (audited retry), and the listing review queue.
- **Photos** upload from the browser straight to Vercel Blob with a one-pathname token from the API. Until the Blob store is connected to `aora-api` (`BLOB_READ_WRITE_TOKEN`), the API uses its image simulator and kony-web says that photos cannot be uploaded yet.
