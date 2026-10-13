# Kopo Kopo Teardown and Pan-African Opportunity Map (October 2026)

Kopo Kopo is a small, profitable-by-its-own-account, independent Kenyan merchant-credit business riding on Safaricom's rails. Its acceptance pricing is a pass-through of Safaricom's own tariff, and nearly all of its economic value sits in a high-priced cash-advance product. It is beatable in Kenya on credit access, pricing transparency and multi-rail acceptance. Its moat is weak. The bigger threats to anyone building in this space are Safaricom itself and Moniepoint, which is now in Kenya through a microfinance bank. The Moniepoint takeover of Kopo Kopo that many people assume happened did not happen: the Competition Authority of Kenya approved it in August 2023, but the deal later collapsed, and Moniepoint entered Kenya by buying 78% of Sumac Microfinance Bank instead (completed March 26, 2026).\[1\] Sumac is a small lender, with US$8.1M (KES 1.05B) in assets, 43,800 active loan accounts and an estimated 2.8% share of the microfinance market (TechCabal, Jun 2, 2025).

## TL;DR

- **Kopo Kopo is still independent and is a credit business that also processes payments.** Moniepoint's approved 100% acquisition collapsed around January 2025, for reasons never made public. TechCabal (Jun 2, 2025) said it "fell through" barely five months before Moniepoint's Sumac deal was approved. Kopo Kopo received its CBK Digital Credit Provider licence on April 10, 2026. Its 0.55% acceptance fee is the same as Safaricom's Buy Goods tariff. Most of its estimated margin comes from cash advances at 5.9% a month, which works out to roughly 140% a year on an effective basis (estimate).
- **The biggest gaps** are opaque credit limits, a KSh 75,000 minimum advance that shuts out micro-merchants, flat KSh 50 payouts that hit small withdrawals hard, dependence on a single rail (M-Pesa), and lagging Safaricom's August 2026 tariff cuts. Safaricom's own Fuliza Biashara and Taasi credit, plus 2.1 million Pochi la Biashara wallets, are squeezing it from the bottom of the market.
- **Recommendation:** start in Kenya with a transparent, graduated, multi-rail product for micro and small merchants, plus vertical tools for SACCOs, hotels and pharmacies. Make Tanzania the first export market, because the central bank's TIPS/TANQR interoperability mandate makes multi-wallet acceptance a public rail. Ghana comes second. Do not attack Nigeria head-on, where Moniepoint handles 8 of every 10 in-person payments.

---

## 0. Research plan, assumptions, and scope notes

### Research plan (as executed)

- **Done:** Kopo Kopo/Moniepoint deal coverage (TechCabal, Techpoint, CAK, CB Insights, Tracxn) plus a subagent deep-dive; Kopo Kopo pricing pages, help centre, Terms (effective Nov 27, 2025) and app listings; Safaricom tariffs and August 2026 changes; Fuliza Biashara/Taasi launch (May 2025); Kopo Kopo API docs and GitHub SDKs; CBK DCP/PSP directories; CBN licence categories, Ghana E-Levy repeal, Uganda NPS Act and withdrawal tax, BoT TIPS/TANQR reports; GSMA State of the Industry 2026; Moniepoint 2025 metrics.
- **Not completed in this pass** (search budget exhausted): Reddit, X, Trustpilot, Facebook groups, Hacker News, Stack Overflow; BCEAO/BNR/BoZ/NBE/BEAC primary sources; current data on Wave, Razorpay, Mercado Pago, Stone. These are flagged throughout and listed in Section 9.

### Assumptions

- Exchange rates: KES 129 = US$1; ₦1,387 = US$1. The naira rate is implied by TechCabal's conversion of ₦412 trillion to US$297 billion (Feb 2026). TechCabal later put the same 2025 figure at "more than $294 billion in annualised transaction value" (Mar 26, 2026). [Med]
- "Today" is October 11, 2026. Sources dated before 2024 are flagged as possibly out of date.
- Kopo Kopo's private financials are not public. Every unit-economics figure is an estimate, with the method shown.
- I assume Kopo Kopo keeps a share of Safaricom's 0.55% merchant fee rather than adding a markup on top. This is supported by Techpoint's 2023 description of the two firms "splitting the transaction fees between them".\[2\]
- Persona voices are simulated. They are grounded in cited facts, and any extrapolation is labelled.

### Confidence legend

**Verified** = stated in a primary source or by two or more independent reputable sources. **Estimate** = my calculation from stated inputs. **Speculation** = directional judgement. Each item is also tagged [High], [Med] or [Low].

---

## 1. Executive summary

### Top 5 findings

1. **Ownership: Kopo Kopo is independent. The Moniepoint acquisition failed.** The Competition Authority of Kenya (CAK) unconditionally approved Moniepoint's purchase of 100% of Kopo Kopo Inc. on August 22, 2023 (TechCabal, Aug 22, 2023).\[3\] In September 2024, Moniepoint said "the transaction is still ongoing but hasn't been completed yet" (Innovation Village, Sep 2024).\[4\] TechCabal (Jun 2, 2025) later reported that the deal "fell through", "with neither party disclosing the reasons".\[1\] Moniepoint then entered Kenya by completing a 78% stake in Sumac Microfinance Bank on March 26, 2026 (Techpoint Africa, Mar 26, 2026).\[5\] Databases such as Tracxn and CB Insights still list Kopo Kopo as "acquired by Moniepoint".\[6\]\[7\] **They are wrong.** [Verified, High]
2. **Kopo Kopo resells Safaricom acceptance at Safaricom's price and earns its margin on credit.** It charges 0.55% per Lipa na M-PESA payment, capped at KSh 200 (Google Play listing, updated Aug 23, 2026).\[8\]\[9\] That is identical to Safaricom's Buy Goods merchant tariff (Safaricom tariff page, 2026).\[10\] Cash advances cost 5.9% a month flat, rising to 7.9% for borrowers who were previously late, plus a 10% late fee (Kopo Kopo Help Centre, loans issued after Jan 29, 2025).\[11\] My model suggests credit produces about half of revenue per merchant. [Pricing: Verified, High; revenue split: Estimate, Low]
3. **Safaricom is now competing directly with Kopo Kopo's core credit offer, and it is cutting the price of the rails.** In May 2025 Safaricom launched Fuliza Biashara (overdrafts of KSh 1,000–400,000) and Taasi Till (KSh 1,500–250,000) with KCB, DTB, Sidian, Absa and Pezesha (Safaricom Newsroom, May 2025).\[12\] From August 7, 2026 it made Buy Goods collections up to KSh 500 free for merchants (Safaricom tariff page; tech-ish, Aug 1, 2026).\[10\]\[13\] Active Pochi la Biashara wallets reached 2.1 million against 1 million Lipa na M-PESA till merchants (tech-ish, Aug 2026, citing Safaricom results).\[10\] [Verified, High]
4. **Kenya's credit licensing is now a moat for licensed players and a bottleneck for new ones.** CBK had licensed 281 Digital Credit Providers (DCPs) by September 30, 2026, out of more than 900 applications since March 2022 (CBK press release via TechTrendsKE and Paybill KE, Sep 30, 2026).\[14\]\[15\] Kopo Kopo itself was licensed only on April 10, 2026 (CBK DCP directory, Apr 2026).\[16\] [Verified, High]
5. **The export markets differ sharply in how hard they are to enter.** Tanzania's central bank requires interoperable merchant payments through TIPS and a national TANQR/Lipa Namba code: Lipa Namba transactions reached 60 million in 2025 (BoT National Payment Systems Annual Report 2025),\[17\] and merchants accepting digital payments doubled to 1.32 million in 2024 (The Citizen, 2025).\[18\] Ghana repealed its 1% E-Levy on April 2, 2025 (EY, Apr 9, 2025).\[19\] Uganda kept its 0.5% excise duty on the value of mobile money withdrawals (Kikubo Lane, Apr 19, 2026).\[20\]\[21\] Nigeria's in-person market is dominated by Moniepoint, which says it handles 8 of 10 in-person payments (Moniepoint 2025 Year in Review, Jan 2026).\[22\] [Verified, High]

### Top 3 opportunities

1. **Graduated, transparent working-capital credit for micro and small merchants**, starting at about KSh 5,000 rather than Kopo Kopo's KSh 75,000 minimum, with a published method for setting limits and daily pricing. This addresses Gaps C1–C3.
2. **One code for every rail.** A single merchant identity that accepts M-Pesa, Airtel Money and PesaLink/bank, with automatic reconciliation. This addresses Gap P1 and the risk of depending on one platform. It is natively possible in Tanzania because of TANQR.\[23\]
3. **Vertical operating tools** for matatu SACCOs, hotels and pharmacies: split settlement, staff tills, deposits and refunds, and multi-wallet reconciliation. Kopo Kopo's generic tools (Cashier role, recurring payments) leave room for depth here. This addresses Gaps P2 and P3.

### Recommended first market

**Kenya first (home base and proof point), then Tanzania as the first export market within 12–18 months, then Ghana.** Uganda should be demoted to a watch-list "Tier 1b" because of the withdrawal tax. Nigeria should be treated as a partnership or API market, not a direct merchant-acquiring market. [Speculation, Med]

---

## 2. Kopo Kopo teardown

### 2.1 Corporate facts (verified)

| Item | Fact | Source (date) | Confidence |
|---|---|---|---|
| Founded | 2010/2011 by Ben Lyon and Dylan Higgins; started in the US and moved to Kenya\[2\] | Techpoint Africa (Aug 2023); TechCrunch (Aug 22, 2023) | High |
| Legal entity | Kopo Kopo Inc. (US-incorporated); Kenyan operating subsidiary Kopo Kopo Inc. Kenya Limited\[3\]\[16\] | TechCabal (Aug 22, 2023); CBK DCP directory (Apr 2026) | High |
| Funding | Total raised is reported between US$5.4M (TechCrunch citing Crunchbase, Aug 2023) and US$5.89M (PitchBook); CB Insights says US$5.56M and Tracxn US$5.57M over 4 rounds. The last disclosed round was US$2.1M in October 2015, labelled Series B by TechCabal and PitchBook but Series A by CB Insights (a conflict). | TechCrunch (Aug 2023); TechCabal (Sep 16, 2024); CB Insights, Tracxn, PitchBook (accessed 2026) | Med |
| Investors | Khosla Impact, Accion Venture Lab, Javelin Venture Partners, First Light Ventures, Bamboo Finance\[24\]\[25\] | TechCrunch (Aug 2023); Tracxn (2026) | High |
| Profitability | Company claims to have been profitable since 2015; valuation "low tens of millions"\[26\] | TechCabal (Sep 16, 2024), company claim | Low (unaudited) |
| Staff | 98 employees at the time of the CAK review\[27\]\[28\] | Fintech Futures (Aug 2023); Kenyan Wall Street (Sep 2024) | Med (2023 data) |
| Leadership | CEO Dennis Ondeng (from Sep 2024, previously CTO); CFO Chad Larson (CEO 2019–2024); CTO Kibet Yegon; CRO Rosemary Muyeshi\[29\] | TechCabal (Sep 16, 2024); TechAfrica News (Sep 17, 2024) | High |
| Moniepoint deal | CAK approval Aug 22, 2023; "still in progress" Sep 2024; collapsed around January 2025 ("barely five months" before the Sumac approval, per TechCabal, Jun 2, 2025); no reasons disclosed | TechCabal (Aug 2023, Sep 2024, Jun 2, 2025); Kenyan Wall Street (Oct 21, 2025) | High |
| Credit licence | CBK Digital Credit Provider licence dated April 10, 2026\[16\]\[30\] | CBK DCP directory (Apr 2026); Kenyan Wall Street (Apr 2026) | High |
| Historic scale | "more than 10,000 merchants" (around 2015)\[31\] | CGAP blog (around 2015), **out of date** | Low |
| Lending share | "4% of the online lending market share"\[3\] | TechCabal (Aug 2023), citing CAK, **2023 data** | Low–Med |

**Source conflicts and quality flags.** TechCabal (Aug 2023) described Kopo Kopo's loan product as one of 32 CBK-registered digital lenders, but the CBK directory dates Kopo Kopo's DCP licence to April 10, 2026.\[3\]\[16\] The 2023 claim was probably inaccurate, or it referred to an application rather than a licence. Disrupt Africa and Kenyan Wall Street date the deal's collapse to 2024, while TechCabal's wording implies about January 2025.\[1\]\[32\]\[33\] The Techpoint Africa Sumac article (Mar 26, 2026) was written by its AI desk ("PointAI"),\[34\] so I relied on TechCabal and Business Daily for corroboration.

### 2.2 Business model canvas

| Block | Kopo Kopo (as observed) | Evidence |
|---|---|---|
| Customer segments | Kenyan micro, small and medium merchants with Buy Goods tills (retail, autospares, hardware, food); some online merchants (WooCommerce); developers | Kopo Kopo site and Play listing (2026);\[9\] WooCommerce plugin post (2026) |
| Value propositions | Get a till quickly ("within the same week"); free for customers to pay; flat KSh 50 payouts of any size; collateral-free cash advance up to KSh 15M repaid as a share of sales; overdraft up to KSh 100,000; bulk and recurring payments; staff Cashier role; payment links; API\[8\]\[9\]\[35\]\[36\] | kopokopo.co.ke (2026); Play listing (Aug 2026) |
| Channels | Android/iOS app, web app, referrals ("I quickly referred four of my friends"), API/plugins\[36\] | kopokopo.co.ke testimonials (2026) |
| Customer relationships | Self-serve plus phone/email support; automated limit offers | Play listing (2026) |
| Revenue streams | (1) Share of the 0.55% acceptance fee; (2) KSh 50 per outbound transfer; (3) cash-advance interest of 5.9%/7.9% a month plus a 10% late fee; (4) overdraft fees (not publicly itemised); (5) 0.55% on payment-link and WooCommerce collections\[11\]\[37\]\[38\] | Kopo Kopo Help Centre (2025–26); Play listing |
| Key resources | Till transaction data (the underwriting signal); risk models (CGAP around 2015 described "more than 150 other data-driven signals"); CBK DCP licence; loan book capital\[31\]\[39\] | CGAP (around 2015, out of date); CBK (2026) |
| Key activities | Merchant onboarding and till provisioning; underwriting and collections; payouts; API maintenance | — |
| Key partners | **Safaricom (critical: the rails, tills, Daraja)**; banks for payouts and funding; investors | Techpoint (2023): "collaborated with Safaricom… splitting the transaction fees"\[2\] |
| Cost structure | Staff (about 98 people), credit losses, cost of funds, Safaricom/bank transaction costs, support, compliance | Estimate |

**Investor lens: what is the moat?** The moat is narrow. Kopo Kopo's main asset is a decade of till-level repayment data, and its contract terms require borrowers to "exclusively use your Specified Account… for the processing and settling" of payments while an advance is outstanding (Kopo Kopo Terms, effective Nov 27, 2025).\[40\] That is a contractual lock-in, not a product lock-in. Safaricom has the same data at greater scale, and from 2026 Moniepoint has a deposit licence through Sumac.\[34\] [Speculation, Med]

### 2.3 Product inventory and merchant journey

| Stage | What happens | Friction observed |
|---|---|---|
| Discovery | Referral, field sales, search; marketing message "Get a good partner like Kopo Kopo for your till numbers"\[36\] | Competes with getting a till directly from Safaricom, which charges the same 0.55% |
| Onboarding / KYC | Online application; till "within the same week" (testimonial); third-party review says 1–3 business days\[36\]\[41\] | Third-party figure is not verified; still slower than opening a Pochi wallet instantly on an existing line (Speculation) |
| Activation | Customers pay the till; funds land in the Kopo Kopo wallet "instantly"\[8\]\[9\] | Money sits in Kopo Kopo's wallet, not in M-Pesa; moving it out costs KSh 50 per transfer\[8\] |
| Daily use | App/web dashboard, statements, Cashier role, payment links, recurring and bulk payments\[8\] | Mostly generic; no inventory, invoicing or bookkeeping found in public materials |
| Credit | Overdraft (up to KSh 100k) for outgoing payments; cash advance after 60 days of activity\[8\] (KSh 75k–15M; repayment 10–50% of each incoming payment; up to 180 days)\[8\]\[35\]\[42\] | Limits are opaque; minimum ticket excludes micro-merchants; documented complaints (Section 3) |
| Expansion | More tills, higher limits, API integration | Limit growth not explained to merchants |
| Churn | Merchant moves the till back to Safaricom direct, or moves to Pochi or a bank till | No public churn data; the exclusivity clause during an advance delays churn |

### 2.4 Reverse-engineered pricing

**Published price points (verified):**

| Item | Price | Source (date) |
|---|---|---|
| Accept Lipa na M-PESA (Buy Goods) | 0.55% per payment, capped at KSh 200; payments below KSh 200 free\[9\] | Google Play listing (updated Aug 23, 2026) [High]\[8\] |
| Safaricom direct Buy Goods (comparison) | From Aug 7, 2026: KSh 0–500 free; 501–36,363 at 0.55%; above 36,363 KSh 200\[13\]\[43\] | Safaricom tariff page (2026); The Kenya Times (Aug 2026) [High] |
| Outbound transfer (bank, M-Pesa, Paybill, Till) | KSh 50 flat per transfer\[9\]\[44\] | Play listing (Aug 2026) [High];\[8\] "free to your nominated M-PESA" per Liners (third party, 2026)\[44\] [Low] |
| Payment links / WooCommerce | 0.55% to the merchant; customer pays Safaricom Paybill tariff on Paybill\[37\] | kopokopo.co.ke/pay (2026) [High] |
| Cash advance | 5.9% fixed per month (e.g., KSh 100,000 for 90 days → repay KSh 117,700); 7.9% tier if 15+ days overdue on the last loan; 10% late fee from day 15 after the due date\[11\] | Kopo Kopo Help Centre (loans after Jan 29, 2025) [High] |
| Cash advance size and eligibility | KSh 75,000–15M; at least 60 days of activity; up to 180 days; deduction 10–50% of each incoming payment\[35\]\[42\]\[45\] | Help Centre and cash-advance page (Dec 2025) [High] |
| Overdraft | Up to KSh 100,000;\[8\] fees not itemised in sources reviewed | Play listing "What's new" (2026) [Med]\[8\] |

**Pricing gap to note:** Kopo Kopo's Play listing, updated August 23, 2026, still says "Payments below KSh 200 are FREE".\[8\] Safaricom raised the free band to KSh 500 from August 7, 2026.\[9\]\[10\] If Kopo Kopo has not passed this through, its merchants pay 0.55% on KSh 201–500 tickets while direct Safaricom till holders pay nothing. I could not confirm whether Kopo Kopo updated its billing; the listing text may simply be stale. [Verified that the listing text lags; billing practice unknown, Low]

**Effective monthly cost to a merchant at three volume levels (Estimate):**

Assumptions: the ticket mix is stated per scenario; Kopo Kopo applies its published "free below KSh 200" rule (worst case) or matches Safaricom's KSh 500 band (best case); payouts are to bank or third parties at KSh 50 each.

| Scenario | KES 50k/month (kiosk, average ticket KSh 300, about 167 payments) | KES 500k/month (shop, average ticket KSh 1,500, about 333 payments) | KES 5M/month (wholesaler/hotel, average ticket KSh 5,000, 1,000 payments) |
|---|---|---|---|
| Acceptance fee (published rule) | 167 × 300 × 0.55% = **KSh 275** | 500,000 × 0.55% = **KSh 2,750** | 5,000,000 × 0.55% = **KSh 27,500** |
| Acceptance fee if KSh 500 free band passed through | **KSh 0** | KSh 2,750 (tickets above 500) | KSh 27,500 |
| Payouts | 8 × 50 = KSh 400 (KSh 0 if all to nominated M-Pesa) | 20 × 50 = KSh 1,000 | 30 × 50 = KSh 1,500 |
| **Total** | KSh 275–675 = **0.55%–1.35%** (or 0–0.8% with pass-through) | KSh 3,750 = **0.75%** | KSh 29,000 = **0.58%** |
| Optional: cash advance | Not eligible (KSh 75k minimum is above 1× monthly volume, so very unlikely to qualify) | KSh 300k for 90 days → interest KSh 53,100 = **10.6% of one month's volume** | KSh 3M for 90 days → KSh 531,000 |

**What this means:** for small merchants the flat KSh 50 payout, not the percentage fee, is the regressive part. Withdrawing KSh 1,000 costs 5%. For large merchants Kopo Kopo is no cheaper than Safaricom direct. The real cost is credit: 5.9% a month flat equals 70.8% a year nominal. Because principal is repaid daily, the effective annualised rate on a 90-day advance is about 17.7% ÷ (50% average balance × 0.247 years) ≈ **143%** (Estimate, Med). That headroom is where a challenger can compete.

### 2.5 Unit economics model (Estimate, Low confidence; all assumptions stated)

| Input | Assumption | Rationale |
|---|---|---|
| Active merchants | 30,000 | More than 10,000 around 2015 (CGAP); "thousands" (TechCabal 2024);\[26\]\[31\] 98 staff |
| Average GMV per active merchant | KSh 300,000/month | Mix of kiosks and SMEs |
| Kopo Kopo's net share of 0.55% acceptance fee | 0.20% of GMV | Assumes a revenue share of about 36% with Safaricom (Techpoint 2023 says fees are "split"; the split is undisclosed) |
| Payouts | 10/month at KSh 50; cost to Kopo Kopo about KSh 25 | Margin of about KSh 25 per transfer |
| Borrowers | 15% of active merchants | Eligibility needs 60 days of activity and enough volume |
| Average advance; cycles | KSh 250,000; 3 × 90-day cycles a year at 17.7% | Help Centre pricing example |
| Credit loss | 6% of disbursed principal | Unsecured MSME digital credit; no public figure |
| Cost of funds | 16% a year on average outstanding of about KSh 125,000 | Kenyan wholesale debt for non-banks |
| Serving cost | KSh 300/merchant/month | Support, infrastructure, KYC |
| CAC | KSh 4,500 | Field sales plus referral incentives |
| Monthly churn | 2.5% | Exclusivity clause during advances suppresses churn |

**Arithmetic (per active merchant per month):**
- Acceptance: 300,000 × 0.20% = **KSh 600**
- Payouts: 10 × (50 − 25) = **KSh 250**
- Credit, per borrower per year: interest 250,000 × 17.7% × 3 = 132,750; minus losses 6% × 750,000 = 45,000; minus funding 16% × 125,000 = 20,000; equals **KSh 67,750**. Spread across all merchants: 67,750 × 15% ÷ 12 = **KSh 847**
- Revenue ≈ 600 + 250 + 847 = **KSh 1,697**, a blended take rate of **0.57% of GMV**; credit ≈ 50% of contribution
- Contribution after serving cost ≈ **KSh 1,397/month**
- Payback = 4,500 ÷ 1,397 ≈ **3.2 months**
- Lifetime = 1 ÷ 2.5% = 40 months; LTV ≈ 1,397 × 40 ≈ **KSh 55,900**; LTV/CAC ≈ **12×**
- Company-level revenue ≈ 30,000 × 1,697 × 12 ≈ **KSh 611M (about US$4.7M)**, against staff costs of perhaps KSh 250M (98 × KSh 2.5M). This fits the "profitable" and "low tens of millions" valuation claims (TechCabal, Sep 2024).\[26\]

**Sensitivity:** If credit losses rise to 12%, the credit contribution per borrower falls to KSh 22,750 and the blended contribution falls to about KSh 830/month. Payback stretches to about 5.4 months. **The business is a credit book with a payments funnel attached.** Its valuation therefore depends on loss rates and funding costs, not on payments growth. [Estimate, Low]

**Investor lens: exit logic.** The natural buyers are a bank wanting MSME data, a pan-African acquirer wanting a Kenya entry, or Safaricom. Moniepoint, the most motivated buyer, walked away and bought a deposit-taking licence instead.\[32\] This suggests a strategic acquirer valued the licence more than the merchant book. [Speculation, Med]

---

## 3. Gap matrix

Severity: 1 = minor, 5 = critical. Frequency is a judgement unless stated.

| ID | Dimension | Gap | Evidence (source, date) | Severity | Frequency | Affected users | Root cause | Opportunity |
|---|---|---|---|---|---|---|---|---|
| C1 | Credit | Opaque limits; merchants told they don't qualify after building volume | Play review: "You keep the till busy… only for them to get back with 'sorry you don't meet our limit criteria'" (Google Play, snippet 2025); help article titled "I have been transacting for more than 60 days. Why am I not qualified yet?" (Help Centre, 2025)\[9\]\[42\] | 4 | Common (an FAQ exists for it) | Small merchants | Black-box scoring; risk appetite | Explainable limits with a progress bar and the reasons shown |
| C2 | Credit | Limits don't grow; advances withdrawn | Review (Aug 28, 2026): "I have never seen my overdraft limit increasing… I would like to request for my Cash Advance to be returned"\[8\] | 4 | Recurring | Repeat users | Tight risk policy after 2025 repricing (Speculation) | Graduated limits tied to repayment |
| C3 | Credit / pricing | High price: 5.9%/month flat (about 143% effective) plus 10% late fee | Help Centre (2025)\[11\]\[42\]\[45\] | 4 | All borrowers | SMEs | Unsecured risk, cost of funds | Daily-priced, declining-balance credit; lower price for strong repayers |
| C4 | Credit | KSh 75,000 minimum advance; 60-day wait | Help Centre (2025) | 3 | All micro-merchants | Mama mboga, kiosks | Unit cost of underwriting | Nano-advances from KSh 2–5k; Safaricom starts at KSh 1,000–1,500\[12\] |
| R1 | Pricing | No acceptance advantage over Safaricom direct (identical 0.55%/KSh 200 cap) | Play listing vs Safaricom tariff (2026)\[9\]\[13\] | 3 | All | All | Resale model | Pass through cuts; volume tiers |
| R2 | Pricing | Free band may lag Safaricom's KSh 500 (Aug 7, 2026) | Play listing text (Aug 23, 2026) vs Safaricom | 3 | Tickets of KSh 201–500 | Micro-merchants | Slow repricing or stale copy | Instant pass-through as a marketing message |
| R3 | Pricing | Flat KSh 50 payout is regressive for small withdrawals (5% on KSh 1,000) | Play listing (2026)\[8\] | 3 | Daily for kiosks | Micro-merchants | Flat cost model | Free daily sweep; percentage pricing below a threshold |
| P1 | Product | Single-rail (M-Pesa) acceptance in public materials; no Airtel Money or PesaLink-native acceptance found | Play listing, website (2026) | 3 | All | Merchants with non-Safaricom customers | Built on the Safaricom partnership | Multi-rail single code |
| P2 | Product | Thin business tools (no inventory, invoicing or bookkeeping found) | Product updates page (2026) | 2 | All | SMEs | Credit-first focus | Vertical operating systems |
| P3 | Product | Funds held in the Kopo Kopo wallet; must be moved out | Play listing (2026)\[8\] | 2 | All | All | Wallet architecture | Auto-sweep to the merchant's M-Pesa or bank |
| O1 | Onboarding / KYC | Till "within the same week" vs instant Pochi | Testimonial (kopokopo.co.ke, 2026);\[36\] Pochi on the existing line (Safaricom) | 2 | New merchants | Micro | Till provisioning via Safaricom | Instant soft-launch with tiered KYC |
| S1 | Reliability / settlement | **No public incident data found** (no status page found) | Research gap | ? | ? | All | — | Public status page plus SLA |
| CS1 | Support | Templated replies; one reply is dated earlier than the review it answers | Play reviews (Aug 2026 review shown with Jul 2024 reply)\[8\] | 2 | Unknown | All | Reused reply templates (Speculation) | Named account managers above a GMV threshold |
| D1 | Developer / API | Mixed v1/v2 references; SMS notifications deprecated; inconsistent GitHub org names ("kopo-kopo" vs "kopokopo") in docs; community SDKs (e.g., a Laravel package) fill framework gaps | developers.kopokopo.com; api-docs.kopokopo.com; GitHub (2026)\[46\]\[47\]\[48\] | 2 | Integrators | Developers | Legacy docs | Single versioned API, OpenAPI spec, idempotency keys |
| X1 | Strategic | Platform dependency on Safaricom, which now competes on credit (Fuliza Biashara up to KSh 400k; Taasi) and cuts rail prices | Safaricom Newsroom (May 2025); tariffs (Aug 2026)\[10\]\[49\] | 5 | Structural | Kopo Kopo | Rails owned by a competitor | Multi-rail plus own deposit/credit licence |
| X2 | Strategic | Bottom of the market moving to Pochi (2.1M active vs 1M tills) | tech-ish (Aug 2026)\[10\] | 4 | Structural | Micro segment | Pochi is cheaper and instant | Serve Pochi-tier merchants via aggregation |
| X3 | Strategic | Regulatory exposure: DCP licence only from April 2026; failed M&A | CBK directory (Apr 2026); TechCabal (Jun 2025)\[1\]\[16\] | 3 | — | Kopo Kopo | Late licensing | Compliance as a feature |
| X4 | Strategic | New well-funded entrant: Moniepoint with a deposit licence via Sumac | Techpoint/TechCabal (Mar 26, 2026)\[5\]\[34\] | 4 | — | Kopo Kopo | — | Move fast in niches before Moniepoint localises |

**User-voice caveat:** user evidence here comes mainly from Google Play reviews and Kopo Kopo's own help-centre questions. Reddit, X, Trustpilot and Facebook groups were not searched in this pass. The Play rating is high (4.7 from 6.09K reviews, 500K+ downloads, fetched Oct 2026),\[8\] so the complaints above are a vocal minority. They are, however, concentrated on credit, which is the product that matters most to the business. [Med]

---

## 4. Persona panel

All voices are **simulated**. Facts inside them are cited; personal details are extrapolated (marked *[extrapolated]*).

### Kenya

**Mama mboga, Kisumu.** "I sell sukuma, tomatoes and onions from 6am. Most of my customers pay KSh 50 to 300. Since August, Safaricom doesn't charge me on Buy Goods under KSh 500, and my customers can pay my Pochi too *[extrapolated: her setup]*. I don't need a KSh 75,000 loan. I need KSh 3,000 on Monday morning for stock from the wholesaler, paid back by Thursday. Fuliza Biashara starts at KSh 1,000, but you need more than six months on an active till or Pochi, and repayment runs 14 to 30 days. I'd pay a small fixed fee for a loan that fits my week. I'd switch for free withdrawals and a loan the same day." *Grounding: Safaricom tariff (Aug 2026); Fuliza eligibility (HapaKenya and The Star, May 21, 2025).*

**Matatu SACCO treasurer, Nairobi.** "We have 60 vehicles *[extrapolated]*. Each conductor collects on a till or Paybill, and every evening I reconcile by vehicle, owner and route. My pain is attributing money to vehicles, splitting it between owner, crew and SACCO levy, and paying out fast. Kopo Kopo's KSh 50 per transfer adds up across 60 owners every day:\[8\] about KSh 90,000 a month *[estimate: 60 × 30 days × KSh 50]*. I'd pay a percentage for automatic splitting and owner statements." *Grounding: KSh 50 payout fee.*

**Boutique hotel manager, Mombasa.** "Bookings come in through OTAs, walk-ins pay M-Pesa or card, and deposits come through payment links *[extrapolated]*. Kopo Kopo's payment links help. Paybill customers pay the Safaricom tariff, so some guests grumble. I need deposits, refunds, card plus M-Pesa in one report, and USD guests. I would switch for card and M-Pesa reconciliation in one dashboard and refunds that work." *Grounding: Payment Links page (2026).*

**Developer integrating the API, Nairobi.** "STK push and webhooks work through K2 Connect SDKs in Node, Ruby, PHP, Python and Flutter. But the docs mix v1 and v2 examples, SMS notifications are deprecated, and I had to poll for status in places. I want idempotency keys, signed webhooks with retry logs, a status page, and a sandbox that behaves like production." *Grounding: developers.kopokopo.com; GitHub SDKs (2026). Pain points beyond the documentation are extrapolated.*

**CBK payments regulator.** "We've licensed 281 DCPs out of more than 900 applications since 2022. We care about cost disclosure, debt-collection conduct and data protection. Our DCP regime came from public complaints about unregulated lenders. A merchant-credit firm taking a share of every till receipt must show fair cost disclosure. A 10% late fee will draw scrutiny if complaints rise *[extrapolated]*." *Grounding: CBK press releases (Sep 30, 2026).*

### Nigeria

**Lagos POS agent.** "My terminal is Moniepoint, like most agents. Moniepoint says 8 of 10 in-person payments run through it.\[22\] I live on cash-out commissions and I'm afraid of failed transfers and reversals *[extrapolated]*. A Kenyan-style till product means nothing here. Transfers and cards are the rails. I'd switch only for faster reversals and higher limits." *Grounding: Moniepoint 2025 Year in Review.*

**Kano wholesale trader.** "I move millions of naira a week in bank transfers *[extrapolated]*. Credit is my problem. Moniepoint gave over ₦1 trillion in loans in 2025,\[50\] so competitors must beat them on limits and speed." *Grounding: TechCabal (Jan 29, 2026).*

**CBN fintech licensing officer.** "A PSSP licence needs ₦100 million in shareholders' funds, plus an escrowed deposit, a ₦100,000 application fee and a ₦1 million licence fee. Switching and MMO licences need ₦2 billion.\[51\] Only MMOs hold customer funds.\[52\] Don't present a wallet product under a PSSP licence." *Grounding: CBN circular coverage (BusinessDay; PwC, 2021). The 2021 circular is older than 2024; check for updates.*

### Ghana

**Accra market queen.** "My association's traders lost 1% on every MoMo transfer under the E-Levy until it was repealed on April 2, 2025.\[19\] Now digital is cheaper again. We'd use a group product: collective stock credit, with the association vouching for members *[extrapolated]*." *Grounding: EY (Apr 9, 2025).*

**MoMo agent, Kumasi.** "Float is my life *[extrapolated]*. A merchant product that pushes everything digital takes away my cash-out income unless I'm part of it. Make me a distributor and pay me to onboard merchants." *Extrapolated; no Ghana agent survey data gathered.*

### Uganda

**Kampala boda-boda fleet owner.** "I collect daily from 40 riders on MTN and Airtel *[extrapolated]*. Every time I cash out, I pay 0.5% excise on the value on top of fees.\[20\] That's why I keep money digital as long as possible and pay suppliers digitally." *Grounding: Daily Monitor (2026); Kikubo Lane (Apr 19, 2026).*

**Bank of Uganda supervisor.** "Since March 2021 we license payment system operators, payment service providers and issuers under the National Payment Systems Act. We've used a regulatory sandbox, for example Wave Transfer.\[53\]\[54\]\[55\]\[56\] Show interoperability and trust-account protection." *Grounding: BoU X post (Dec 10, 2025); Daily Monitor via allAfrica (Oct 2021, older).*

### Tanzania

**Dar es Salaam pharmacy owner.** "Customers pay with M-Pesa, Tigo/Mixx, Airtel and bank apps *[extrapolated: wallet mix]*. TANQR and Lipa Namba mean one code can work through TIPS.\[23\] I still reconcile across several statements. I'd pay for one ledger, stock-reorder credit, and the ability to create child tills for each counter."\[23\] *Grounding: BoT NPS Annual Report 2025; Lipa Namba main/child tills (practitioner blog).*

### Tier 2 SMEs (extrapolated, thin sourcing)

- **Rwanda (Kigali salon owner):** "MoMo Pay is everywhere. I want lower merchant fees and credit for equipment." *No primary Rwanda data gathered beyond Nsano's NBR licences (Feb 2025).*\[57\]
- **Zambia (Lusaka hardware SME):** "Customers use Airtel and MTN; FX swings hurt imports. Credit in kwacha is pricey." *Extrapolated; no BoZ source gathered.*
- **Côte d'Ivoire (Abidjan maquis owner):** "Wave made transfers cheap, and Orange Money is still big. I want one place to see all wallets." *Extrapolated; no BCEAO source gathered.*
- **Senegal (Dakar boutique):** "Wave QR is how people pay. I'd want a working-capital loan priced fairly." *Extrapolated.*

### Kopo Kopo insider (skeptical former employee, simulated)

"We were a credit company that described itself as payments. Our acceptance price was Safaricom's price, so every tariff cut was Safaricom's PR, not ours. The Moniepoint deal took over a year of management focus and then collapsed. We only got the DCP licence in April 2026. The models are good, but when risk tightened after the 2025 repricing (7.9% tier, 10% late fee), the reviews filled with 'why isn't my limit growing'. Safaricom launching Fuliza Biashara at KSh 400k for half a million tills was the moment the ceiling became visible." *Grounding: dates and prices cited above; internal motives are speculation.*

### Series B fintech VC (simulated)

"I'd look for three things: a loss rate below 8% through a cycle, funding below 15%, and evidence of acceptance outside Safaricom. Kenya alone caps the opportunity: 1M tills and Safaricom owning the rail. The investable story is a multi-market MSME credit engine with interoperability tailwinds, such as Tanzania's TIPS. Moniepoint shows the endgame. It processed ₦412 trillion in 2025 and lent ₦1 trillion. It raised a US$110M Series C (Oct 2024), then another US$90M (announced Oct 21, 2025), led by Development Partners International's ADP III fund with LeapFrog Investment anchoring the final close, which took the Series C to US$200M." *Grounding: TechCabal (2026); Fintech Futures (Oct 2024); Kenyan Wall Street and TechCabal (Oct 21, 2025).*

---

## 5. Regulatory and licensing analysis

**Regulatory counsel lens.** "Not verified" means I did not confirm the item from a 2024+ primary source in this pass. Do not rely on those items without local counsel.

### Kenya (baseline)

| Item | Detail | Confidence |
|---|---|---|
| Payments licence | PSP authorisation by CBK under the National Payment System Act 2011. New PSPs are still being licensed (e.g., Paystack Payments Kenya, first licensed Dec 23, 2024; CBK PSP directory, Nov 6, 2025).\[58\] This contradicts claims of a total freeze. | High |
| Digital credit | DCP licence under the CBK (Digital Credit Providers) Regulations 2022: 281 licensed by Sep 30, 2026, from more than 900 applications; licensed DCPs issued 9.6M loans worth KSh 165.1B by Aug 2026\[15\] | High |
| Banking | Moratorium on new commercial bank licences lifted Jul 1, 2025; KSh 10B minimum core capital for new entrants (CBK, Apr 16, 2025)\[59\] | High |
| Capital (PSP/DCP) | Not verified in this pass | — |
| Foreign ownership | Possible; Paystack (Stripe) and Moniepoint (via an acquired MFB) are present | Med |
| Data protection | Data Protection Act 2019 / ODPC; CBK coordinates DCP licensing with the ODPC\[60\] | Med |
| Interoperability | M-Pesa dominant; PesaLink bank rail; no mandated universal merchant QR verified | Med |
| Mobile-money tax | 15% excise duty on money-transfer fees (charged on the fee, not on the transaction value). The Finance Act 2023 raised it from 12%, effective July 1, 2023 (PwC Worldwide Tax Summaries, Kenya). | High |
| Timeline | DCP: many applicants wait years (fewer than 1 in 3 approved);\[15\] PSP: months to a year (estimate) | Med/Low |
| Recent changes | Safaricom tariff cuts (Aug 2026); bank moratorium lifted (2025); Business Laws (Amendment) Act 2024 requires all credit providers to be licensed under the CBK Act (Bowmans, Apr 2025)\[61\] | High |

### Nigeria

| Item | Detail | Confidence |
|---|---|---|
| Licences | CBN categories: Switching and Processing (₦2B), MMO (₦2B), PSS umbrella (₦250M), PSSP (₦100M), PTSP (₦100M), Super Agent (₦50M); PSB (₦5B). Only MMOs hold customer funds.\[52\]\[62\] | High (circular dated 2021; check for 2024+ updates) |
| Fees / process | ₦100,000 application fee; ₦1M licence fee; capital escrowed with CBN; approval-in-principle valid 6 months\[51\]\[63\] | High (2021 source) |
| Lending | Microfinance bank licence (Moniepoint's route) or a lender licence; FCCPC digital lending rules apply (not verified in this pass) | Low |
| Data | Nigeria Data Protection Act 2023 (not verified in this pass) | Low |
| Market fact | Moniepoint: 6M+ businesses; ₦412T and 14B transactions in 2025; about 50% of PoS value\[22\]\[64\] | High |
| Timeline | 9–18 months for a PSSP (estimate) | Low |

### Ghana

| Item | Detail | Confidence |
|---|---|---|
| Licences | Bank of Ghana PSP categories, including "Enhanced PSP" (Nsano licensed 2021); capital not verified\[57\] | Med |
| Tax | E-Levy repealed by Act 1128, effective Apr 2, 2025; GRA ordered refunds of post-repeal deductions\[19\]\[65\] | High |
| Remittances | BoG rules convert inward remittances into cedis on arrival and bar payouts into business accounts (Interspace blog, 2026, secondary)\[65\] | Low |
| Data / interop | Not verified in this pass (GhIPSS mobile-money interoperability exists per general knowledge) | Low |
| Timeline | 6–12 months (estimate) | Low |

### Uganda

| Item | Detail | Confidence |
|---|---|---|
| Licences | NPS Act 2020 (Cap 59): Payment System Operator, Payment Service Provider, Issuer of Payment Instruments; licensing since Mar 2021; regulatory sandbox (Wave Transfer)\[53\]\[54\]\[55\]\[56\] | High |
| E-money | E-money issuance only once equivalent cash is in a trust or special account (s.47)\[54\] | Med |
| Tax | 0.5% excise on withdrawal value; 15% excise on telecom service fees; 10% withholding tax on agent commissions;\[21\] Treasury dropped a cut plan (Apr 2026)\[20\] | High |
| Lending | Tier 4 Microfinance Institutions and Money Lenders Act / UMRA (not verified in this pass) | Low |
| Timeline | 6–12 months (estimate) | Low |

### Tanzania

| Item | Detail | Confidence |
|---|---|---|
| Interoperability | TIPS (BoT-operated) mandated for inter-provider retail payments; TANQR standard (2022); Lipa Namba transactions reached 60M in 2025; 47 PSP participants in TIPS (2025)\[17\]\[23\] | High |
| Merchant base | 1.32M merchants accepting digital payments in 2024, up from 657,346; merchant value TSh 26.91T (+50.24%)\[18\] | High |
| Licences | BoT payment systems licensing (PSP/EMI); capital and foreign ownership not verified in this pass | Low |
| Timeline | 9–15 months (estimate) | Low |

### Tier 2 and Tier 3 (screening only; thin sourcing)

| Market | Regulator | What I verified | Gaps |
|---|---|---|---|
| Rwanda | BNR | Category-based PSP licensing (Nsano received "Payment Aggregation" and "Remittance" Category II/III licences, Feb 2025);\[57\] no excise on MoMo withdrawals (Daily Monitor quote, 2026)\[21\] | Capital, timelines |
| Zambia | BoZ | Nothing verified in this pass | All |
| Côte d'Ivoire / Senegal | BCEAO (regional e-money rules) | Nothing verified in this pass | All |
| Ethiopia | NBE | Safaricom operates in Ethiopia through Safaricom Telecommunications Ethiopia (subsidiary),\[66\] so M-Pesa playbooks partly transfer | Foreign-ownership rules for payments, FX |
| Cameroon | BEAC/COBAC | Nothing verified in this pass | All |

### Which markets allow a Kopo Kopo-style model to launch fastest?

1. **Kenya, via partnership:** a merchant can use Safaricom tills and a licensed PSP or DCP partner while your own licences are pending. The bottleneck is your own DCP licence. [Med]
2. **Uganda:** a clear three-category licence regime plus a sandbox route, though the tax damages the economics. [Med]
3. **Tanzania:** slower to license, but once you are a TIPS participant, interoperability is built in. This makes it the best place for a multi-wallet product. [Med]
4. **Ghana:** a moderate regime and a favourable tax change. [Low–Med]
5. **Nigeria:** the slowest and most capital-heavy, and the market leader already holds a bank licence. [Med]

---

## 6. Benchmark analysis

**Payments product strategist lens.**

| Solution | Status (date) | What it does better | How | Transfers to target markets? |
|---|---|---|---|---|
| **Moniepoint** (Nigeria, now Kenya) | 6M+ businesses; ₦412T/14B transactions in 2025; ₦1T SME credit; Monnify gateway ₦25T;\[67\] acquired Orda (restaurant software) and 78% of Sumac MFB (completed Mar 26, 2026)\[5\]\[68\] | Owns the merchant's bank account and terminal; credit underwritten from cash flow; software lock-in | MFB licence → deposits fund loans; PoS distribution through agents | Model transfers (deposits + payments + credit); the PoS wedge does not transfer to M-Pesa Kenya. **Direct threat in Kenya from 2026.** |
| **Safaricom M-PESA for Business** | Fuliza Biashara (KSh 1k–400k, repaid from till inflows), Taasi Till/Pochi; free Buy Goods to KSh 500 (Aug 2026); 2.1M Pochi\[10\]\[12\] | Distribution and zero-friction onboarding on the existing line | Owns the rail; bank partners carry the credit | Only in Safaricom markets (Kenya, Ethiopia). Benchmark for minimum loan size and speed. |
| **Tanzania TIPS + TANQR** (public infrastructure) | 60M Lipa Namba transactions in 2025; 47 PSPs\[17\] | One merchant code works across all wallets and banks\[23\] | Central-bank mandate; merchant directory; main and child tills\[23\]\[69\] | Model to lobby for in Kenya and Uganda; rail to build on in Tanzania |
| **Paystack** (Stripe) | CBK-licensed PSP in Kenya since Dec 23, 2024;\[58\] AI dashboard for 300,000+ businesses (Techpoint, 2026)\[34\] | Developer experience, documentation, online checkout | API-first, multi-rail (cards + M-Pesa) | Strong in online and API; weak in offline micro-merchants |
| **Pesapal** | CBK PSP; Bank of Uganda payment systems operator\[53\]\[58\] | Multi-rail online plus POS in East Africa | Licences in several East African markets | A regional template |
| **Brazil Pix (comparator)** | US$4.6T processed in 2024 (Frontier Fintech, 2026)\[70\] | Free, instant, universal QR | Central-bank-run rail | Supports a TIPS-style strategy; shows why single-MNO dependency is temporary |
| **India UPI (comparator)** | Merchant share of UPI volume is 64% (Frontier Fintech, 2026)\[70\] | Merchant payments dominate | Interoperable QR; zero merchant fee for UPI | Proves interoperable QR shifts volume to merchants; zero fees push providers to earn money elsewhere (credit, software) |
| Wave, Flutterwave, Cellulant/Tingg, Chipper Cash, MTN MoMo Pay, Razorpay, PhonePe, Paytm, Mercado Pago, Stone | **Current status not verified in this pass** | Known models: Wave (low flat-fee wallet, West Africa); Razorpay/Mercado Pago/Stone (merchant credit from acquiring data) | — | Listed for follow-up; no claims made here |

**Takeaway:** the winners pair (a) control of the merchant's balance (bank/MFB/e-money licence) with (b) credit underwritten from flows and (c) software that makes switching painful. Kopo Kopo has only (b). [Speculation, Med]

---

## 7. The better product thesis

**Builder lens.** Five changes, each tied to a gap:

| # | Feature / model change | Gap fixed | Evidence | How it beats Kopo Kopo |
|---|---|---|---|---|
| 1 | **Graduated, explainable credit**: from KSh 2–5k on day 7; limit shown with its drivers; daily-priced, declining-balance pricing; no flat late fee (use capped daily accrual) | C1–C4 | Review complaints; 5.9%/month flat; KSh 75k minimum; Safaricom's KSh 1,000 floor | Captures the micro segment that Kopo Kopo excludes; builds loyalty through visible progress |
| 2 | **One code, every rail**: M-Pesa till/Paybill + Airtel Money + PesaLink/bank; one ledger; auto-sweep | P1, P3, X1 | Tanzania TANQR shows the demand; Kopo Kopo is M-Pesa-only | Lowers Safaricom dependency; useful to hotels and pharmacies |
| 3 | **Transparent pricing that passes cuts through**: match Safaricom's KSh 500 free band immediately; free daily sweep; volume tiers above KSh 2M/month | R1–R3 | Safaricom Aug 2026 cuts; listing lag | Simple marketing message: "every Safaricom cut, same day" |
| 4 | **Vertical operating systems**: SACCO (per-vehicle tills, owner/crew/levy splits), hospitality (deposits, refunds, card + M-Pesa), pharmacy (multi-wallet, reorder credit) | P2 | Persona pains; Kopo Kopo's generic Cashier/recurring tools | Lock-in through workflow, not contract clauses |
| 5 | **Developer platform**: OpenAPI spec, idempotency, signed webhooks with replay, public status page, sandbox parity | D1, S1 | Docs inconsistencies; no status page found | Wins integrators and platform partners (POS, ERP, SACCO software) |

**Model change:** get a DCP licence plus a PSP licence, and pursue a microfinance bank partnership or acquisition by year 2. Moniepoint's Sumac move shows that deposits are the strategic asset.\[32\] [Speculation, Med]

---

## 8. Export playbook (Tier 1)

**Market-entry consultant lens.**

| Market | Entry wedge | Rail partners | Distribution | Pricing | Licensing path | 12-month milestones |
|---|---|---|---|---|---|---|
| **Kenya (home)** | Micro-credit for till and Pochi-tier merchants + SACCO vertical | Safaricom Daraja; Airtel Money; PesaLink via a bank | SACCO federations, wholesaler networks, referral | Pass-through acceptance; free daily sweep; credit at 3–4.5%/month equivalent, declining balance (target) | Apply for DCP now (expect a long queue); partner with a licensed DCP/PSP meanwhile | M3: 1,000 merchants; M6: 20 SACCOs; M12: 15,000 active, loss rate under 6% |
| **Tanzania (export #1)** | Multi-wallet ledger + reorder credit for pharmacies and retail | TIPS participation via licensed partner; Vodacom M-Pesa, Mixx by Yas, Airtel, banks | Pharmacy wholesalers, distributor credit | Pass-through; SaaS fee for ledger | Partner first; BoT PSP licence (9–15 months, est.) | M6: partner live; M12: 5,000 merchants on TANQR |
| **Ghana (export #2)** | Association/group credit for market traders | MTN MoMo, Telecel Cash, AT; GhIPSS (verify) | Market queens/associations; agents as paid onboarders | Low acceptance fee; credit as profit centre | BoG PSP (category TBD) + lending partner | M12: pilot with 3 associations |
| **Uganda (Tier 1b)** | Fleet/boda collections that keep money digital (avoid 0.5% cash-out) | MTN MoMo, Airtel Money | Fleet owners, SACCOs | Free digital-to-digital supplier payouts | BoU PSP; sandbox | Pilot only; scale only if tax falls |
| **Nigeria (partnership)** | API/credit-scoring layer for existing acquirers, not direct acquiring | NIBSS via licensed partner | B2B | Revenue share | Avoid PSSP until there is a clear wedge | Exploratory talks only |

**Tier changes recommended:** Uganda moves down to Tier 1b (tax). Nigeria moves to a partnership tier (Moniepoint dominance and capital). Tanzania moves up to the lead export market (interoperability). Rwanda may deserve moving up later if NBR's category licensing proves quick (Low confidence; needs research). Ethiopia stays in Tier 3 but is worth watching because Safaricom operates there.

---

## 9. Risks, kill criteria, open questions

### Risks and kill criteria

| Risk | Kill criterion (what proves the thesis wrong) |
|---|---|
| Safaricom extends Fuliza Biashara to new merchants and smaller amounts at lower cost | If Safaricom drops the six-month eligibility rule and prices below 3%/month within 12 months |
| Credit losses on micro-loans | If 90-day loss rates on the first 3 cohorts exceed 10% |
| DCP licensing delay | If there is no DCP licence or viable partner within 12 months |
| Moniepoint scales in Kenya through Sumac | If Moniepoint signs 50,000+ Kenyan merchants in its first year (watch metric) |
| Tanzania partner access | If no TIPS-participant partner will offer API access within 6 months |
| Regulation of late fees and collections | If CBK caps merchant-credit pricing below your cost of risk |

### Open questions and what to research next

1. **User voice**: Reddit (r/Kenya, r/Nairobi), X mentions of @KopoKopoInc, Trustpilot, Facebook merchant groups; 1–2 star Play/App Store reviews sorted by most recent.
2. **Builder voice**: Hacker News, Stack Overflow and GitHub issues for k2-connect SDKs.
3. **Kopo Kopo current metrics**: active merchants, loan book and NPLs (none public for 2022–2026).
4. **Whether Kopo Kopo passed through the KSh 500 free band** (call support / test a till).
5. **Tier 2/3 primary regulation**: BNR, BoZ, BCEAO, BEAC, NBE licence capital and timelines.
6. **Ownership after the deal**: Kenyan company registry and US filings for Kopo Kopo Inc.; PitchBook records an undisclosed secondary transaction on Jul 1, 2022.\[71\]
7. **Benchmarks and data**: current data for Wave, Flutterwave, Cellulant, MTN MoMo Pay, Razorpay, Mercado Pago, Stone; FinAccess 2024 and Findex 2025 country tables.

---

## Appendix A: Assumptions log

| # | Assumption | Used in | Confidence |
|---|---|---|---|
| A1 | KES 129/US$; ₦1,387/US$ | Conversions | Med |
| A2 | 30,000 active merchants | Unit economics | Low |
| A3 | KSh 300k average monthly GMV | Unit economics | Low |
| A4 | Kopo Kopo net 0.20% of GMV from acceptance | Unit economics | Low |
| A5 | 15% borrower share; KSh 250k average advance; 3 cycles/year | Unit economics | Low |
| A6 | 6% credit loss; 16% cost of funds | Unit economics | Low |
| A7 | KSh 4,500 CAC; 2.5% monthly churn | LTV/CAC | Low |
| A8 | Linear repayment for the effective APR calculation | Pricing | Med |
| A9 | Ticket mixes per volume scenario | Merchant cost table | Low |
| A10 | Licensing timelines (unless cited) | Regulation | Low |

## Appendix B: Source dating note

Sources are dated inline at each claim; pre-2024 sources are flagged where used.

## Sources

1. [Moniepoint to acquire 78% stake in Kenya’s Sumac after KopoKopo setback](https://techcabal.com/2025/06/02/moniepoint-kenya-sumac-78-kopokopo/)
2. [Moniepoint makes Kenyan foray with the acquisition of Kopo Kopo](https://techpoint.africa/news/moniepoint-acquires-kopo-kopo/)
3. [Moniepoint Inc gets approval to acquire Kenyan fintech Kopo Kopo](https://techcabal.com/2023/08/22/moneipoint-gets-approval-to-acquire-kopo-kopo/)
4. [Kopo Kopo announces new executive team amidst ongoing acquisition by Moniepoint - Innovation Village](https://innovation-village.com/kopo-kopo-announces-new-executive-team-amidst-ongoing-acquisition-by-moniepoint/)
5. [Nigeria’s Moniepoint enters Kenya with 78% stake in Sumac microfinance - TechCabal](https://techcabal.com/2026/03/26/nigerias-moniepoint-enters-kenya-with-78-stake-in-sumac-microfinance/)
6. [Kopo Kopo - 2026 Company Profile, Team, Funding & Competitors - Tracxn](https://tracxn.com/d/companies/kopokopo/__UJBqDIxzLV-q17eKxf_ph_mMkpxn7hLqbjmwyF8Fihw)
7. [Founded Year](https://www.cbinsights.com/company/kopo-kopo)
8. [Kopo Kopo - Payments and Loans - Apps on Google Play](https://play.google.com/store/apps/details?id=com.kopokopo.kopo&hl=en)
9. [Kopo Kopo - Payments and Loans](https://play.google.com/store/apps/details?id=com.kopokopo.kopo&hl=en_IE)
10. [Safaricom reduces M-PESA fees: the new Pochi and Buy Goods tariffs explained - tech-ish](https://tech-ish.com/2026/08/01/mpesa-pochi-buy-goods-tariff-cuts-2026/)
11. [What is the cash advance interest?](https://kopokopoinc.zendesk.com/hc/en-us/articles/20321261315346-What-is-the-cash-advance-interest)
12. [Inside the M-PESA Business loans](https://newsroom.safaricom.co.ke/innovation/inside-the-m-pesa-business-loans/)
13. [M-PESA Charges - Safaricom](https://www.safaricom.co.ke/main-mpesa/m-pesa-for-you/tariffs-limits/consumer-tariffs-limits)
14. [CBK licenses 29 more digital lenders](https://techtrendske.co.ke/2026/09/30/cbk-licenses-29-more-digital-lenders/)
15. [CBK licensed 29 more digital lenders on 30 September…](https://paybillke.com/news/cbk-licenses-29-more-digital-credit-providers-september-2026)
16. [C2: CBK - Official CENTRAL BANK OF KENYA DIRECTORY OF DIGITAL CREDIT PROVIDERS](https://www.centralbank.go.ke/wp-content/uploads/2026/04/Directory-of-Digital-Credit-Providers-April-2026.pdf)
17. [National Payment Systems Annual Report, 2025](https://www.bot.go.tz/Publications/Regular/Annual%20Report/en/2026060211494565.pdf)
18. [Tanzania’s economy shifts rapidly towards cashless transactions](https://www.thecitizen.co.tz/tanzania/news/national/tanzania-s-economy-shifts-rapidly-towards-cashless-transactions-5160668)
19. [Ghana's Parliament amends tax laws following the 2025 budget statement presentation](https://www.ey.com/en_gl/technical/tax-alerts/ghanas-parliament-amends-tax-laws-following-the-2025-budget-statement-presentation)
20. [Ugandans to continue paying 0.5% mobile money tax as Treasury drops cut plan](https://kikubolane.com/2026/04/19/ugandans-to-continue-paying-0-5-mobile-money-tax-as-treasury-drops-cut-plan/)
21. [Mobile money taxes reverse digital financial inclusion](https://www.monitor.co.ug/uganda/business/prosper/mobile-money-taxes-reverse-digital-financial-inclusion-5392494)
22. [Report: Moniepoint says it handled 80% of Nigeria's in-person payments in 2025](https://techpoint.africa/news/moniepoint-2025-report/)
23. [The Anatomy of a Cashless Revolution: Inside Tanzania's "Lipa Namba" Ecosystem](https://johnmwakalinga.me/the-anatomy-of-a-cashless-revolution-inside-tanzanias-lipa-namba-ecosystem/)
24. [techcrunch.com](https://techcrunch.com/?p=2585789)
25. [Kopo Kopo Stock Price, Funding, Valuation, Revenue & Financial Statements](https://www.cbinsights.com/company/kopo-kopo/financials)
26. [Fintech Kopo Kopo names new leadership amid Moniepoint acquisition talks - TechCabal](https://techcabal.com/2024/09/16/kopo-kopo-new-ceo-and-cfo/)
27. [Kenyan Fintech Kopo Kopo Appoints New CEO As Acquisition Looms](https://kenyanwallstreet.com/fintech-kopo-appoints-new-team-amidst-acquisition-plans)
28. [Moniepoint gets the go-ahead to acquire Kenyan fintech Kopo Kopo](https://www.fintechfutures.com/m-a/moniepoint-gets-the-go-ahead-to-acquire-kenyan-fintech-kopo-kopo)
29. [Leadership Shake-Up at Kopo Kopo: New CEO, CFO, CRO, and CTO Announced - TechAfrica News](https://techafricanews.com/2024/09/17/leadership-shake-up-at-kopo-kopo-new-ceo-cfo-cro-and-cto-announced/)
30. [CBK licenses 32 digital lenders more, Loans at 133.5 Billion](https://kenyanwallstreet.com/digital-lenders-cbk-2026-batch)
31. [Responsible Digital Finance for Kenyan Merchants: Five Priorities](https://www.cgap.org/blog/responsible-digital-finance-for-kenyan-merchants-five-priorities)
32. [Moniepoint Closes Additional US\$90Mn In Series C Round to Fuel Expansion | The Kenyan Wallstreet](https://kenyanwallstreet.com/moniepoint-closes-additional-us90mn-in-series-c/)
33. [Nigerian fintech unicorn Moniepoint expanding into Kenya with microfinance bank acquisition - Disrupt Africa](https://disruptafrica.com/2025/06/06/nigerian-fintech-unicorn-moniepoint-expanding-into-kenya-with-microfinance-bank-acquisition/)
34. [After years of trying, Moniepoint breaks into Kenya with Sumac acquisition](https://techpoint.africa/news/moniepoint-acquires-sumac/)
35. [Cash Advance](https://kopokopo.co.ke/cash-advance/)
36. [Kopo Kopo](https://kopokopo.co.ke/)
37. [Payment Links](https://kopokopo.co.ke/pay/)
38. [Product Updates](https://kopokopo.co.ke/category/product-updates/)
39. [Big News: Kopo Kopo is now licensed by CBK as a Digital Credit Provider](https://kopokopo.co.ke/big-news-kopo-kopo-is-now-a-licensed-digital-credit-provider-in-kenya/)
40. [Terms and Conditions](https://kopokopo.co.ke/terms-conditions/)
41. [Kopo Kopo Review: Payments and Loans App Kopokopo.co.ke](https://paymentgateways.org/gateway/kopokopo)
42. [What is Kopo Kopo cash advance?](https://kopokopoinc.zendesk.com/hc/en-us/articles/20300205262994-What-is-Kopo-Kopo-cash-advance)
43. [M-PESA Tariffs 2026: Safaricom Reduces Buy Goods And Pochi La Biashara Charges Effective August 7](https://thekenyatimes.com/business/safaricom-reduces-m-pesa-business-charges-list-of-new-charges/)
44. [Kopo Kopo: Overview, Features, Pricing & Funding](https://liners.com/kopo-kopo)
45. [How do I qualify for a Cash Advance?](https://kopokopoinc.zendesk.com/hc/en-us/articles/20320835623570-How-do-I-qualify-for-a-Cash-Advance)
46. [introduction](https://api-docs.kopokopo.com/)
47. [GitHub - michaelgatuma/laravel-kopokopo: A simple package for developers to consume Kopokopo API in Laravel 8 · GitHub](https://github.com/michaelgatuma/laravel-kopokopo)
48. [Kopo Kopo API Documentation](https://developers.kopokopo.com/)
49. [Safaricom Unveils Business Credit via M-PESA and Pochi Wallets](https://techweez.com/2025/05/21/safaricom-business-credit-mpesa/)
50. [Moniepoint triples transactions to 14 billion](https://techcabal.com/2026/01/29/moniepoint-triples-transaction-volume-in-two-years/)
51. [CBN approves new licence requirements for the Payments System - Businessday NG](https://businessday.ng/markets/article/cbn-approves-new-licence-requirements-for-the-payments-system/)
52. [CBN approves new licence for Nigerian payment systems](https://www.thecable.ng/cbn-approves-new-licence-regime-for-payment-systems/)
53. [Best Payment Gateways in Uganda 2026: Payouts and Fees](https://boldrails.com/blog/best-payment-gateways-uganda)
54. [An Overview Of The National Payment Systems Act, 2020 and All Regulations Thereunder - Springs Advocates](https://springsadvocates.com/an-overview-of-the-national-payment-systems-act-2020-and-all-regulations-thereunder/)
55. [Bank of Uganda on X: "The Bank of Uganda commenced licensing payment system operators, payment service providers, and payment instrument issuers in March 2021. This followed the enactment of the National Payment Systems Act, Cap 59, and the Regulations thereunder. Pursuant to Section 9 of the National Payment Systems Act, Cap 59 and Regulation 3 of the National Payment Systems Regulations, 2021: The Bank of Uganda has so far issued licences to the following entities: https://t.co/NtGpLLNKfF" / X](https://x.com/BOU_Official/status/1998756678322299071?lang=en)
56. [Uganda: Five Companies Issued With Electronic Money Licences - allAfrica.com](https://allafrica.com/stories/202110280313.html)
57. [Nsano](https://en.wikipedia.org/wiki/Nsano)
58. [Page 1 of 9 C2: CBK - Official CENTRAL BANK OF KENYA (CBK)](https://www.centralbank.go.ke/wp-content/uploads/2025/11/Directory-of-Authorized-Payment-Service-Providers-6-November-2025.pdf)
59. [C2: CBK - Official PRESS RELEASE LIFTING OF MORATORIUM ON LICENSING OF NEW](https://www.centralbank.go.ke/uploads/press_releases/164519156_Press%20Release%20-%20Lifting%20of%20Moratorium%20on%20Licensing%20New%20Commercial%20Banks%20in%20Kenya.pdf)
60. [CBK Licenses 41 More Digital Lenders, Raising Total to 126](https://jedcamedia.com/cbk-licenses-41-more-digital-lenders-raising-total-to-126/)
61. [Kenya: Lifting of moratorium on licencing of banks](https://bowmanslaw.com/insights/kenya-lifting-of-moratorium-on-licencing-of-banks/)
62. [LICENSING IN NIGERIA’S FINTECH INDUSTRY: UNDERSTANDING THE CBN’S FRAMEWORK. - Manifield Solicitors](https://manifieldsolicitors.com/licensing-in-nigerias-fintech-industry-understanding-the-cbns-framework/)
63. [Highlights Of CBN's Circular On Requirements For Payment System Licenses - Financial Services - Nigeria](https://www.mondaq.com/nigeria/financial-services/1081414/highlights-of-cbn39s-circular-on-requirements-for-payment-system-licenses)
64. [Moniepoint went from PoS scale to full-stack lock-in in two years - TechCabal](https://techcabal.com/2026/02/02/moniepoint-went-from-pos-scale-to-full-stack-lock-in-in-two-years/)
65. [Ghana Stopped Taxing Mobile Money Royalty Payouts. Its New Remittance Rules Bar a Label's Account From Receiving Them.](https://interspacemusic.com/blog/ghana-mobile-money-royalty-payouts-imto-rules-label-accounts/)
66. [Safaricom](https://en.wikipedia.org/wiki/Safaricom)
67. [Moniepoint processed ₦412tn in payments in 2025; disbursed ₦1tn SME credit - Technext](https://technext24.com/2026/01/29/moniepoint-412tn-payments-1trn-loan-2025/)
68. [Nigeria’s Moniepoint enters Kenya through Sumac acquisition, targeting SME lending boom - Businessday NG](https://businessday.ng/news/article/nigerias-moniepoint-enters-kenya-through-sumac-acquisition-targeting-sme-lending-boom/)
69. [L1P Guide](https://www.l1p.org/wp-content/uploads/2025/08/Tanzania_TIPS_Market_Illustration.pdf)
70. [#115 - Peak MoMo? What Five Years of GSMA Data Actually Shows](https://frontierfintech.substack.com/p/115-peak-momo-what-five-years-of)
71. [Kopo Kopo 2026 Company Profile: Valuation, Investors, Acquisition](https://pitchbook.com/profiles/company/58557-16)
