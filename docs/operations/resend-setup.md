# Resend Setup

How to set up Resend, which sends AORA's email: sign-in codes, transaction alerts and repayment reminders. Background and sources: [ADR 0020](../adr/0020-notifications.md).

- **[you]** steps need you. **[Claude]** steps are run for you afterwards.
- Never paste a key into the chat.

## Who can receive mail

| Situation | Sender | Who can receive |
|---|---|---|
| **No verified domain** (the starting point) | `onboarding@resend.dev` | **Only the email address your Resend account was created with.** Anything else is refused with a 403. Plus Resend's simulated recipients: `delivered@resend.dev`, `bounced@resend.dev`, `complained@resend.dev`, `suppressed@resend.dev` |
| Verified domain | An address on your domain | Anyone |

So until a domain is verified, **sign in to staging with the same email address as your Resend account**; nobody else can receive a sign-in code.

## Steps

1. **[you] Create a Resend account** at https://resend.com. Use the email address you will sign in to AORA staging with.

2. **[you] Create an API key** named `aora-staging`, with sending access. Add it to `.env.local`:

   ```text
   RESEND_API_KEY=<api key, starts re_>
   ```

3. **[you] Decide on a sending domain** (open question O-13). If you have one, tell Claude the domain or subdomain (for example `mail.example.com`). Claude then adds it in Resend through the API and gives you the exact DNS records to create. If not, staging stays on the test sender.

4. **[Claude] Check the key** and send one test message to `delivered@resend.dev`. Reports pass or fail only.

5. **[you] Create the webhook** in Resend's **Webhooks** page:
   - URL: `https://aora-api.vercel.app/v1/webhooks/resend`
   - Events: all email delivery events (sent, delivered, bounced, complained, and any failure event listed).

   Copy its signing secret into `.env.local`:

   ```text
   RESEND_WEBHOOK_SECRET=<signing secret, starts whsec_>
   ```

6. **[Claude] Send the variables to Vercel**, deploy, and confirm a notification's status moves to delivered.

## Variables

| Variable | `.env.local` | Vercel `aora-api` (Production = staging) | Sensitive |
|---|---|---|---|
| `RESEND_API_KEY` | ✓ | ✓ | yes |
| `RESEND_WEBHOOK_SECRET` | ✓ | ✓ | yes |
| `EMAIL_FROM` | optional | ✓ (set by Claude) | no. `AORA Sandbox <onboarding@resend.dev>` until a domain is verified |

Only the API uses Resend. The web and mobile apps have no Resend variables.
