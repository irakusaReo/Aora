# ADR 0020 — Notifications: channels, Resend, and sign-in emails

- **Status:** Accepted (owner ruling, 2026-10-13). Facts verified against Resend's and Clerk's documentation on 2026-10-13; sources at the end as [R1]…[R5], [C10].
- **Related:** ADR 0008 (outbox), 0018 (collections conduct), 0019; `docs/product/kelo-experience.md`; open questions O-8, O-11, O-12, O-13

## Decision

### A notifications module with channels

- A `notifications` module owns what is sent, to whom, and what happened to it. Business code asks it to notify a person about an event; it never calls a provider.
- A **channel** is an interface: send a rendered message, and optionally interpret delivery callbacks. **Email** is the only channel now. SMS and push can be added as further channels without touching callers.
- **Resend is the email adapter**, and the only code that knows Resend exists.

### Sending is durable and idempotent

- Every notification is a row (`notification`) created in the same transaction as the event that causes it, with an outbox event to deliver it (ADR 0008).
- Each row has a **deduplication key** unique in AORA's database (for example `repayment_reminder:<schedule item>:<offset>`), so the same notification cannot be created twice.
- Delivery passes the row's id to Resend as the `Idempotency-Key` header. Resend keeps keys for 24 hours and, for a repeated key with the same payload, returns the original response without sending again; a repeated key with a different payload is rejected with 409 [R1]. So a retry inside a day cannot send twice, and AORA's own row state covers retries after that.
- A timeout from Resend leaves the notification `status_unknown`; it is retried with the same key, never with a new one.

### Delivery status

- Resend webhooks report what happened to a message. They are signed with Svix: verification needs the raw request body and the `svix-id`, `svix-timestamp` and `svix-signature` headers [R2]. Deliveries are deduplicated on `svix-id`.
- States: `queued → sent → delivered`, or `bounced`, `complained`, `failed`. The exact event names are taken from Resend's event-type reference when the handler is written.
- People can see what AORA sent them and its status: consumers for their own notifications, merchants for those sent to their workspace's members about that workspace.

### Sign-in codes go through Resend

Clerk supports handing email delivery to the application: each email template has a "Delivered by Clerk" setting, and with it off Clerk stops sending and the application must listen for the `emails.created` webhook and deliver the message itself [C10]. The setting is per template [C10].

- AORA turns it off for the verification-code template, receives the webhook (signature verified, as in ADR 0019), and sends the message through the email channel.
- The message Clerk prepared is delivered as-is, inside AORA's sandbox-labelled layout. The one-time code is **never stored**: not in the notification row, the outbox payload, logs or audit. Only the fact that a sign-in email was sent is recorded.
- A sign-in code is useless late, so this path sends inline when the webhook arrives, with one bounded retry, instead of waiting for a scheduled job.
- **Not verified:** the payload's field names, and whether the toggle is available on a development instance on the free plan. Both are confirmed with a real event in checkpoint 2E/2F. **If Clerk cannot hand delivery over cleanly, the fallback is that Clerk sends sign-in codes itself and Resend carries everything else**; that would be raised with the owner, not chosen silently.

### Templates and copy

- **Target:** React Email components rendered to HTML and plain text on the server [R5], one per notification type.
- **As built in checkpoint 2F:** two simple templates (the sign-in wrapper and a payment alert) are plain render functions behind the same interface, with all copy in a per-locale dictionary of whole sentences. React Email, and its React and JSX toolchain, is brought in when the first rich templates are built (receipts, repayment reminders), so that the first deployment through Vercel's build did not take on a second unknown. The interface (`type`, `params`, `locale` in; subject, HTML and text out) does not change.
- Copy is Swahili-ready: no concatenated fragments, named placeholders, locale-formatted amounts.
- Tone follows `kelo-experience.md`.

### What an email may contain

- Account numbers and phone numbers are masked (last three digits).
- No full KYC field, no credential, no PIN, and **no link or code that authorises an action**: a forwarded email must not let anyone do anything. Links only open the app, where the person signs in. The single exception is the sign-in code itself, which is the point of that email.
- Amounts appear in transaction alerts and reminders because they are the information; nothing about anyone else's account does.
- In every non-live environment the subject starts with `[SANDBOX]` and the body carries a sandbox banner.

### Reminders and conduct

Reminder schedules (how long before a due date, how often after) are versioned configuration. Reminders go only to the borrower, never to a third party, in the same neutral tone before and after a due date (ADR 0018). The conduct rules in O-8 still have to be read and cited before reminders are switched on.

### Sending domain

Until a domain is verified in Resend, mail can only be sent from `onboarding@resend.dev`, and **only to the email address of the Resend account's owner**; anything else is refused with a 403 [R3]. Resend also provides test recipients that simulate outcomes: `delivered@resend.dev`, `bounced@resend.dev`, `complained@resend.dev` and `suppressed@resend.dev`, with `+label` variants for the first three [R4].

So before a domain exists, **only the owner's own address can receive a real sign-in email on staging**. Verifying a domain needs DNS records from Resend, provided when the owner supplies the domain (O-13).

## Alternatives considered

- **Clerk delivers sign-in codes itself:** simpler and the fallback, but the owner wants one sender and one delivery log.
- **Calling Resend directly from business code:** no deduplication, no record, no way to add a channel.
- **Resend's hosted templates:** copy would live outside the repository and outside translation files.
- **Sending inside the request without the outbox:** a crash loses the notification or sends it twice.

## Consequences

- Sign-in depends on three systems in sequence (Clerk, AORA's webhook, Resend). A failure in AORA's webhook stops sign-in emails, so that path is monitored and has the documented fallback.
- Personal data (email addresses, message content) is processed by Resend outside Kenya (O-12).
- Before a domain is verified, staging can be exercised only by the owner's address.

## Sources (read 2026-10-13)

- [R1] Resend, "Idempotency Keys" — https://resend.com/docs/dashboard/emails/idempotency-keys
- [R2] Resend, "Verify Webhooks Requests" — https://resend.com/docs/webhooks/verify-webhooks-requests
- [R3] Resend, "403 error using resend.dev domain" — https://resend.com/docs/knowledge-base/403-error-resend-dev-domain
- [R4] Resend, "What email addresses to use for testing?" — https://resend.com/docs/knowledge-base/what-email-addresses-to-use-for-testing
- [R5] Resend, "Template emails with React Email" — https://resend.com/docs/knowledge-base/template-emails-with-react-email (listed in Resend's index; its details are confirmed when templates are built)
- [C10] Clerk, "Email and SMS templates" — https://clerk.com/docs/guides/customizing-clerk/email-sms-templates

## Addendum, 2026-10-14: sign-in codes delivered by Clerk again

- **Change:** the Clerk `verification_code` email template was switched back to "delivered by Clerk" on 2026-10-14 (owner decision), through Clerk's Backend API. Before the change the template was self-delivered (Clerk sent an `email.created` webhook and AORA delivered it through Resend); the API confirmed `delivered_by_clerk = true` after the change.
- **Why:** with no verified sending domain (O-13), Resend delivers only to the Resend account owner's address, so nobody else could sign in to staging and journey J3 could not be tested with a second person.
- **What stays on Resend:** transaction alerts, repayment reminders and staff invitations, through the notifications module. The `email.created` handler stays in place and is idle while Clerk delivers.
- **Consequence:** sign-in emails no longer carry AORA's sandbox banner; Clerk's own development-instance emails are sent instead.
- **To reverse** once a domain is verified: `POST https://api.clerk.com/v1/templates/email/verification_code/toggle_delivery` with body `{"delivered_by_clerk": false}` and the instance's secret key as a Bearer token. Check first with `GET https://api.clerk.com/v1/templates/email/verification_code`.

