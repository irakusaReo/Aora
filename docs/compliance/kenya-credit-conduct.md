# Kenya: conduct rules for KELO credit (O-8)

- **Read:** 2026-10-19, for Phase 8 (KELO credit), as ADR 0018 requires before any reminder is built.
- **This is an engineering reading, not legal advice.** Counsel must review it before any pilot (O-12).
- **Sources:**
  - Kenya Law, [Legal Notice 46 of 2022](https://new.kenyalaw.org/akn/ke/act/ln/2022/46/eng@2022-04-22), the Central Bank of Kenya (Digital Credit Providers) Regulations, 2022. Kenya Law marks it **repealed on 2026-09-29**.
  - Kenya Law, [Legal Notice 191 of 2026](https://new.kenyalaw.org/akn/ke/act/ln/2026/191), the **Central Bank of Kenya (Non-Deposit Taking Credit Providers) Regulations, 2026**, published and commenced 2026-09-29. This is the instrument in force, and the one cited below as "r. N".

## 1. Why it applies

- "Loan" is defined to include "buy now pay later" (r. 2). BNPL is a permissible activity of a licensed or registered non-deposit taking credit provider (r. 17(1)(c)).
- Nobody may carry on the business without a licence or registration (r. 5). The DCP-licensed providers of 2022 are deemed licensed under the new rules (r. 96).
- **Sandbox position:** AORA holds no licence. The sandbox lends nothing real, to nobody real; every credit screen says it is a demonstration by an unlicensed sandbox, and the lender of record is the simulated KELO book (ADR 0017). Before any pilot: a licence, or a licensed partner as lender of record (O-4, O-16).

## 2. What the product must do, and where it is built

| Rule | What it requires (paraphrased) | KELO design |
|---|---|---|
| r. 24, r. 54(1)–(3) | Give the borrower the agreement, the repayment schedule, the total cost of credit and the terms at signing; give a copy again on request | The agreement, its schedule and the terms version are stored at acceptance and shown in the purchases hub at any time |
| r. 54(4) | The agreement states: the amount; each charge and when it applies; the interest rate and whether it is on a reducing balance; due dates and how amounts are calculated; the **total cost of credit**; the **periodic rate and the annual percentage rate**; free early repayment; the period after which non-performing credit information may go to a bureau; the effect of a listing; and how to complain | The agreement view and the plan card carry every one of these fields, from the schedule engine. APR is shown with a plain-language explanation beside it (kelo-experience §4 allows the term where a regulation requires it) |
| r. 48 | A key information document summarising benefits, risks and terms | A KID per plan template version, shown before acceptance |
| r. 38 | Before contracting, tell the customer they are free not to enter into it, and of anything that makes it unsuitable | The KID and the checkout screen say so; decline and pay-in-full options sit beside "agree" |
| r. 28(1) | Assess ability to repay; no reckless lending; risk-based pricing per credit policy | An affordability check always runs (ADR 0018). Eligibility rules are versioned data |
| r. 28(2) | Tell a declined applicant **immediately**, with the reasons | Decision on the checkout screen, with reason codes in plain language (K6) |
| r. 30(2) | Recover no charge that was not disclosed in the contract | Charges come only from the agreement's snapshotted template; the ledger refuses anything else |
| r. 29, r. 57 | On a non-performing loan, recover at most the principal owing then, plus contractual interest **not exceeding that principal**, plus reasonable recovery expenses. A loan of 30 days or less is non-performing after 30 days overdue, a longer one after 90; the agreement states the default period | Templates are validated so that interest plus late charges can never exceed the principal (a database check on the template, and a cap in the engine); the agreement states the default period |
| r. 56(1)–(2) | Credit a repayment on the day it is made; allocate it first to principal due, then to fees and charges, then to interest | Allocation order is data with this order as the only sandbox version; posting uses the payment's own date |
| r. 56(3)–(4) | Early repayment, whole or partial, without notice and without penalty; no interest for the remaining period after full early repayment | "Pay early" shows the exact new balance; daily interest stops on the day of payment |
| r. 26(3), r. 54(6)–(8), r. 55 | Product and price changes need CBK approval and 30 days' notice; an agreement changes only with the borrower's acceptance | Agreements snapshot their versions and never change; a new template version applies only to new agreements |
| r. 39, r. 47(2) | A receipt for every transaction; a free statement on request; an easy way to see the loan statement | Receipts and the purchases hub (and CHIWO activity once repayments come from CHIWO) |
| r. 47(e)–(f) | Disclose the provider's true identity and that it is regulated by CBK | In the sandbox: "SANDBOX: simulated lender, not licensed or regulated". A real lender's identity goes here at pilot |
| r. 53 | Collect only what appraisal, approval, disbursement and collection need | Checkout asks for nothing beyond the decision's inputs (kelo-experience §2) |
| r. 58 | Consent to process personal data must be express, specific, **separate from the terms**, withdrawable and recorded, and must name the data, who sees it and how long it is kept | Each optional data source (an M-Pesa statement, a bureau check) has its own consent document, separate from the credit terms, and a withdrawal route |
| r. 30(1) | No threats, shaming, contact with a customer's contacts or phone book, posting their data, unsolicited messages to others, harassment, or calls outside working hours | Reminders go to the borrower only, by email in the MVP (ADR 0020), inside a configured contact window (data); KELO never reads contacts, call logs, messages or photos |
| r. 33(3), (6), (7) | No negative bureau listing at KES 1,000 or below; 30 days' written notice before a negative listing (7 at least for loans repaid more often than monthly); notice within 30 days after | The bureau is a simulator in the MVP and **nothing is ever listed**. Recorded for the bureau adapter |
| r. 41 | No unfair, deceptive or aggressive practice; no discrimination on listed grounds (including health status); no reckless lending | No health data in KELO (ADR 0017); eligibility inputs exclude every listed ground |
| r. 60 | Rules for AI-made lending decisions | Not applicable: decisions are rules-based (ADR 0018). If a model is ever used, r. 60 applies in full |

## 3. Points for counsel (O-16)

1. **Separation of activities.** A credit provider may not carry on payment services and transfer of funds (r. 18(1)(i)), savings or investment accounts (r. 18(1)(c)), or deposit taking (r. 18(1)(a)). AORA's design puts CHIWO (payments), NAM (investment) and KELO (credit) in one platform. A live KELO book likely needs a separate licensed entity or a licensed partner as lender of record, with CHIWO and NAM held elsewhere.
2. **"Merely incidental" credit.** Credit merely incidental to a seller's own sales is outside the regulations (r. 3(3)(f)), and a provider may not offer such credit (r. 18(2)–(3)). KELO's merchants are not the lenders, so this does not obviously take KELO outside them.
3. **Fees from borrowers.** A provider may not collect registration, membership or similar fees from applicants or borrowers (r. 18(1)(d)). The sandbox charges none.
4. **Layaway (O-9).** The regulations do not mention layaway. The sandbox keeps treating it as not credit.

## 4. What changed in the plan because of this reading

- APR and the periodic rate are disclosed (they were absent from ADR 0018's list).
- Repayment allocation follows r. 56(2), not "oldest instalment first".
- The template is validated against r. 29's cap at version creation.
- Data-source consents are separate documents.
- Reminders respect a contact window, are sent only to the borrower, and never threaten a bureau listing, since nothing is listed in the MVP.
