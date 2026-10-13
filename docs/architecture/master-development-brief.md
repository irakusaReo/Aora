# AORA
## Master Product, Architecture & Engineering Specification
### Consolidated Development Brief for Claude Code

**Repository:** `Aora/`  
**Blockchain:** Base  
**Standard stablecoin:** Native USDC on Base  
**Architecture:** Modular monolith with clearly separated financial domains  
**Initial market:** Kenya, followed by validated expansion into other markets  
**Product structure:** CHIWO, KONY and KELO, with NAM Vault embedded inside CHIWO and KONY

---

# 1. Executive Summary

AORA is a financial technology platform connecting consumer payments, merchant operations, credit and embedded investments.

The platform consists of three customer-facing products and one shared investment capability:

- **CHIWO:** Consumer payments, money movement and access to financial services.
- **KONY:** Merchant operating system for payment acceptance, business operations, reconciliation, cash-flow management and business investments.
- **KELO:** Credit and financing.
- **NAM Vault:** Embedded investment and digital-asset vault functionality accessible within CHIWO and KONY, rather than a standalone consumer application.

AORA uses **Base as its designated blockchain for immutable on-chain financial records and supported on-chain operations**. **USDC on Base is the standard stablecoin for eligible digital-dollar transfers, supported vault balances and settlement flows.**

Bitcoin Lightning is not part of AORA. Do not implement, retain, recommend or introduce Bitcoin Lightning integrations, adapters, transaction flows or dependencies.

The platform combines conventional financial infrastructure with blockchain-based settlement and verifiable records. Blockchain functionality must solve defined problems rather than replace proven financial controls unnecessarily.

AORA's essential architectural principles are:

1. One shared platform with distinct financial domains.
2. Base as the sole blockchain network designated for AORA's on-chain ledger.
3. Native USDC on Base as the standard supported stablecoin.
4. An internal double-entry accounting ledger alongside the on-chain ledger.
5. No confusion between payment balances, investment holdings, credit limits and unsettled funds.
6. NAM Vault embedded in CHIWO and KONY.
7. Automatic KONY workspace provisioning for qualifying KELO merchants.
8. Provider-neutral payment orchestration for local payment methods.
9. Explicit authorization, reconciliation, auditability and recoverable workflows.
10. No production financial functionality without verified integrations and the necessary legal, security and operational readiness.

The objective is to make the customer experience simple while ensuring that the underlying financial system is accurate, secure, auditable and recoverable.

# 2. Product and Blockchain Architecture

## 2.1 CHIWO — consumer payments and money movement

CHIWO is the consumer-facing financial application.

It provides familiar payment experiences using supported mobile-money services, bank integrations and Base-based USDC functionality.

Core capabilities include:

- Consumer registration and identity verification.
- Phone-number-based financial identity.
- Supported local payment initiation and transfers.
- USDC transfers on Base.
- Payment requests, receipts and transaction history.
- Cross-border transfer experiences where operationally supported.
- Transparent fees, FX rates and delivery status.
- Access to NAM Vault.
- Consumer notifications, statements and support.

Consumers should not need to understand blockchain addresses or network fees to use ordinary payment features. Where a blockchain operation is involved, CHIWO should manage the technical complexity while communicating material costs, risks and transaction status.

A phone number is an identifier, not sufficient authentication. Account recovery, device changes, SIM-swap risk and sensitive transactions require appropriate safeguards.

### Owner amendment, 2026-10-13

- **Sign-in is by a one-time code sent to the user's email address**, through a managed identity provider (Clerk). Sign-in codes, repayment reminders and transaction alerts are sent by email.
- **The phone number remains required and remains the user's financial identity**: it is the payment identifier for mobile-money rails, as described above. It is not the sign-in credential.
- A phone number is not treated as verified because it appears in a profile. How it is verified is an owner decision recorded in `open-questions.md` (O-11); no money is sent to an unconfirmed number.
- "Phone-number-based financial identity" in the list above is read accordingly. Detail: `docs/adr/0019-clerk-integration.md`, `docs/adr/0020-notifications.md`.

## 2.2 KONY — merchant operating system

KONY is the default operating workspace for AORA merchants.

It provides:

- Merchant onboarding and KYB.
- Business profiles, branches and staff roles.
- Payment acceptance and transaction records.
- Settlement and reconciliation.
- Fee and net-receipt visibility.
- Refund and reversal workflows.
- Cash-flow reporting.
- Business integrations and APIs.
- Access to KELO financing where eligible.
- Access to NAM Vault for business investments.

KONY must distinguish between local payment collections, confirmed settlement, available operating cash and USDC held in an eligible wallet or vault.

A merchant's sales volume is not the same as available cash, accounting profit or investable funds.

## 2.3 KELO — credit and financing

KELO manages credit and financing, including eligible merchant financing and other products supported by the approved business model.

Core capabilities include:

- Applications and verification.
- Eligibility and underwriting.
- Offers and disclosures.
- Financing agreements.
- Disbursement and repayment tracking.
- Outstanding obligation calculations.
- Risk monitoring.
- Authorized lender integrations.
- Automatic KONY merchant workspace provisioning.

KELO must not treat a credit limit as cash or as a USDC balance. Financing records and obligations remain distinct from payment and investment accounting.

### Owner amendment, 2026-10-13

KELO is redefined. It is a **consumer buy-now-pay-later (BNPL) marketplace with a merchant side**, not a merchant-credit product.

- **Consumer side:** a marketplace (web and mobile) where consumers browse merchants' goods and services and buy them on instalment terms, and "Pay with KELO" at merchant checkout through KONY payment links and the developer API. A consumer uses KELO with the same AORA identity as CHIWO. A spending limit is never shown as a balance or as cash.
- **Merchant side:** merchants enlist a store, list goods and services, manage inventory or capacity and prices, choose the plans offered per listing, fulfil orders and handle returns. They monitor this from a KELO section of their KONY workspace. Enlisting triggers the KELO-to-KONY provisioning workflow (§4.5).
- **Plan types** are configuration: Pay in N, monthly financing, layaway (no credit extended), and asset financing as a future type.
- **Merchant working-capital financing** (the capabilities listed above this amendment, as applied to merchants) is deferred until after the MVP. The eligibility and reason-code engine is kept reusable for it.
- All credit features stay behind a feature flag until the legal model is confirmed.

Where this amendment conflicts with the text above it in §2.3, the amendment wins. Detail: `docs/adr/0017-kelo-marketplace-domain.md`, `docs/adr/0018-plan-types-and-credit-pricing.md`, `docs/product/kelo-experience.md`.

## 2.4 NAM Vault — embedded investment and vault capability

NAM Vault is a shared capability within CHIWO and KONY.

It is not a standalone consumer application in the primary architecture.

NAM maintains a distinct backend domain for investment products, vault accounting, funding, orders, holdings, withdrawals or redemptions, provider integrations and audit trails.

Its capabilities may include:

- Investment product discovery.
- Eligible USDC vault products.
- Investment or vault deposit instructions.
- Supported funding from CHIWO payment sources.
- Supported funding from merchant interfaces.
- Holdings and transaction history.
- Valuation and returns where applicable.
- Withdrawal and redemption requests.
- Provider reconciliation.
- Product disclosures and risk information.

Do not assume every NAM product is a yield-bearing smart contract. Some products may involve regulated funds, investment managers, custodians or other external providers. The product model must be explicit about what the customer owns, who controls the assets and how withdrawals work.

## 2.5 Shared AORA platform

The platform supplies:

- Identity and access control.
- Canonical business identity.
- KYC/KYB.
- Consent and disclosures.
- Risk and compliance workflows.
- Payment orchestration.
- Internal accounting ledger.
- Base blockchain integration.
- USDC transfer infrastructure.
- Vault and investment orchestration.
- Settlement and reconciliation.
- Notifications.
- Audit and support tools.
- Monitoring and operational recovery.

Keep these responsibilities modular. Product names do not require separate microservices, but they do require clear domain ownership and authorization boundaries.

# 3. Base and USDC: Mandatory Architecture Decisions

## 3.1 Base is the designated blockchain

All AORA blockchain-specific ledger functionality must target Base.

This includes applicable:

- Immutable transaction records.
- On-chain transaction references.
- Financial event anchoring.
- USDC transfers.
- Supported vault deposits and withdrawals.
- Smart-contract vault interactions.
- Smart-contract authorization and settlement.
- On-chain verification and reconciliation.

Do not implement multiple blockchain backends or chain-selection abstractions for production financial operations in this scope. Keep ordinary local payment integrations separate from the Base blockchain adapter.

A future change to the designated chain requires an explicit architecture decision and revision of this specification.

## 3.2 USDC on Base is the standard stablecoin

Use **native USDC on Base** for supported stablecoin transfers, eligible vault balances and on-chain settlement.

Native USDC on Base has the following token contract address:

`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`

Source: Circle's official supported-chain documentation.

The contract address must be stored in verified, environment-specific chain configuration. Do not copy it into unrelated modules or allow arbitrary user-supplied token contracts to become trusted assets.

Production configuration must verify:

- Network identity.
- Chain ID.
- USDC contract address.
- Token decimals.
- RPC endpoint configuration.
- Wallet and signing configuration.
- Supported transaction types.
- Confirmation and finality policy.
- Monitoring and incident response configuration.

Reject unsupported tokens and unexpected token contracts for USDC-specific operations.

Do not silently substitute bridged USDC, USDbC, USDT or another asset for native USDC.

## 3.3 Local payment methods remain supported

Base and USDC do not eliminate the need for local payment integrations.

CHIWO and KONY should continue to support contracted and operationally verified payment providers such as M-Pesa, Airtel Money, bank transfer providers and other market-specific rails.

These payment methods are not blockchain networks. They should connect to the shared platform through provider adapters.

The architecture must support explicit conversion flows between local fiat-denominated payment methods and USDC on Base where an approved provider, commercial arrangement and legal model permit the conversion.

Do not assume that a mobile-money payment automatically becomes USDC. The conversion, exchange rate, fees, execution state and responsible provider must be explicit.

## 3.4 Do not promise instantaneous finality

USDC on Base can support fast, low-cost on-chain transfers, but user-facing status must reflect the actual transaction state and the confirmation policy.

Represent at least:

- Transaction prepared.
- Authorization pending.
- Submitted.
- Pending on-chain confirmation.
- Confirmed under the configured policy.
- Failed.
- Reverted.
- Status unknown.
- Reconciliation required.

Do not tell the customer that a transaction is complete solely because a wallet signed it or an RPC endpoint returned a transaction hash.

For high-value operations, apply an appropriate confirmation and risk policy before treating the transaction as final for the product's purposes.

## 3.5 Blockchain records and accounting are complementary

The internal double-entry ledger remains mandatory.

The Base ledger provides immutable on-chain evidence and records for designated operations. The internal ledger provides the accounting model needed to manage payment states, liabilities, receivables, fees, settlement, investment positions, pending operations and provider reconciliation.

Do not assume that putting a transaction on-chain automatically makes the accounting correct.

For each on-chain operation, store:

- Internal transaction or operation ID.
- Network identifier.
- Transaction hash.
- Relevant contract address.
- Relevant account or wallet reference.
- Asset and amount.
- Submission time.
- Confirmation status.
- Block reference where available.
- Related internal ledger entries.
- Reconciliation status.

On-chain events must be reconciled against internal records. Discrepancies must create actionable exceptions rather than silent corrections.

## 3.6 Privacy and immutable data

Do not publish personal identity documents, phone numbers, KYC/KYB data, private customer details, sensitive business information or unnecessary transaction metadata on Base.

Store sensitive information in appropriately protected off-chain systems. On-chain records should use the minimum necessary references, hashes or structured data needed for verification and reconciliation.

A hash is not automatically anonymous or safe to publish if it can be linked back to personal data.

Document the data model, privacy implications and retention strategy before deploying contracts that create permanent records.

## 3.7 Smart-contract safety

Any AORA-controlled contract handling USDC or vault assets requires:

- A documented specification.
- Explicit access-control design.
- Unit and integration tests.
- Invariant and adversarial testing.
- Reentrancy and authorization review.
- Upgradeability decisions and documented risks.
- Emergency and incident procedures.
- Independent security review appropriate to the risk.
- A controlled deployment process.
- Verified deployment addresses and source code.

Do not deploy unaudited contracts with production customer funds.

Do not create upgradeable contracts by default. If upgradeability is necessary, document who can upgrade, what controls apply, how upgrades are announced and how customers are protected.

## 3.8 Wallet and transaction authorization

Use a documented wallet architecture suited to the actual product and legal model.

Evaluate account abstraction, smart accounts, managed signing or other supported wallet infrastructure only where it improves usability and security.

The system must define:

- Who controls the signing keys.
- Who can authorize a transaction.
- How account recovery works.
- How merchant signatories approve transactions.
- How signing requests are protected.
- How compromised credentials are handled.
- How transaction limits and policy checks are enforced.
- Whether transaction fees are paid by the user, sponsored or incorporated into disclosed pricing.

Never store private keys or seed phrases in application source code, plaintext configuration, ordinary database fields or logs.

Do not invent wallet-provider capabilities. Implement only the verified signing and recovery model selected for the product.

# 4. Customer Journeys

## 4.1 Consumer payment and USDC transfer

1. The consumer signs in to CHIWO.
2. CHIWO verifies the relevant identity and authorization state.
3. The consumer selects a supported payment source or USDC transfer option.
4. The application displays the amount, currency, applicable fees and expected timing.
5. The consumer explicitly authorizes the transaction.
6. The payment orchestration layer routes the operation to the relevant provider or Base integration.
7. The system records the transaction in its internal ledger.
8. For on-chain transfers, the system submits the transaction and tracks its confirmed status.
9. The transaction is reconciled against the relevant provider or on-chain records.
10. CHIWO displays the correct final or unresolved state.

If the transaction converts local fiat to USDC, show the applicable rate, fees and destination amount before authorization.

## 4.2 Consumer NAM Vault journey

1. The consumer opens NAM Vault within CHIWO.
2. NAM presents eligible products and required disclosures.
3. The consumer completes applicable investor onboarding and eligibility checks.
4. The consumer chooses a supported funding source.
5. The system explains whether funding involves local fiat, a conversion to USDC or an existing USDC balance.
6. The consumer authorizes the funding instruction.
7. The system tracks the payment, USDC transfer and investment order as distinct linked operations where applicable.
8. NAM confirms holdings only when supported by the authoritative vault or investment-provider state.
9. The consumer can request a withdrawal or redemption where supported.
10. The application tracks the request until the relevant provider or contract state is confirmed.

Do not display an investment order as completed merely because its funding transfer succeeded.

## 4.3 Merchant payment and treasury journey

1. A merchant signs in to KONY.
2. KONY displays collections, fees, settlements and relevant operating information.
3. The merchant selects a supported payout, transfer or USDC treasury function.
4. The application identifies the source of funds and the actual entity or provider controlling them.
5. The merchant reviews amount, currency, conversion rate, fees and destination.
6. An authorized user approves the operation.
7. The platform executes the supported local payment or Base transaction.
8. The platform records the operation and reconciles it.
9. KONY displays the resulting status.

KONY must not imply that it can directly transfer money from an external M-Pesa or bank account without an authorized integration that supports that operation.

## 4.4 Merchant NAM Vault journey

1. The merchant opens NAM Vault in KONY.
2. The system establishes the business-investor context.
3. The merchant reviews available products, disclosures and liquidity conditions.
4. KONY presents the eligible funding sources and available amount.
5. The merchant authorizes an investment.
6. Where the product uses USDC, the platform verifies the source and amount before the on-chain or provider transaction.
7. NAM tracks funding, order and allocation separately.
8. Confirmed holdings appear in the business investment view.
9. Withdrawals or redemptions follow the applicable product process.

Do not treat gross merchandise volume, unsettled payments or a credit facility as available USDC.

## 4.5 KELO-to-KONY merchant provisioning

When a qualifying merchant is created or approved in KELO:

1. Resolve or create the canonical AORA business identity.
2. Validate the required business identity and onboarding state.
3. Create or link the KONY workspace.
4. Link the KELO merchant record to the KONY workspace.
5. Provision the initial authorized administrator.
6. Apply the correct roles and tenant permissions.
7. Record the provisioning event.
8. Notify the merchant.
9. Expose provisioning status to authorized support staff.

The process must be idempotent and recoverable. Existing KELO merchants must be eligible for safe linking or migration.

Automatic KONY access does not automatically authorize payments, financing, investment orders, wallet withdrawals or changes to settlement instructions.

## 4.6 KELO consumer purchase journeys (owner amendment, 2026-10-13)

Added by the owner on 2026-10-13. These journeys follow the same rules as §4.1 to §4.5.

**Merchant enlistment**

1. A merchant enlists a store on KELO and passes the vetting its categories require.
2. Enlisting triggers §4.5: the merchant receives or is linked to a KONY workspace.
3. The merchant lists goods or services, sets prices and stock or capacity, and chooses the plans offered per listing.
4. Listings pass review before they are visible.

**Instalment purchase (Pay in N or monthly financing)**

1. The consumer signs in with their AORA identity and chooses a listing and a plan.
2. KELO shows the price, any deposit, every instalment date and amount, fees or interest, the total repayable and the late-charge policy before acceptance.
3. KELO makes an eligibility decision and shows its reasons.
4. The consumer consents to the versioned terms and pays the first instalment or deposit.
5. The merchant confirms and fulfils the order; delivery is confirmed.
6. The merchant is settled according to the category's settlement rule, less the merchant discount fee.
7. The consumer repays on the schedule. Each repayment is posted to the ledger and reconciled.

**Layaway**

1. The consumer chooses a layaway plan. No credit is extended.
2. The consumer pays instalments before receiving the item. The funds are held and are not the merchant's until fulfilment.
3. When the plan is fully paid, the merchant fulfils and is settled.
4. Cancellation follows the configured refund rules.

**Returns and disputes**

1. A return or an open dispute pauses repayments on the affected amount.
2. A refund reduces the outstanding balance through compensating ledger entries.
3. Money already settled to the merchant is clawed back according to configured rules.

An order, its credit agreement and its payments are separate, linked state machines. An order is never shown as complete because a payment succeeded.

# 5. KONY Merchant Operating System: Competitive Strategy

KONY should learn from established merchant payment platforms, including the opportunities identified in [the KONY competitive lessons](../product/kony-competitive-lessons.md), without simply cloning a payment dashboard.

The competitive objective is to connect payment acceptance to business operations, reconciliation, cash-flow visibility, financing and investment access.

## 5.1 Multi-rail acceptance

Support payment methods only where the provider, country, currency and merchant are eligible.

Potential methods include:

- M-Pesa.
- Airtel Money.
- MTN Mobile Money.
- Other local mobile-money systems.
- Bank transfers.
- Cards through approved acquiring partners.
- Supported QR schemes.
- Payment links and e-commerce integrations.
- USDC on Base for supported digital-asset transactions.

Local payment providers and Base-based USDC transfers must be represented as distinct rail types with explicit capabilities.

## 5.2 Transparent merchant economics

Show gross amount, fees, applicable taxes, net amount, currency, transaction status and settlement status.

Do not label gross payment volume as revenue or profit.

Pricing must account for provider charges, taxes, revenue share, FX, infrastructure and operating costs. Proposed payout caps, tiered pricing or volume-based pricing must be validated before becoming production rules.

## 5.3 Settlement and reconciliation

Provide clear status for pending settlement, confirmed settlement, payouts, failures and unresolved exceptions.

Reconciliation must identify missing records, duplicate references, mismatched amounts, incomplete refunds, delayed payouts and unexplained differences between provider reports, internal accounting and relevant on-chain records.

For USDC transfers, reconcile internal operations against the expected Base transactions and contract events.

Do not assume that an on-chain transaction resolves the accounting for a separate off-chain payment or settlement obligation.

## 5.4 Merchant analytics

Provide:

- Gross transaction volume.
- Successful transaction count.
- Average transaction value.
- Failures and failure rate.
- Refunds and reversals.
- Fees.
- Net receipts.
- Settlement delays.
- Branch and staff performance where authorized.
- Relevant treasury and investment information.

Clearly distinguish collections, settled funds, available operating cash, business profit, investment holdings and USDC balances.

## 5.5 Business workflows

Build specialized workflows incrementally for retail, pharmacies, hospitality, fleets, transport, e-commerce and service businesses.

Potential features include branch reporting, payment links, deposits, refunds, driver or vehicle references, payout batches, collection allocations and order-to-payment references.

Validate demand before building industry-specific functionality beyond the core platform.

## 5.6 Developer experience

Provide versioned APIs, OpenAPI specifications, idempotency, signed webhooks, retries, status lookup, stable error codes, sandbox credentials, examples, changelogs and operational status information.

Public status pages must not disclose secrets, customer data or sensitive financial operations.

# 6. NAM Vault and USDC Vault Architecture

## 6.1 Separate product types

Do not treat all products called “vaults” as technically or legally identical.

Model product types explicitly, such as:

- A USDC holding or storage account.
- A smart-contract vault.
- A regulated investment product.
- A managed investment or fund product.
- A third-party savings or investment product.

Each product must state who controls the assets, what the customer owns, what returns may be available, what fees apply and how withdrawals work.

Do not market an ordinary USDC holding as a yield-generating investment unless there is a real, verified product that supports the claim.

## 6.2 On-chain USDC vaults

For a vault implemented on Base, document:

- The contract address and verified deployment.
- Supported asset contract.
- Deposit and withdrawal methods.
- Ownership and authorization model.
- Asset accounting and share accounting where applicable.
- Fee calculation.
- Withdrawal limits or delays.
- Emergency controls.
- Upgrade policy.
- Event definitions.
- Reconciliation and recovery.
- Security review and deployment sign-off.

Do not assume that all vault assets are liquid at all times. If assets are invested, lent, staked or subject to withdrawal restrictions, disclose the actual risks and conditions.

## 6.3 Vault accounting

For a custody or smart-contract vault, distinguish:

- Customer claims or balances.
- Actual USDC held by the relevant contract or custodian.
- Pending deposits.
- Pending withdrawals.
- Fees earned or payable.
- Assets deployed to an approved strategy, if any.
- Investment returns or losses, where applicable.
- Reconciliation differences.

The system must not issue an internal balance merely because a deposit was requested. Credit a deposit according to the verified funding and confirmation policy.

If a vault is a regulated investment product, use the applicable investment-provider records and accounting model rather than assuming a simple token balance is sufficient.

## 6.4 Funding and redemption

Use explicit state machines for deposits and withdrawals.

For a USDC deposit:

1. Create a deposit instruction.
2. Validate the intended chain and token.
3. Receive the transaction or funding event.
4. Verify the token contract, destination and amount.
5. Apply the confirmation policy.
6. Reconcile the transfer.
7. Credit the applicable internal or provider-backed record.
8. Update the vault state only when the relevant conditions are satisfied.

For a withdrawal:

1. Validate the user's authorization and eligibility.
2. Check the available balance and relevant restrictions.
3. Create a durable withdrawal request.
4. Apply risk and policy checks.
5. Submit the authorized transaction.
6. Track the on-chain or provider state.
7. Reconcile the outcome.
8. Update the internal records.

An ambiguous transaction must be investigated or queried before a potentially duplicative retry.

## 6.5 No implicit custody

Do not assume that AORA can custody customer funds or operate a particular investment model merely because it can deploy a smart contract.

Document the custody model, responsible legal entity, key control, contractual arrangements and regulatory requirements before enabling live vault deposits or withdrawals.

---

# 7. Shared Identity, Compliance and Authorization

## 7.1 Identity model

Distinguish:

- Natural person.
- Consumer account.
- Legal entity.
- Merchant workspace.
- Personal investor profile.
- Business investor profile.
- Authorized representative.
- Payment or wallet account.
- Product-specific role.

A person may act personally in CHIWO and on behalf of a company in KONY. These must not be conflated.

## 7.2 Access control

Implement server-side role-based access control, with attribute-based checks where needed.

A KONY cashier must not automatically be allowed to:

- View sensitive business investment information.
- Withdraw USDC.
- Change payout destinations.
- Authorize investment orders.
- Approve financing.
- Change administrator privileges.

Require appropriate step-up authorization for sensitive financial operations.

## 7.3 Compliance

Build configurable workflows for applicable KYC/KYB, sanctions screening, transaction limits, fraud monitoring, customer consent and suspicious-activity escalation.

For every launch jurisdiction, confirm the legal model for payment services, stablecoin transfers, custody, investment distribution, asset management, lending and cross-border transfers.

Do not assume that blockchain functionality eliminates regulatory obligations.

## 7.4 Consent

Maintain versioned records for:

- Payment authorization.
- Stablecoin transfers.
- Investment orders.
- Vault deposits and withdrawals.
- Investment mandates.
- Financing agreements.
- Business signatory authorization.

A consent record must identify the person, relevant legal capacity, action, time and applicable terms.

---

# 8. Ledger and Financial Accounting

## 8.1 Two complementary ledgers

Implement both:

**Internal accounting ledger**
- Double-entry accounting where applicable.
- Immutable posted journal entries.
- Explicit currency and precise monetary representation.
- Transaction lifecycle tracking.
- Fees and settlement accounting.
- Reversals and compensating entries.
- Pending operations and reconciliation.
- Domain-specific accounting references.

**Base on-chain ledger**
- Designated immutable on-chain financial records.
- USDC transfer records.
- Vault deposit and withdrawal events.
- Relevant smart-contract events.
- Transaction hashes and block references.
- Verifiable links to internal operations.
- Reconciliation evidence.

Not every internal event needs an individual blockchain transaction. Do not write personal data or unnecessary operational metadata on-chain.

Where appropriate, use transaction hashes or cryptographic commitments to provide verifiable evidence without publishing sensitive records.

Do not describe a database record as an on-chain transaction unless it actually exists on Base and has been verified.

## 8.2 Monetary representation

Never use binary floating-point arithmetic for financial calculations.

Use integer minor units or a suitable precise decimal representation for fiat amounts. Handle USDC using its verified token precision and exact integer token units.

Do not assume that every currency has two decimal places.

## 8.3 Reversals and corrections

Do not delete posted ledger entries or rewrite history to fix discrepancies.

Use documented compensating entries and linked reversal records.

An on-chain transaction cannot simply be erased. If a transaction is wrong or fraudulent, represent the subsequent corrective operation and preserve the original evidence.

## 8.4 Idempotency and unknown states

All financial write operations must support stable idempotency behavior.

A network timeout does not prove that the provider or blockchain rejected the transaction.

Query transaction status, inspect relevant chain data or reconcile before attempting a potentially duplicative action.

## 8.5 Reconciliation

Reconcile:

- Internal ledger entries.
- Payment-provider records.
- Bank and mobile-money settlement reports.
- Base transactions.
- Native USDC transfers.
- Vault contract events.
- Investment-provider records.
- KELO disbursements and repayments.

Differences must create explicit, auditable exceptions.

---

# 9. Payment, Blockchain and Investment Integrations

## 9.1 Payment adapters

Use provider-neutral adapters for local payment and banking integrations.

Each adapter must declare supported capabilities, error mappings, status inquiry behavior, webhook behavior and reconciliation support.

Never infer that a provider supports a capability because another provider does.

## 9.2 Base adapter

Create a dedicated Base integration module responsible for:

- Network configuration.
- Native USDC contract configuration.
- Transaction construction and submission.
- Transaction-status monitoring.
- Receipt and event verification.
- Contract interaction.
- Wallet integration.
- Confirmation policy.
- RPC failure handling.
- Reconciliation.
- Monitoring and incident reporting.

Use maintained libraries and verified network configuration.

Do not build a custom blockchain client unless a specific requirement justifies it.

## 9.3 USDC transfer handling

Validate every transaction against the intended chain, contract, recipient, amount and authorization.

Never accept a transaction hash alone as sufficient proof of the correct transfer.

Verify that the transaction corresponds to the intended asset and destination. Handle reverted transactions, insufficient gas, nonce conflicts, dropped transactions, delayed RPC responses and unexpected token transfers.

Do not automatically resubmit a transaction if the previous submission's status is unknown.

## 9.4 Investment-provider adapters

NAM adapters must support only the capabilities confirmed by the relevant provider, such as product catalogue, investor onboarding, funding instructions, orders, holdings, redemptions and reconciliation.

Use the authoritative provider or contract state to determine confirmed holdings.

A Base USDC transfer into an address is not automatically proof that a particular investment order has been accepted or allocated.

---

# 10. KONY and KELO Integration

## 10.1 Merchant provisioning workflow

Use a durable event-driven workflow backed by database transactions and a transactional outbox.

Illustrative events include:

- `kelo.merchant.created`
- `kelo.merchant.approved`
- `kony.workspace.provisioning_requested`
- `kony.workspace.provisioned`
- `kony.workspace.provisioning_failed`

These are proposed event names, not an instruction to publish unimplemented events.

Requirements:

- Idempotent provisioning.
- Canonical business identity.
- Duplicate detection.
- Administrator assignment.
- Tenant isolation.
- Retry and recovery.
- Status visibility.
- Safe migration for existing merchants.

## 10.2 Merchant financing

KONY may display financing eligibility and offers provided by KELO.

All offers must reflect the actual underwriting decision, approved financing terms and relevant provider records.

Do not represent available credit as settled cash or as a USDC balance.

## 10.3 Merchant treasury

KONY may provide treasury information for eligible business funds, including supported USDC holdings.

Clearly separate:

- Local collections.
- Unsettled proceeds.
- Confirmed external settlement.
- Internal accounting balances.
- USDC held in an authorized wallet or vault.
- Invested assets.
- Outstanding financing obligations.

Do not automatically convert collections to USDC or invest them without explicit authorization, a supported funding route and the required legal and operational controls.

---

# 11. Technical Stack and Repository Structure

## 11.1 Default stack

Use the following unless the existing repository or a documented architecture decision justifies another choice.

**Web**
- Next.js.
- React.
- TypeScript.

**Mobile**
- React Native and Expo where appropriate.

**Backend**
- NestJS.
- TypeScript.
- Versioned REST APIs.
- OpenAPI documentation.
- Explicit domain modules.

**Data**
- PostgreSQL.
- Prisma for standard data access.
- Reviewed SQL migrations and database constraints for financial invariants.
- Redis only where justified.
- Transactional outbox and durable workers.

**Blockchain**
- Base.
- Native USDC on Base.
- Maintained EVM-compatible libraries.
- Verified contract artifacts and deployment configuration.
- Appropriate wallet and signing infrastructure.

**Infrastructure**
- Managed cloud services where appropriate.
- Infrastructure as code.
- CI/CD.
- Secrets management.
- Centralized logs, metrics and traces.
- Backups and tested recovery procedures.

Do not introduce unnecessary microservices, blockchains, databases or infrastructure components without a demonstrated requirement.

## 11.2 Target repository

```text
Aora/
├── apps/
│   ├── chiwo-web/
│   ├── chiwo-mobile/
│   ├── kony-web/
│   ├── kony-mobile/
│   └── internal-ops/
├── services/
│   ├── api/
│   ├── worker/
│   └── webhook-ingress/
├── packages/
│   ├── ui/
│   ├── design-tokens/
│   ├── api-client/
│   ├── shared-types/
│   ├── validation/
│   ├── config/
│   ├── auth/
│   └── test-utils/
├── integrations/
│   ├── payments/
│   ├── mobile-money/
│   ├── banking/
│   ├── base/
│   ├── usdc/
│   ├── investment-providers/
│   ├── lending-providers/
│   ├── fx/
│   └── notifications/
├── contracts/
│   ├── src/
│   ├── test/
│   ├── script/
│   └── deployments/
├── infra/
├── docs/
│   ├── architecture/
│   ├── adr/
│   ├── api/
│   ├── compliance/
│   ├── operations/
│   └── product/
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── contract/
│   ├── e2e/
│   ├── financial-invariants/
│   └── failure-scenarios/
├── .github/
│   └── workflows/
├── .env.example
├── README.md
└── package.json
```

This is a target structure, not a requirement to create every directory immediately. Inspect the existing repository before changing its organization.

# 12. Security and Operational Reliability

## 12.1 Application security

- Server-side authorization.
- Tenant isolation.
- Secure session handling.
- Rate limiting.
- Input validation.
- Secrets management.
- Encryption in transit and at rest.
- Dependency scanning.
- Secure logging.
- Auditable administrative actions.
- Tested backups and recovery.

## 12.2 Blockchain security

- Never expose signing secrets.
- Separate development, staging and production keys.
- Apply appropriate access controls to signing infrastructure.
- Restrict contract deployment permissions.
- Verify network and contract configuration at startup.
- Monitor unusual transaction patterns.
- Alert on unexpected contract events and balance discrepancies.
- Establish a documented incident response process.
- Test recovery from compromised credentials and provider outages.

Emergency controls must be documented and must not introduce arbitrary, unaudited access to customer assets.

## 12.3 Monitoring

Monitor:

- API availability and latency.
- Worker failures and backlog.
- Payment initiation and completion.
- Provider outages.
- Unknown transaction states.
- Base RPC availability.
- Failed or reverted transactions.
- Pending transaction age.
- USDC transfer verification failures.
- Vault deposit and withdrawal failures.
- Reconciliation differences.
- Investment order and redemption delays.
- KELO-to-KONY provisioning failures.
- Unauthorized access attempts.

Maintain operational runbooks for local payment outages, Base RPC failures, stuck transactions, incorrect transfers, delayed investment withdrawals and reconciliation discrepancies.

---

# 13. Testing Requirements

## 13.1 Financial tests

Verify:

- Double-entry journal balance.
- Exact monetary calculations.
- Currency and token precision.
- Idempotent transaction processing.
- Correct reversal behavior.
- Accurate settlement accounting.
- Correct pending and unknown states.
- Reconciliation exception handling.
- Strict tenant isolation.

## 13.2 Base and USDC tests

Verify:

- Correct Base network configuration.
- Correct native USDC contract configuration.
- Rejection of unsupported token contracts.
- Correct amount and destination validation.
- Transaction receipt and event verification.
- Reverted transaction handling.
- Duplicate and delayed event handling.
- Unknown transaction recovery.
- Internal-to-on-chain reconciliation.
- Safe vault deposit and withdrawal state transitions.

Use a test network or controlled fork for relevant contract tests. Do not use production customer funds during development or testing.

## 13.3 NAM Vault tests

Verify:

- Funding confirmation is distinct from investment confirmation.
- Holdings use the authoritative provider or contract state.
- Withdrawals are not shown as complete before confirmation.
- Personal and business investor contexts remain separate.
- Unauthorized staff cannot initiate or approve investment transactions.
- Sandbox data cannot be mistaken for real funds or returns.
- Provider discrepancies create actionable exceptions.

## 13.4 KELO-to-KONY tests

Verify:

- A qualifying KELO merchant gets exactly one linked KONY workspace.
- Retries do not create duplicates.
- Existing merchants can be migrated safely.
- Failed provisioning can be recovered.
- The administrator is linked to the correct business.
- Restricted merchants remain restricted.
- One merchant cannot access another merchant's workspace.

---

# 14. Implementation Roadmap

## Phase 0 — Repository discovery

Inspect the repository, identify existing functionality, review architecture and dependencies, document gaps and propose the first vertical slice.

Do not rewrite working code without a demonstrated need.

## Phase 1 — Shared foundation

Implement identity, canonical business records, authorization, audit events, tenant boundaries, API conventions, database migrations and testing foundations.

## Phase 2 — KONY merchant workflow

Implement merchant onboarding, branches, roles, transaction history, a sandbox payment adapter, idempotent payment intents, webhook processing and basic reconciliation.

## Phase 3 — KELO-to-KONY provisioning

Implement the durable provisioning workflow, business linking, administrator assignment, retries, recovery, observability and migration for existing merchants.

## Phase 4 — Base and USDC foundation

Implement:

- Base network configuration.
- Native USDC token configuration.
- Wallet and signing architecture.
- Transaction submission and monitoring.
- Event verification.
- On-chain reconciliation.
- Test infrastructure.
- Security and operational documentation.

Do not enable live customer asset movement until the wallet model, provider arrangements, security review and applicable permissions are established.

## Phase 5 — Internal ledger and financial integration

Complete the double-entry ledger and link internal transactions to Base transaction records and relevant payment-provider records.

Establish reconciliation rules and failure-recovery behavior.

## Phase 6 — NAM Vault backend

Implement the investment and vault domain, product disclosures, funding and withdrawal state machines, holdings, provider interfaces and sandbox flows.

Keep custody and investment-provider assumptions explicit.

## Phase 7 — NAM Vault inside CHIWO

Implement consumer product discovery, funding, investment status, holdings and withdrawal or redemption workflows within CHIWO.

## Phase 8 — NAM Vault inside KONY

Implement business-investor contexts, permissions, supported funding, business holdings, redemption tracking and business reporting.

## Phase 9 — KONY commercial depth

Add advanced reconciliation, transparent pricing, refunds, settlement visibility, merchant analytics, payment links, developer APIs, financing visibility and validated vertical-specific workflows.

## Phase 10 — Production readiness and market expansion

Verify provider access, legal permissions, security reviews, operational support, reconciliation and launch readiness before enabling live financial functionality.

Expand into additional markets only after the relevant country, provider, commercial and regulatory requirements are validated.

---

# 15. Required Documentation

Maintain:

- `docs/architecture/master-development-brief.md`
- `docs/architecture/system-overview.md`
- `docs/architecture/domain-boundaries.md`
- `docs/architecture/financial-ledger.md`
- `docs/architecture/base-and-usdc.md`
- `docs/architecture/wallet-and-signing.md`
- `docs/architecture/nam-vault.md`
- `docs/architecture/merchant-provisioning.md`
- `docs/architecture/security-and-tenancy.md`
- `docs/architecture/country-provider-model.md`
- `docs/api/openapi.yaml`
- `docs/operations/reconciliation-runbook.md`
- `docs/operations/base-transaction-runbook.md`
- `docs/operations/vault-exception-runbook.md`
- `docs/operations/merchant-provisioning-runbook.md`
- `docs/compliance/market-readiness-template.md`
- `docs/product/kony-merchant-workflows.md`
- `docs/product/chiwo-consumer-workflows.md`
- `docs/product/nam-vault-experience.md`

Create architecture decision records for the ledger model, Base integration, native USDC policy, wallet and signing model, vault design, provider abstraction and KELO-to-KONY provisioning.

---

# 16. Definition of Done

A feature is complete only when:

- Its domain ownership is documented.
- Its data model and API contracts are defined.
- Authentication and authorization are enforced.
- Failure and unknown states are handled.
- Idempotency and retries are implemented where necessary.
- Financial records are auditable.
- Reconciliation is defined.
- Relevant tests pass.
- No secrets are committed.
- Logs and alerts are actionable.
- Documentation is updated.
- Existing functionality continues to work.
- Sandbox and live functionality are clearly distinguished.

For live blockchain or financial functionality, also verify contract and provider configuration, asset handling, applicable permissions, security review, reconciliation and operational readiness.

# 17. Instructions to Claude Code

Treat this document as the source of truth for AORA development.

Before writing code:

1. Inspect the existing `Aora/` repository.
2. Report what already exists and works.
3. Identify conflicts with this specification.
4. Propose the smallest safe implementation plan.
5. Identify unresolved provider, wallet, custody and regulatory assumptions.
6. Define tests and acceptance criteria for the first vertical slice.

During implementation:

- Preserve working functionality.
- Avoid unnecessary rewrites.
- Do not invent provider access or regulatory approvals.
- Do not fabricate financial transactions, holdings or investment returns.
- Do not store private keys in source code.
- Do not put sensitive customer information on-chain.
- Do not substitute bridged assets for native USDC.
- Do not introduce another blockchain or Bitcoin Lightning.
- Keep financial state transitions explicit.
- Write tests alongside financial functionality.
- Run relevant tests, linting and type checks.
- Document assumptions and unresolved issues.
- Report clearly what is implemented, what is mocked and what remains incomplete.

## First assignment

Begin with Phase 0.

Inspect the repository and produce a gap analysis against this specification. Identify the current framework, database, application structure, financial logic, integrations and test coverage.

Then propose the first vertical slice, including its data model, API contracts, migrations, tests and definition of done.

The recommended first slice is canonical business identity and reliable KELO-to-KONY merchant provisioning. Follow this with the KONY payment workflow, then the Base/USDC foundation, internal ledger integration and NAM Vault implementation.

Do not attempt to build the entire platform in one session.

The objective is to create an integrated customer experience supported by a financially correct and auditable platform. Base and USDC must be implemented as deliberate parts of that architecture, not as superficial additions to the user interface.

