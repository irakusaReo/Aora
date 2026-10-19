# CHIWO — Consumer Workflows (sandbox)

- **Source:** brief §2.1, §4.1, §4.2, §7.1; [mvp-scope.md](mvp-scope.md) journeys J12 and J13; [phase-7 plan](../plans/phase-7.md).
- **Status:** 7A built (sign-up, pay a merchant, receipts); 7B built (personal USDC, transfers, requests); 7C built (NAM Vault, personal).
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

## 5. Personal USDC (7B)

Testnet USDC on Base Sepolia, held for the consumer in AORA's sandbox testnet wallet; the consumer's balance is a record in AORA's ledger.

- **Receive on chain:** register your own address by signing a one-time message (no transaction, no funds move), then send testnet USDC from it to the AORA wallet shown. It counts once it has enough confirmations.
- **Send to a person:** enter their phone number. CHIWO shows a masked name; confirm it with your PIN the first time. Transfers are instant, free and on AORA's books only (no chain transaction). Each needs your PIN.
- **Withdraw:** to an address you registered, with your PIN. It completes only once confirmed on chain, and is never sent twice.
- Limits per transfer, per withdrawal and per day apply.

## 6. Payment requests (7B)

Ask someone for USDC by phone number, or make a request anyone with its link can pay. A request is paid once: a second payment is refused. It can be cancelled by the person who made it, and expires after seven days (sandbox setting).

## 7. NAM Vault inside CHIWO (7C, journey J13)

The same NAM USDC Vault (sandbox) as in KONY, but personal. CHIWO shows the product's facts, a personal disclosure (no return is offered or shown) and your position as three separate things: USDC set aside for an order, orders on chain, and the shares you hold with what the vault would give back for them now. You fund an order from your personal USDC balance with your PIN; the holding appears only once the vault deposit is confirmed on chain. Redemptions return USDC to your personal balance once confirmed. If you are also an admin or finance user of a business, its NAM position is a separate business profile that CHIWO never shows, and your personal position never appears in KONY.
