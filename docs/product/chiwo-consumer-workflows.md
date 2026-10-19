# CHIWO — Consumer Workflows (sandbox)

- **Source:** brief §2.1, §4.1, §4.2, §7.1; [mvp-scope.md](mvp-scope.md) journeys J12 and J13; [phase-7 plan](../plans/phase-7.md).
- **Status:** 7A built (sign-up, pay a merchant, receipts). 7B (USDC, requests) and 7C (NAM) follow.
- Every screen and record is labelled sandbox. No real money moves.

## 1. Personal, never business

CHIWO is one person acting for themself. A person who is also a KONY admin, finance user or cashier signs up to CHIWO separately; their workspace role gives them nothing in CHIWO and their CHIWO account gives them nothing in a workspace. The API refuses any CHIWO request that names a workspace.

## 2. Sign-up (7A)

1. Sign in with an email code (Clerk).
2. Add a phone number if none is on file. It is the financial identity and is stored unverified (O-11).
3. Read and accept the current CHIWO terms (`chiwo_terms`). Consent is recorded in personal capacity.

## 3. Pay a merchant (7A, journey J12)

1. The merchant shows an eight-character **pay code** (created by a KONY admin; a cashier can show it).
2. The consumer enters the code and sees the merchant's trading name, and nothing else about the merchant.
3. The consumer enters an amount and sees, **before authorising**: the amount, the fee they pay (none), the total, the rail (M-Pesa) and the expected timing.
4. The consumer authorises. In the sandbox the M-Pesa prompt goes to Safaricom's test number, never to the consumer's phone (O-14); with the simulator chosen, the payment is scripted.
5. The payment shows as *submitted*, then *succeeded*, *failed*, or *being checked* when the provider has not answered (never resent: the status is queried). A receipt email is sent once it succeeds.
6. The merchant sees the same payment as a collection, with gross, fee and net.

Limits per payment and per day are data (`chiwo.consumer_limit`). A repeated request with the same Idempotency-Key returns the same payment.

## 4. Receipts and activity (7A)

Activity lists everything the consumer did, newest first. A receipt shows the merchant's trading name, amount, fee, total, status, time and reference, with no phone number.
