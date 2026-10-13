# KELO — Experience Rules

Read this before building any KELO screen, on web or mobile. It sets what the screens must do and must never do. Data and calculation rules are in [ADR 0017](../adr/0017-kelo-marketplace-domain.md) and [ADR 0018](../adr/0018-plan-types-and-credit-pricing.md).

The aim is the calm, plain, transparent feel of the best instalment-payment products, in AORA's own identity.

## 1. Principles

1. **Say the total first.** What it costs in full is never further away than what it costs today.
2. **One decision per screen.** Choose a plan; confirm; pay.
3. **Nothing happens that the person did not choose.** No defaults that spend their money.
4. **A limit is not money.** It is how much KELO will let someone spread, and it is always shown with why.
5. **Explain every "no".** A decline comes with reasons and a next step.
6. **Unknown is honest.** "We are checking" is a real state, shown as such.
7. **Works on a modest phone on a slow connection.**

## 2. Consumer patterns

### Product page: plan selector

- Shows the price, then the plans this listing offers.
- Each plan is one row: its name, "from KES X per instalment", how many instalments, and the **total you will pay**.
- Selecting a plan expands the plan-at-a-glance card (below) in place. No tap is needed to find a fee.
- A layaway plan says, in the row itself, that the item is received after the last payment.
- With the credit flag off, credit plans are absent, not greyed out.

### Plan-at-a-glance card

One card, used on the product page, at checkout, in the agreement and in the purchases hub. Always the same content, in this order:

1. Price.
2. Deposit or first payment, and when.
3. Every instalment: date and amount.
4. Fees or interest, as an amount in shillings and in plain words ("No fees if you pay on time" only when that is exactly true).
5. **Total you will pay.**
6. What happens if a payment is late, including the cap.

Every figure comes from the API's schedule engine. The card never rounds, estimates or abbreviates a figure.

### Checkout: one screen, instant decision

- One screen: the item, the plan card, the payment method for the first payment, the terms link with its version, and one button.
- Input is minimal. KELO asks only for what the decision needs and says why it asks. Uploading an M-Pesa statement or allowing a credit-bureau check is the person's choice, each with its own explicit, unticked consent.
- The decision appears on the same screen.
  - **Approved:** the plan card again, then "Agree and pay KES X now".
  - **Approved for less, or with a deposit:** what changed and why.
  - **Declined:** the reasons in plain language, what would change the outcome, and other ways to buy (a layaway plan if the listing has one, or paying in full). Nothing is charged.
- The button states the action and the amount. Agreement is one deliberate tap on a button that says what is being agreed.

### Purchases hub

- Each purchase is a card: the item, the merchant, a timeline of payments made and to come, the next payment's date and amount, and what is left.
- Two actions always visible: **Pay early** and **Report a return**.
- "Pay early" shows the exact new balance and confirms there is no penalty.
- A paused plan (return or dispute open) says it is paused, on which amount, and that no reminders or late charges apply to it meanwhile.
- A layaway card shows progress towards receiving the item, and the refund rule if the person cancels.

### Limit

- Shown as "You can spread up to KES X", never as "available", "balance", "funds" or "credit balance", and never next to a wallet balance.
- Always with what drives it (for example payments made on time) and how to grow it.
- Never shown as a headline number on a home screen.

### Reminders

- Before each due date, by SMS, push or in-app message: the amount, the date, and a link to pay.
- The same tone on the day and after a missed payment. A late message states the amount, any late charge and its cap, and how to get help.
- Push notifications carry no amount or item name on the lock screen.

## 3. Merchant patterns (the KELO section of KONY)

Built on KONY's design system, not a separate look.

- **Dashboard:** scannable, in this order: orders needing action; BNPL sales; settlements due and paid; returns open; fees. Each number opens its list.
- **An order row** shows its state, what the merchant must do next, and when they will be paid.
- **Money is always broken down:** sale, merchant discount fee, clawbacks, net, and where it will be paid.
- **Listing editor:** plans to offer are unticked by default; the merchant chooses. The fee the merchant will pay per plan is shown beside each choice.
- **A merchant never sees** a consumer's limit, decision reasons or credit profile, only what is needed to fulfil the order.

## 4. Copy

- Plain words, short sentences, second person. "You will pay KES 4,500 on 3 March."
- No jargon: "instalment", "total you will pay", "late charge". Not "APR", "tenor" or "facility" in consumer copy, except where a regulation requires the term, in which case it is explained beside it.
- No exclamation marks, no congratulation for borrowing.
- All copy lives in translation files from the first screen. Strings are written to be translatable into Swahili: no concatenated sentence fragments, no meaning carried by word order alone, room for longer text, dates and amounts formatted by locale functions.
- Money is always written with its currency.

## 5. Hard limits

**Identity**

- AORA's own visual identity, built on `packages/design-tokens`.
- Do not use Klarna's name, logo, wordmark, colour palette, typography, illustrations or copy, and do not replicate its screens. Do not name any competitor in screens, copy or code identifiers.

**No dark patterns**

- No pre-ticked boxes, for consent, add-ons, plans or marketing.
- No false urgency: no countdowns, "only today", or invented scarcity. Real stock or capacity may be stated as a fact.
- No fee hidden, deferred or put behind a tap to make a flow look smoother.
- Declining, cancelling and paying in full are as easy to find as accepting.
- No design that makes borrowing look like spending one's own money.

**Disclosure and consent**

- Regulatory disclosures and the versioned terms are complete and prominent, on the screen where agreement happens.
- Consent is recorded with the person, the capacity, the action, the time and the terms version (brief §7.4).
- Each optional data source has its own consent.

**Conduct**

- KELO never requests or reads phone contacts, call logs, messages or photos.
- KELO never contacts anyone but the borrower about a debt, and never shames a borrower.
- Late charges are capped, and the cap is shown before agreement.

**Data**

- Medical-cosmetic purchases show and store what was bought, never health information.

**Flag**

- Every credit feature is behind `kelo_credit`. With it off, no credit screen, limit or wording appears anywhere.

**Sandbox**

- Every screen carries the sandbox label, and the simulated lender is named as simulated.

## 6. Performance and access

- Usable on a mid-range Android phone over a slow connection: first meaningful screen without waiting on images; lists paginated; images sized to their slot.
- Touch targets and text sizes meet accessibility guidance; nothing relies on colour alone; screen readers get the plan card as a readable sequence.
- Every state is designed: loading, empty, error, unknown, paused.

## 7. Review checklist for any KELO screen

- [ ] Is the total repayable visible without a tap wherever a plan is offered?
- [ ] Does every figure come from the API, unrounded?
- [ ] Is anything pre-selected that costs money or shares data?
- [ ] Is the limit worded as "can spread up to", with its drivers?
- [ ] Does a decline show reasons and a next step?
- [ ] Is "we are checking" handled?
- [ ] Is the copy in translation files and free of concatenation?
- [ ] Is the sandbox label present?
- [ ] With the credit flag off, is every trace of credit gone?
