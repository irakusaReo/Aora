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

## Addendum, 2026-10-14: B2C payouts

- **Routing:** a payout goes to Daraja B2C when the B2C test credentials are configured and the request names no simulator scenario. In the sandbox the recipient must be Daraja's test number, so no real person can be paid.
- **Request:** `OriginatorConversationID` is AORA's payout id; `SecurityCredential` is the initiator password encrypted with Safaricom's public sandbox certificate (RSA, PKCS #1 v1.5, base64), embedded in the code and checked against its recorded SHA-256. `ResultURL` and `QueueTimeOutURL` carry a per-payout token, different from the STK token.
- **Daraja's "Duplicate OriginatorConversationID" refusal means an earlier request exists**, so it is treated as unknown, never as a failure.
- **No authenticated channel exists for B2C results.** Unlike M-Pesa Express, whose status query is a synchronous call with AORA's own access token, the B2C result and the Transaction Status answer are both callbacks to AORA. A status query would therefore add no authentication, only delay. The B2C result callback is applied when its token is valid, its payout id matches the URL, and its amount equals the payout's to the minor unit (otherwise `reconciliation_required`). A result that contradicts an already-final payout opens an exception. **Before any pilot, the callback address allow-list must be enforced**, because the token is then the only other control.
- **When no result arrives,** AORA sends a Transaction Status query (asynchronous; its answer comes to a separate tokened URL) and applies `Completed`, `Cancelled`, `Declined` or `Expired` from it. After the configured number of attempts the payout goes to an operator. A payout is never sent twice.
- **Reversals (refunds of Daraja collections) are not built:** the Reversal API needs a successful collection's receipt, and the sandbox test number never produces one (docs/providers/daraja.md).

