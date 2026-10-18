# Vercel Blob — what the documentation says

Read from vercel.com/docs on **2026-10-18**. Nothing is from memory. Each section names its page and that page's "last updated" date. Re-read the page before changing the image adapter (`services/api/src/modules/kelo/images.ts`); record the new date here.

## Store (owner approval 1, 2026-10-18)

- Name `aora-sandbox-images`, id `store_pJL8dirFLcJQiXYg`, region **`fra1`** (next to Neon and the functions), access **public**.
- Connected to project `aora-api`, environments Production (= AORA staging) and Development. No other project needs it: browsers upload with a client token the API issues, and pages show images with plain `<img>` tags, so `kony-web`, `kelo-web` and `internal-ops` hold no Blob variable.
- Created with `vercel blob create-store aora-sandbox-images --access public --region fra1 --yes --environment production --environment development` (CLI 63.1.2).
- **Variables.** `BLOB_READ_WRITE_TOKEN` was added to `aora-api` (Production, Development). Vercel created it as a plain variable, not a sensitive one; making it sensitive means removing and re-adding it, which waits for the owner. `BLOB_STORE_ID` is not a secret (it appears in every public URL) and is in `.env.local` for completeness; the code does not read it.
- **CLI side effects to know about.** With `--yes` the command also pulled the Development variables into `.env.local` (it merged: every existing key was kept) and appended `.env*` to `.gitignore` (reverted: it would have hidden `.env.example`). Next time, run it from a directory whose `.env.local` is disposable.

## Public or private (page: `vercel-blob/public-storage`, updated 2026-08-11)

- "Use public storage for images, videos, large media, and public assets where authentication isn't needed." Catalogue photos are shown to anonymous marketplace visitors, so **public** is right.
- Every file gets `https://<store-id>.public.blob.vercel-storage.com/<pathname>`. Pathnames are unguessable because the API chooses them, but anyone with the URL can read the file: **listing photos must never carry personal data**.
- Content is cached by the CDN and the browser for up to a month by default. Search engines may index public blobs that are linked from public pages.
- Client uploads incur no data-transfer charge; server uploads do. AORA uses client uploads only.

## Authentication (page: `vercel-blob/using-blob-sdk`, updated 2026-08-26)

- On Vercel the SDK prefers OIDC (`VERCEL_OIDC_TOKEN` plus `BLOB_STORE_ID`), then falls back to `BLOB_READ_WRITE_TOKEN`.
- "`handleUpload` always requires a read-write token to sign client tokens for browser uploads. OIDC is not accepted for this method." `generateClientTokenFromReadWriteToken`, which AORA uses, has the same need. So the API needs `BLOB_READ_WRITE_TOKEN`; an empty value selects the labelled simulator.

## Hobby limits (page: `vercel-blob/usage-and-pricing`, updated 2026-09-23)

- Included on Hobby: 1 GB storage per month, 10,000 simple operations, 2,000 advanced operations, 10 GB data transfer.
- Over the limit on Hobby: "You will not pay for any additional usage, but you will not be able to access Vercel Blob" until 30 days pass. **No bill is possible; the failure mode is images stop loading.** Upgrading is on the pre-pilot list (O-10).

## CLI (page: `cli/blob`, updated 2026-08-13)

- `create-store [name] --access <public|private> [--region] [--yes] [--environment <env>]`; default region `iad1`, so pass `--region fra1`.
- `del`, `delete-store` and `empty-store` are permanent. They are never run without the owner's approval.

## Observed (AORA's own calls, 2026-10-18)

- From the owner's machine with the Development token: a client token bound to one pathname, `image/png` and 4 MB uploaded a 1×1 PNG; `head` returned its type and size; an anonymous `GET` of the public URL returned 200 with the same bytes; the same token was refused for a different pathname. The check file is at `sandbox-checks/3c4829cc9a58cfa9cea2dfaf.png` (left in place; deleting it needs approval and it holds nothing).
