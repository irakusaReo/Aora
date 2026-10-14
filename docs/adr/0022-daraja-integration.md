# ADR 0022 — Safaricom Daraja (M-Pesa) integration

- **Status:** Accepted for the sandbox (owner approval of the callback design, 2026-10-13)
- **Date:** 2026-10-14
- **Related:** ADR 0007 (provider adapters); [providers/daraja.md](../providers/daraja.md) (what the documentation says, with sources and dates, and what the sandbox did); CLAUDE.md rules 6, 7, 10, 11; open questions O-11, X-13

## Context

Daraja is the first real provider. Its M-Pesa Express ("STK push") API is asynchronous: AORA asks Safaricom to prompt the payer, Safaricom later calls a callback URL with the result, and a status query can be asked separately. Four facts from the documentation and the sandbox shape the design:

1. **No callback signature is documented.** The portal publishes callback source addresses to allow-list, and nothing else.
2. **A missed callback is not redelivered:** if AORA's server is unavailable the gateway "logs a 503 error and discards the results".
3. **The status query returns a result code but no amount.** The amount is set by the merchant's request; the payer only enters a PIN.
4. **The query needs the `CheckoutRequestID`**, which only the push acknowledgement or the callback carries.

## Decision

**Routing.** The `mpesa` rail goes to Daraja when Daraja is configured; a request with a `sandbox_scenario` always goes to the simulator, so the scripted failure cases stay available. With no Daraja configuration the simulator serves the rail.

**Sandbox guard.** `DARAJA_BASE_URL` must be `https://sandbox.safaricom.co.ke` (or a loopback stand-in on a developer machine, for tests); anything else stops the process. In the sandbox an STK push may only go to Daraja's own test number (`DARAJA_TEST_MSISDN`); any other payer is refused before a request is made, so no real person is ever prompted.

**Callback authentication.** Each STK push carries a callback URL of the form `/v1/webhooks/daraja/stk/{intentId}/{token}`, where `token = HMAC-SHA256(DARAJA_CALLBACK_SECRET, "stk:" + intentId)`. A callback without the right token is refused (401), audited without the token or the body, and stored nowhere. The intent id in the path also lets AORA match a callback whose push acknowledgement was lost.

**A callback never moves money.** A valid callback is stored as received and only prompts a status query. The ledger is posted only from the query's answer:
- Query `0` → succeeded, for the amount AORA requested. If a callback reported an amount, it must equal the intent's amount to the minor unit, otherwise the intent goes to `reconciliation_required` with an `amount_mismatch` exception.
- Query non-zero (for example `1032`, cancelled) → failed, no entry.
- Query `4999` ("still under processing", seen in the sandbox, not documented), a timeout or any other answer → still pending; asked again later; after the configured number of attempts → `reconciliation_required` and an exception.
- A callback that contradicts the query, before or after the query settled the intent, opens a `provider_result_conflict` exception. A callback with a different amount for an already-settled success moves it to `reconciliation_required`.
- A query is scheduled after every accepted push even without a callback, because callbacks can be lost.

**Unknown is never sent again.** A push that times out, or gets an answer AORA does not recognise, becomes `status_unknown` and is never pushed again. With no `CheckoutRequestID` it cannot be queried; it waits for a callback or ends with an operator.

**One documented exception to "adapters never retry".** Daraja's "Invalid Access Token" (`404.001.03`) is a gateway refusal before processing. The adapter fetches a new token and repeats the call once. Nothing else is repeated. A rate-limit refusal (HTTP 429, "Spike arrest", observed in the sandbox) fails the collection with `provider_busy`.

**Tokens.** One access token per process, shared by concurrent calls and renewed a minute before expiry. Token requests count towards the rate limit, and the documentation says a new token invalidates the old one, so tokens are fetched as rarely as possible. Tokens are held in memory only, never stored.

**Personal data.** The payer's number is kept only in the adapter's own record (`payments.provider_operation`), readable by the platform role alone; the tenant role can insert it with the intent but never read it back. It is never in a URL, a log line or the intent. The web app asks for it on the confirmation step, not in the preview URL.

**Amounts.** M-Pesa amounts are whole shillings, so an amount with a fractional part is refused. The callback amount is read from the raw body as decimal text and converted with integer arithmetic; it is never parsed as a floating-point number.

**Timestamp.** `YYYYMMDDHHmmss` in Kenya time (UTC+3). The documentation does not state a time zone; the sandbox accepted it on 2026-10-14.

**Optional allow-list.** `DARAJA_CALLBACK_ALLOWED_IPS` restricts callback source addresses when set. It is left empty until a real sandbox callback shows which addresses the sandbox uses. Each accepted callback's source address is recorded in the audit trail for that purpose.

## Consequences

- **What the token protects, and what it does not.** The token stops anyone who doesn't know the URL from forging a callback. The URL, token included, does appear in the hosting platform's request logs, which AORA cannot redact. That exposure only lets someone trigger a status query, because no callback is ever trusted for money. AORA's own logs and error reports never contain the token, and a test proves it.
- Daraja has no settlement report AORA can read yet (the Pull Transactions API is unread), so Daraja collections are reconciled against the ledger and by status query, not against a provider report.
- Refunds through Daraja's Reversal API and B2C payouts are not part of this decision; they follow in checkpoint 3C after their pages are read.
