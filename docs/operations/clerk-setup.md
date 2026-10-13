# Clerk Setup

How to create the Clerk instance AORA uses for sign-in. **Development instance only**: test keys, sandbox. Background and sources: [ADR 0019](../adr/0019-clerk-integration.md).

- **[you]** steps need you. **[Claude]** steps are run for you afterwards.
- Never paste a key into the chat. Keys go into `.env.local`; Claude sends them to Vercel without printing them.
- Dashboard menu names are as described in Clerk's documentation on 2026-10-13 and may differ slightly; steps where the exact wording was not seen are marked **(to verify)**.

## Steps

1. **[you] Create a Clerk account** at https://clerk.com and create an application named `AORA Sandbox`. A new application starts with a **development instance**, which is the only kind AORA uses. Do not create a production instance.

2. **[you] Choose the sign-in options.** In the application's sign-up and sign-in settings **(to verify)**:
   - Email address: **required**, verified by **email verification code**. This is the sign-in method.
   - Password: **off**.
   - Phone number: **off**. Clerk charges for phone on sign-up and sign-in, so AORA collects the phone number itself (ADR 0019 amendment).
   - Name: on (first and last name).
   - Social sign-in providers: off.

3. **[you] Turn test mode off.** In **Instance Settings** **(to verify)**, disable test mode. With it on, any `+clerk_test` address signs in with the fixed code `424242`, which must not be possible on staging. The API also refuses `+clerk_test` users on a deployed environment, so this is belt and braces.

4. **[you] Copy the API keys into `.env.local`** from the **API keys** page:

   ```text
   CLERK_PUBLISHABLE_KEY=<publishable key, starts pk_test_>
   CLERK_SECRET_KEY=<secret key, starts sk_test_>
   CLERK_JWT_KEY=<PEM public key, from "Show JWT public key">
   ```

   For `CLERK_JWT_KEY`, paste the PEM on **one line** with `\n` between lines, in double quotes.

5. **[Claude] Check the keys** are present, are test keys, and can reach Clerk. Reports pass or fail only.

6. **[you] Create the webhook.** In **Webhooks**, add an endpoint:
   - URL: `https://aora-api.vercel.app/v1/webhooks/clerk`
   - Events: `user.created`, `user.updated`, `user.deleted`, and the email-created event (shown as `email.created` or `emails.created`; to verify).

   Copy its **signing secret** into `.env.local`:

   ```text
   CLERK_WEBHOOK_SIGNING_SECRET=<signing secret, starts whsec_>
   ```

7. **[you, after Resend is set up] Hand sign-in emails to AORA.** In **Customization → Emails**, open the **verification code** template and turn **Delivered by Clerk** off. From then on Clerk sends the email content to AORA's webhook and AORA delivers it through Resend. Do this only after Claude confirms the webhook and Resend are working, or nobody can sign in.

8. **[Claude] Send the variables to Vercel** (Production target, which is AORA staging), deploy, and run journey J2 through Clerk.

## Variables

| Variable | `.env.local` | Vercel `aora-api` (Production = staging) | Sensitive |
|---|---|---|---|
| `CLERK_PUBLISHABLE_KEY` | ✓ | ✓ | no |
| `CLERK_SECRET_KEY` | ✓ | ✓ | yes |
| `CLERK_JWT_KEY` | ✓ | ✓ | no (a public key) |
| `CLERK_WEBHOOK_SIGNING_SECRET` | ✓ | ✓ | yes |
| `CLERK_AUTHORIZED_PARTIES` | optional | ✓ (set by Claude) | no. Comma-separated origins allowed to mint session tokens for the API: the web apps' URLs |

For the apps, when they are created in Phase 3 and Phase 10 (names to confirm against Clerk's quickstarts at that time):

| App | Variables |
|---|---|
| Next.js apps | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` |
| Expo apps | `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` |

## Rules

- Only `pk_test_` and `sk_test_` keys. The API refuses to start with a live key.
- Nothing is ever written to Clerk metadata. Clerk Organizations and roles are not used.
- A development instance allows at most 100 users.
