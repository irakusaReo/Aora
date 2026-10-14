# Safaricom Daraja — what the documentation says

Everything here was read from Safaricom's developer portal on **2026-10-13**. Nothing is from memory. Each section names its page. Re-read the page before changing the adapter; record the new date here.

Pages that did not render on that date and are still to be read: `apis/TransactionStatus`, `apis/Reversal`. `apis/MpesaExpressQuery` was read on 2026-10-14. Nothing that depends on them is built until they are read.

## Environment (pages: `apis/GettingStarted`, `apis/Authorization`)

- Sandbox base URL: `https://sandbox.safaricom.co.ke`. Production (`https://api.safaricom.co.ke`) is never configured in this repository.
- **Access token:** `GET /oauth/v1/generate?grant_type=client_credentials` with HTTP Basic authentication (consumer key and consumer secret). Response: `access_token`, `expires_in` (3599). Tokens expire after 3600 seconds.
- The Authorization page's FAQ says: "Can I generate multiple tokens? Yes, but each request invalidates the previous token." **Consequence:** two function instances that each fetch a token would invalidate each other. The token must be shared (stored once, refreshed under a lock), not held per process. To confirm in the sandbox before relying on either reading.
- Errors: `400.008.02` invalid grant type; `400.008.01` invalid authentication type.
- The APIs are asynchronous: results go to the callback URL. If the callback server is unavailable, the gateway "logs a 503 error and discards the results". **Consequence:** a missed callback is never redelivered; a status query is the only recovery.
- **Callback source addresses** to allow-list, as published: `196.201.214.200`, `196.201.214.206`, `196.201.213.114`, `196.201.214.207`, `196.201.214.208`, `196.201.213.44`, `196.201.212.127`, `196.201.212.138`, `196.201.212.129`, `196.201.212.136`, `196.201.212.74`, `196.201.212.69`. The page does not say whether the sandbox uses the same addresses: to verify from a real sandbox callback before enforcing.
- **No callback signature is documented.** See ADR 0022.
- **Security credential** (B2C, transaction status, reversal): the initiator password encrypted with the M-Pesa public key certificate, RSA with PKCS #1 v1.5 padding (not OAEP), then base64. Sandbox certificate: `https://developer.safaricom.co.ke/certificates/SandboxCertificate.cer`.

## M-Pesa Express, "STK push" (page: `apis/MpesaExpressSimulate`)

- `POST /mpesa/stkpush/v1/processrequest`.
- Request fields, all mandatory except `TransactionDesc`: `BusinessShortCode` (5 to 6 digits), `Password` = base64(shortcode + passkey + timestamp), `Timestamp` (`YYYYMMDDHHmmss`), `TransactionType` (`CustomerPayBillOnline` for a paybill, `CustomerBuyGoodsOnline` for a till), `Amount`, `PartyA` (payer, `2547XXXXXXXX`), `PartyB` (receiving organisation), `PhoneNumber` (receives the prompt), `CallBackURL`, `AccountReference` (alphanumeric, at most 12 characters, shown to the customer), `TransactionDesc` (at most 13 characters).
- `Amount` is shown as a whole number (`"1"`, `10`). The page does not document cents. AORA sends whole shillings only.
- Acknowledgement: `MerchantRequestID`, `CheckoutRequestID`, `ResponseCode` (`0` = accepted for processing; anything else is an error), `ResponseDescription`, `CustomerMessage`.
- Callback: `Body.stkCallback` with `MerchantRequestID`, `CheckoutRequestID`, `ResultCode` (numeric; `0` = success, any other = failure, example `1032` "Request cancelled by user"), `ResultDesc`. On success only, `CallbackMetadata.Item[]` of `Name`/`Value` pairs: `Amount` (decimal, for example `1.0`), `MpesaReceiptNumber`, `TransactionDate` (`YYYYMMDDHHmmss`, numeric), `PhoneNumber`, and optionally `Balance`.
- **The callback carries no reference of ours.** It is matched by `CheckoutRequestID`.
- Error body: `requestId`, `errorCode`, `errorMessage`. Listed codes include `400.002.02` (bad request), `404.001.03` (invalid access token), `500.001.1001` (merchant does not exist; wrong credentials; "Unable to lock subscriber, a transaction is already in process for the current subscriber": wait at least a minute), `500.003.02` (system busy; spike arrest), `500.003.03` (quota).
- Sandbox shortcode for Lipa na M-Pesa online per the FAQ page: `174379`. The passkey is in the test data on the logged-in simulator page.
- Limits stated in the FAQ (to be held as data, not code): minimum KES 1; KES 250,000 per transaction; KES 500,000 daily; KES 500,000 maximum customer balance.
- The FAQ says an M-Pesa Express transaction can be reversed with the Reversal API.

## Business to Customer, "B2C" (page: `apis/BusinessToCustomer`)

- `POST /mpesa/b2c/v3/paymentrequest`.
- Request: `OriginatorConversationID` (ours, unique per request, "to avoid double disbursement"), `InitiatorName`, `SecurityCredential`, `CommandID` (`BusinessPayment`, `SalaryPayment`, `PromotionPayment`), `Amount`, `PartyA` (the B2C organisation shortcode), `PartyB` (12-digit MSISDN without `+`), `Remarks` (2 to 100 characters), `QueueTimeOutURL`, `ResultURL`, `Occassion` (optional, 1 to 100 characters).
- Acknowledgement: `ConversationID`, `OriginatorConversationID`, `ResponseCode` (`0` = accepted), `ResponseDescription`.
- A repeated `OriginatorConversationID` is refused: error `500.002.1001` "Duplicate OriginatorConversationID." This is the provider-side idempotency AORA relies on.
- Result (to `ResultURL`): `Result` with `ResultType`, `ResultCode` (`0` = success), `ResultDesc`, `OriginatorConversationID`, `ConversationID`, `TransactionID`, and on success `ResultParameters.ResultParameter[]` of `Key`/`Value`: `TransactionAmount`, `TransactionReceipt`, `ReceiverPartyPublicName` ("254… - NAME"), `TransactionCompletedDateTime`, account balances, `B2CRecipientIsRegisteredCustomer`.
- **The recipient's name appears only in the result, after the money has moved.** The page documents no lookup before sending. This is why a payout destination is confirmed by the user and not by a name check (open question O-11).
- Result codes listed: `0`, `1` (insufficient balance in the utility account), `2`, `3`, `4`, `8` (limit rules), `11`, `2006` (account state), `21` (initiator not allowed), `2001` (initiator information invalid), `2028` (not permitted for the shortcode), `2040` (recipient not a registered customer), `8006` (security credential locked), `SFC_IC0003` (number invalid or not on M-Pesa).
- FAQ: status of a B2C transaction can be checked with the Transaction Status Query API by `OriginatorConversationID` or receipt number; B2C cannot be reversed through the API; minimum KES 10, maximum KES 250,000 per transaction; the security credential may be reused across requests; the sandbox `InitiatorName`, `InitiatorPassword` and B2C shortcode come from the test credentials page (login required). The page's examples use `600992` and `600997` as `PartyA`; those are examples, not confirmed test credentials.

## M-Pesa Express query (page: `apis/MpesaExpressQuery`, read 2026-10-14)

- `POST /mpesa/stkpushquery/v1/query` with `BusinessShortCode`, `Password` (base64 of shortcode + passkey + timestamp), `Timestamp`, `CheckoutRequestID`.
- Response: `MerchantRequestID`, `CheckoutRequestID`, `ResponseCode` (`0` = the query was accepted), `ResponseDescription`, `ResultCode` (`0` = the payment succeeded; anything else = failed or error, example `1032` cancelled by the user), `ResultDesc`.
- **The query returns no amount and no receipt.** The M-Pesa Express page says the amount is "pre-set by the merchant" and the customer only enters their PIN, so a confirmed success is a success for the amount AORA requested. The receipt and the amount, when wanted, come from the callback.
- **A query needs the `CheckoutRequestID`**, which only the push acknowledgement or the callback provides. If the push itself times out, there is nothing to query with until a callback arrives.

## Observed in the sandbox (AORA's own calls, 2026-10-14)

Real requests from AORA's sandbox app, test number only, KES 1. Behaviour seen here is evidence about the sandbox, not a documented guarantee.

- **Push accepted** with a timestamp in Kenya time (UTC+3); the password built from it was accepted. Acknowledgement exactly as documented.
- **Query while the payment is pending:** HTTP 200, `ResponseCode` `"0"`, `ResultCode` `"4999"`, `ResultDesc` "The transaction is still under processing". Code `4999` is not in the documentation.
- **Result codes arrive as strings** (`"4999"`, `"1032"`), although the page types them as numeric.
- **The test number's payment ended `1032`** ("Request Cancelled by user.") about 25 seconds after the push, with nobody acting on it.
- **Rate limiting:** HTTP 429 with a body in a different shape from the documented errors: `{"fault":{"faultstring":"Spike arrest violation. Allowed rate : MessageRate{messagesPerPeriod=30, periodInMicroseconds=60000000, maxBurstMessageCount=3.0}","detail":{"errorcode":"policies.ratelimit.SpikeArrestViolation"}}}`. Token requests count towards it. It triggered even with five-second gaps after a burst, so the limiter's window is longer than it looks.
- **Token invalidation** (the Authorization FAQ says each new token invalidates the previous one): not confirmed either way; the rate limiter blocked the test. A token fetched after another one worked.
