# AORA — Open Questions

Unresolved decisions, spec conflicts and unverified assumptions. Check here before assuming anything.

- **Owner** is who decides: `Owner` (product/legal/commercial, yours to make) or `Eng` (engineering proposal, needs your approval only).
- **Blocks** uses the phase numbers in [delivery-plan.md](delivery-plan.md), with the brief's §14 number in brackets where they differ.
- The index shows each item's status. Rulings are recorded in [Owner rulings](#owner-rulings-2026-10-13); the original analysis below is kept for the record.
- Nothing in this file states a provider's API behaviour, limits or prices. Anything of that kind is marked **to verify**.

## Index

| ID | Question | Owner | Blocks | Status |
|---|---|---|---|---|
| [G-1](#g-1) | Phase 0 "repository discovery" on an empty repo | Eng | 0 | Resolved |
| [G-2](#g-2) | "Existing KELO merchants" and "safe migration" | Eng | 4 [3] | Resolved: backfill |
| [G-3](#g-3) | "Preserve working functionality" clauses | Eng | none | Resolved |
| [G-4](#g-4) | "Unless the existing repository justifies another choice" | Eng | 1 | Resolved |
| [G-5](#g-5) | §17 first assignment and gap analysis | Eng | 0 | Resolved |
| [G-6](#g-6) | §15 required documentation on day one | Eng | none | Resolved |
| [C-1](#c-1) | First vertical slice: brief §17 vs Phase 0 instruction | Owner | 1 | Resolved: money path first |
| [C-2](#c-2) | "Financial event anchoring" has no defined scope | Owner | 5 [4] | Resolved: batch commitments in `AnchorRegistry` (ADR 0015) |
| [C-3](#c-3) | Testnet config vs "no chain-selection abstraction" | Eng | 5 [4] | Resolved: Base Sepolia permitted |
| [C-4](#c-4) | USDC contract address provenance | Eng | 5 [4] | Resolved 2026-10-13 |
| [R-1](#r-1) | Ledger is built after the things that post to it | Eng | 1 | Resolved: approved |
| [R-2](#r-2) | No phase builds KELO | Owner | 4 [3], 11 | Resolved: approved; "qualifying" still open |
| [R-3](#r-3) | No phase builds CHIWO | Owner | 9 [7] | Resolved: approved |
| [R-4](#r-4) | Outbox and workers are needed before Phase 3 | Eng | 1 | Resolved: approved |
| [R-5](#r-5) | Pricing data and developer API conventions arrive in Phase 9 | Eng | 3 [2] | Open |
| [R-6](#r-6) | On-chain reconciliation precedes the ledger | Eng | 5 [4] | Open |
| [R-7](#r-7) | No phase says when user interfaces are built | Owner | 3 [2] | Open |
| [R-8](#r-8) | No phase owns internal ops tooling | Eng | 3 [2] | Open |
| R-9 | Collection points with parent and child (lessons §3) are not in mvp-scope 3A; Phase 3 builds branches and an attribution reference only | Owner | 4 | Open: confirm they belong with the multi-rail phase |
| [D-1](#d-1) | Custody model | Owner | 5 [4], 7 [6] | Open; testnet interim ruling |
| [D-2](#d-2) | Wallet and signing provider | Owner | 5 [4] | Open; testnet interim ruling |
| [D-3](#d-3) | Local payment provider for sandbox | Owner | 3 [2] | MVP: Daraja sandbox + simulator |
| [D-4](#d-4) | Legal entity and licence per product | Owner | 3 [2], 13 [10] | Open |
| [D-5](#d-5) | Credit licence or lending partner | Owner | 11 | Open |
| [D-6](#d-6) | Authentication and step-up mechanism | Owner | 1 | Resolved: Clerk (ADR 0011, 0019); PIN step-up kept |
| [D-7](#d-7) | Canonical business identifier and duplicate rule | Owner | 1 | Resolved: ADR 0012 |
| [D-8](#d-8) | KYC/KYB provider and tier limits | Owner | 3 [2] | Open |
| [D-9](#d-9) | Hosting region and data residency | Owner | 1 (deploy), 13 [10] | Hosting decided: Vercel + Neon, Frankfurt (ADR 0013). Residency question open |
| [D-10](#d-10) | NAM product types and investment provider | Owner | 7 [6] | Open |
| [D-11](#d-11) | Base RPC provider | Owner | 5 [4] | Open |
| [E-1](#e-1) | Tenant isolation mechanism | Eng | 1 | Resolved: approved |
| [E-2](#e-2) | How sandbox records are labelled | Eng | 1 | Resolved: approved |
| [E-3](#e-3) | Node, TypeScript and test-runner versions | Eng | 1 | Resolved at checkpoint 1A |
| [E-4](#e-4) | Read-only mainnet fork under the sandbox-only rule | Owner | 5 [4] | Open |
| [M-1..M-7](#m-flags-raised-by-the-mvp-definition) | Flags raised by the MVP definition | mixed | various | Resolved 2026-10-13 (second ruling) |
| [O-1..O-13](#o-owner-defaults-and-questions-from-the-kelo-and-hosting-rulings) | Owner defaults, and new questions from the KELO, hosting, Clerk and Resend rulings | Owner | various | O-1 to O-4 decided; O-10 decided with a terms caveat; others open |
| [X-1..X-12](#x-requirements-that-cannot-be-tested-without-external-access) | Requirements that cannot be tested without external access | mixed | various | Open |

## Owner rulings (2026-10-13)

- **Phase 0 approved.** ADRs 0001–0008 accepted. ADR 0012 accepted. ADRs 0009, 0010, 0011 remain pending.
- **G-1 to G-6:** greenfield readings accepted with Phase 0.
- **C-1:** money-path slice first; provisioning follows in its own phase.
- **C-2 (MVP):** AORA smart contracts are out of MVP scope, so there is no anchoring in the MVP. The production question stays open.
- **C-3:** Base Sepolia is the test network; testnet transactions are permitted and labelled sandbox (CLAUDE.md rule 10 amended). Mainnet remains forbidden.
- **C-4:** both USDC addresses verified against Circle's documentation on 2026-10-13; provenance in ADR 0005.
- **R-1, R-4:** ledger core and outbox move into Phase 1.
- **R-2, R-3:** minimal KELO merchant domain added to the provisioning phase; CHIWO consumer core and KELO credit core phases added. *Still open under R-2:* which KELO state counts as "qualifying". Assumed: one explicit `approved` state.
- **E-1:** row-level security as a second tenant barrier.
- **E-2:** `mode` column on every tenant and financial record; only `sandbox` permitted.
- **E-3:** Vitest unless it fails checkpoint 1A, then Jest without asking; outcome recorded in ADR 0001. *Outcome: Vitest works with NestJS; no switch.*
- **D-3 (MVP):** Safaricom Daraja sandbox for M-Pesa collection and B2C payout; AORA simulator elsewhere. Provider behaviour is verified from documentation in the phase that integrates it.
- **D-6 (MVP):** sandbox authenticator in Phase 1; phone number plus SMS one-time code through an SMS provider sandbox, and a transaction PIN for step-up, behind an `AuthProvider` interface. Production choice open (ADR 0011).
- **D-7:** unregistered sole traders are in scope; rule in ADR 0012.
- **D-1, D-2 (testnet only):** signer interface backed by a local development signer with a testnet key from `.env.local`, forbidden outside sandbox and enforced at startup. Production decisions remain open.

New items raised by the MVP definition are in section [M](#m-flags-raised-by-the-mvp-definition).

## Owner rulings (2026-10-13, second set)

- **Phase 1 approved.** Tests are written strictly first for ledger invariants, state machines, idempotency, tenant isolation and every smart contract.
- **Hosting:** Vercel plus Neon (ADR 0013). This answers the hosting half of D-9; whether Frankfurt satisfies Kenyan data-protection rules is still open.
- **Scope:** native mobile apps, four real rails and AORA smart contracts join the MVP (ADRs 0014, 0015, 0016). C-2 is resolved by the anchoring registry.
- **KELO** is a consumer BNPL marketplace with a merchant side (brief amendment; ADRs 0017, 0018). R-2's open point is settled: a store whose vetting is approved is "qualifying".
- **SMS provider:** Africa's Talking. Credentials not yet provided.
- **The fixed sign-in code** must be impossible on a deployed environment, enforced by a startup check and a test.
- **M-1:** approved, adapted. Deployed environments keep secrets in Vercel environment variables marked sensitive. A testnet key in `.env.local` is allowed only for the local sandbox signer on the owner's machine.
- **M-2:** approved. API keys stored as hashes only; webhooks signed with a platform key pair held in the secret store.
- **M-3, M-4:** approved as labelled sandbox assumptions. They decide nothing about production custody.
- **M-5, M-6, M-7:** proposed readings accepted. Credit stays behind its flag; conversion is simulator-only and labelled; provider behaviour comes only from current documentation.
- **ADR 0011** (production authentication): still pending.

---

## G. Reading the brief for a greenfield repository

The brief was written as if code, a KELO system and merchants already exist. None do. These items propose how to read each such passage. The brief itself is unchanged.

### G-1

**Phase 0 "Repository discovery" (§14) and "Inspect the existing `Aora/` repository… report what already exists and works" (§17 steps 1–3).**

- **Why it matters:** there is nothing to discover. Read literally, Phase 0 is empty and has no exit criteria.
- **Options:** (a) skip Phase 0; (b) read it as "bootstrap and planning": clean the spec, review it, propose ADRs and a delivery plan, create the minimum scaffold.
- **Recommendation:** (b). This is what CLAUDE.md already calls the phase. The "gap analysis" becomes this file plus the delivery plan: the gap is everything.
- **Blocks:** Phase 0.

### G-2

**"Existing KELO merchants must be eligible for safe linking or migration" (§4.5), "Safe migration for existing merchants" (§10.1), "migration for existing merchants" (§14 Phase 3), "Existing merchants can be migrated safely" (§13.4).**

- **Why it matters:** there are no KELO merchants and no KELO system. A literal migration has no source data, so it cannot be built or tested. But the requirement hides a real one: provisioning must work for merchants that existed before the trigger did.
- **Options:**
  - (a) Drop the requirement.
  - (b) Read it as a **backfill**: an idempotent, re-runnable job that finds any qualifying KELO merchant without a linked KONY workspace and runs it through the same provisioning workflow as the event path.
  - (c) Build an importer for an assumed external KELO system.
- **Recommendation:** (b). It is testable today (seed a KELO merchant with the outbox event suppressed, run the backfill, assert exactly one workspace). It also covers real future cases: merchants approved while provisioning was down, and bulk onboarding. Reject (c): it would invent a system. If a legacy KELO book ever appears, that is a new, separately scoped import.
- **Blocks:** Phase 4 [3].

### G-3

**"Do not rewrite working code without a demonstrated need" (§14 Phase 0), "Preserve working functionality", "Avoid unnecessary rewrites" (§17), "Existing functionality continues to work" (§16).**

- **Why it matters:** vacuous today, but they become real after the first approved phase.
- **Recommendation:** read as a **forward-looking regression rule**: from Phase 1 on, the full test suite of every approved phase must pass before a later phase can exit. No action in Phase 0. CLAUDE.md's definition of done omits the §16 clause; add "tests from earlier phases still pass" to it when Phase 1 is approved.
- **Blocks:** nothing.

### G-4

**"Use the following unless the existing repository or a documented architecture decision justifies another choice" (§11.1); "Inspect the existing repository before changing its organization" (§11.2).**

- **Why it matters:** with no repository, the default stack applies in full and only an ADR can change it.
- **Recommendation:** adopt §11.1 as written (Next.js, React Native/Expo, NestJS, PostgreSQL, Prisma). ADRs 0001–0008 work within it. §11.2 is a target tree; directories are created only when a phase needs them (CLAUDE.md "smallest working slice").
- **Blocks:** Phase 1.

### G-5

**§17 "First assignment": "produce a gap analysis… Identify the current framework, database, application structure, financial logic, integrations and test coverage."**

- **Recommendation:** treat as satisfied by Phase 0 output. Current framework, database, financial logic, integrations and test coverage are all "none". The slice definition it asks for is in [delivery-plan.md](delivery-plan.md) §3.
- **Blocks:** Phase 0.

### G-6

**§15 "Maintain" nineteen documents, most of which describe systems that do not exist.**

- **Why it matters:** writing them now would be speculative prose that drifts from the code.
- **Recommendation:** each document is created in the phase that first builds its subject, as part of that phase's exit criteria (mapped in the delivery plan). §15's ADR list is covered by `docs/adr/0003`–`0010`; "vault design" is deferred to Phase 7 [6] because it depends on [D-1](#d-1) and [D-10](#d-10).
- **Blocks:** nothing.

---

## C. Conflicts and undefined scope

### C-1

**First vertical slice.** Brief §17 recommends "canonical business identity and reliable KELO-to-KONY merchant provisioning" first, then the KONY payment workflow. The Phase 0 instruction asks for a slice through identity → tenant → ledger → sandbox payment intent → webhook → reconciliation.

- **Why it matters:** CLAUDE.md says the brief wins on conflict and that conflicts are recorded, not silently resolved. The brief's wording is a recommendation ("recommended first slice"), not a rule, so I have proceeded with the instructed slice and am flagging it rather than stopping.
- **Options:** (a) brief's slice: identity + provisioning first; (b) instructed slice: money path first, provisioning in Phase 4.
- **Recommendation:** (b). Provisioning-first needs a KELO merchant domain that no phase builds ([R-2](#r-2)), and it exercises no financial invariant. The money path proves the hardest things early: ledger balance, idempotency, unknown states, tenant isolation, reconciliation. Canonical business identity is still in the slice, so provisioning later reuses it.
- **Needs from you:** confirm (b), or tell me to revert to (a).
- **Blocks:** Phase 1.

### C-2

**"Financial event anchoring" and "immutable on-chain financial records" (§1, §3.1, §8.1) have no defined scope.** The brief says Base holds "designated" records but never designates which, in what form, or through which contract.

- **Why it matters:** this decides whether AORA writes and deploys its own contracts at all. An anchoring contract is permanent, costs gas per write, needs a security review (§3.7), and carries privacy risk even for hashes (§3.6, CLAUDE.md rule 8). Without it, the on-chain scope is only USDC transfers and vault interactions, and Phase 5 [4] needs no AORA contract.
- **Options:**
  - (a) No anchoring. On-chain evidence = the USDC transfers and vault events that happen anyway, linked to internal operation IDs.
  - (b) Periodic batch commitment: one Merkle root of a ledger period per transaction. No per-customer data on-chain.
  - (c) Per-operation anchoring of each financial event.
- **Recommendation:** (a) for the first build; revisit (b) only if a regulator, auditor or partner asks for independent tamper-evidence. Reject (c): highest cost and the highest linkability risk for no stated benefit.
- **Blocks:** Phase 5 [4] scope; decides whether ADR 0006's toolchain is used before Phase 7 [6].

### C-3

**§3.1 forbids "multiple blockchain backends or chain-selection abstractions"; CLAUDE.md rule 10 forbids Base mainnet; §13.2 requires "a test network or controlled fork".**

- **Why it matters:** development must target a Base test network, which has a different chain ID and a different USDC address from mainnet. That must not turn into a chain-selection feature.
- **Recommendation:** one Base adapter with **environment-specific static config** (network identity, chain ID, USDC address, decimals, confirmation policy). The config is selected by deployment environment, never by a request, user or tenant. Sandbox environments contain a testnet entry only; a mainnet entry is not added to the repository until Phase 13 [10]. See ADR 0004 and 0005. Which Base test network is current: **to verify**.
- **Blocks:** Phase 5 [4].

### C-4

**The USDC address in §3.2 cited a source through a stray tag (now removed).** The address is in the brief, but its provenance is not checkable from the repository.

- **Why it matters:** a wrong token address is the single most damaging config error in this system.
- **Recommendation:** before any address enters chain config, verify it against Circle's primary documentation, record the source URL, the date and who verified it next to the value, and verify it again at startup against the chain (ADR 0005). Treat the value in the brief as unverified until then. Same procedure for the testnet USDC address, which the brief does not give: **to verify**.
- **Blocks:** Phase 5 [4].

---

## R. Roadmap contradictions and ordering problems

### R-1

**(a) The internal ledger is Phase 5, but payment intents, webhook processing and reconciliation are Phase 2.**

- **Why it matters:** yes, the ledger must come first. §4.1 step 7 records every transaction in the internal ledger. §8.5 reconciliation compares provider records against "internal ledger entries", so Phase 2 "basic reconciliation" has nothing to reconcile against. CLAUDE.md rule 4 makes the ledger mandatory. Building payment intents first means a balance column on a payments table, then a risky retrofit of history into journals. Phase 5's wording ("*Complete* the double-entry ledger") implies it was started earlier, but no earlier phase starts it.
- **Options:**
  - (a) Keep the order; Phase 2 keeps its own transaction table and Phase 5 back-posts.
  - (b) Move the whole of Phase 5 ahead of Phase 2.
  - (c) Split Phase 5: **ledger core** (accounts, journals, postings, immutability, balance invariant, idempotent posting, compensating entries, asset precision) moves into Phase 1–2; what remains of Phase 5 is **financial integration** (linking journals to Base transactions and provider records, full reconciliation rules, failure recovery) and stays after the Base phase.
- **Recommendation:** (c). Ledger core has no external dependency and is the most test-first part of the system. Everything that moves money posts to it from its first commit.
- **Blocks:** Phase 1 scope.

### R-2

**(b) KELO-to-KONY provisioning (Phase 3) needs a KELO merchant domain, but no phase builds KELO.** Nothing in §14 delivers §2.3 (applications, underwriting, offers, disbursement, repayment) or lessons §4 (explainable limits, graduated credit, cost-of-credit disclosure).

- **Why it matters:** provisioning is triggered by "a qualifying merchant is created or approved in KELO". Without a KELO record and approval state there is no trigger, no "qualifying" rule and nothing to link. Separately, KELO credit, which the competitive research identifies as where the margin is, has no place in the roadmap at all.
- **Options:**
  - (a) Fake the trigger with a hand-inserted event.
  - (b) Build a **minimal KELO merchant domain** in the provisioning phase: merchant record, link to canonical business, an explicit approval state machine, and the outbox event on approval. No credit logic.
  - (c) Build full KELO credit before provisioning.
- **Recommendation:** (b) for provisioning, plus a new **KELO credit core** phase after financial integration (delivery plan Phase 11). Credit needs the ledger, the payments flow (repayment from inflows) and a legal basis ([D-5](#d-5)); it stays behind a feature flag, as lessons §4 requires.
- **Needs from you:** approve adding a KELO credit phase, and define "qualifying" (which KELO state triggers a workspace: created, KYB-passed, or credit-approved?). Until you do, I assume "approved" is a single explicit KELO state.
- **Blocks:** Phase 4 [3] (trigger definition); Phase 11 (new).

### R-3

**No phase builds CHIWO.** Phase 7 puts NAM Vault "inside CHIWO", but nothing delivers §2.1 or §4.1: consumer registration, consumer accounts, consumer payments, USDC transfers.

- **Why it matters:** same defect as R-2. Phase 7 has no host application and no consumer identity to attach an investor profile to.
- **Options:** (a) fold consumer basics into Phase 7; (b) add a **CHIWO consumer core** phase before it; (c) defer CHIWO and NAM-in-CHIWO until KONY is validated.
- **Recommendation:** (b) in the plan, sequenced after KONY payments and Base. Whether CHIWO should be built before merchant validation at all is a product call, so (c) is worth your consideration: the research and CLAUDE.md both say Kenya merchants first.
- **Blocks:** Phase 9 [7].

### R-4

**Transactional outbox and durable workers first appear in Phase 3 (§10.1), but Phase 2 webhook processing already needs them.**

- **Why it matters:** a webhook must be acknowledged quickly and processed exactly-once in effect. Without a durable queue the handler does financial work inline, and a crash between "payment marked succeeded" and "journal posted" loses money silently.
- **Recommendation:** build the outbox table and one worker loop in Phase 1, used first by webhook processing. Provisioning reuses it unchanged (ADR 0008).
- **Blocks:** Phase 1.

### R-5

**Phase 9 holds "transparent pricing", "refunds" and "developer APIs", but lessons §1 and §6 make parts of these structural from the first payment.**

- **Why it matters:** fees shown "after every collection" need a tariff version on the first collection. Idempotency keys, stable error codes, signed webhooks and status lookup are conventions; retrofitting them is an API-breaking change. Refunds are compensating ledger entries, which the ledger core must support from day one even if the refund workflow comes later.
- **Recommendation:** split by kind.
  - Conventions (idempotency keys on financial POSTs, error-code scheme, `/v1`, OpenAPI as source of truth, status lookup): Phase 1.
  - Versioned tariff tables and "tariff version applied" on each collection: Phase 3 [2].
  - Refund workflow, payment links, public developer portal, status page, analytics, tiered pricing UI: remain in Phase 12 [9].
- **Blocks:** Phase 3 [2].

### R-6

**Phase 4 includes "on-chain reconciliation", but the ledger it reconciles against is Phase 5.**

- **Recommendation:** resolved by R-1(c). Phase 5 [4] reconciles observed chain state against chain-operation records; the new Phase 6 [5] links both to journals.
- **Blocks:** Phase 5 [4].

### R-7

**§14 never says when a user interface is built.** §11.2 lists five apps; "KONY merchant workflow" could mean API or screens.

- **Why it matters:** UI roughly doubles Phase 3 [2], and CLAUDE.md rule 10 requires every sandbox *screen* to be labelled, which only matters once screens exist.
- **Options:** (a) API-only through Phase 6, UIs after; (b) a thin `kony-web` in Phase 3 [2]; (c) full web and mobile per phase.
- **Recommendation:** (a) for Phase 1, (b) from Phase 3 [2]: one merchant-facing web app, enough to demonstrate the flow to a real merchant. Mobile waits for validated demand.
- **Blocks:** Phase 3 [2] sizing.

### R-8

**No phase owns internal operations tooling**, although §4.5 step 9, §5.3 and §8.5 require support staff to see provisioning status and act on reconciliation exceptions.

- **Recommendation:** each phase ships the operator **API** for what it builds (list, inspect, resolve with an audited reason), under a platform-operator role. An `internal-ops` UI is added when the exception volume justifies it.
- **Blocks:** Phase 3 [2] onward (as exit criteria, not a separate phase).

---

## D. Decisions that are yours to make

### D-1

**Custody model.** Who legally and technically controls customer USDC and merchant fiat balances. Detail in [ADR 0010](../adr/0010-custody-model.md).

- **Why it matters:** it determines the licences AORA needs, what the ledger's liability accounts mean, whether AORA holds keys, and how recovery works. §6.5 forbids assuming AORA can custody.
- **Options:** non-custodial (customer holds keys); AORA custodial; third-party licensed custodian; hybrid by product.
- **Recommendation:** engineering preference is a third-party licensed custodian or non-custodial model for USDC, so AORA does not hold customer keys in the first build. This is a legal and commercial decision; I am not choosing it.
- **Blocks:** Phase 5 [4] (anything that signs); Phase 7 [6] entirely. Does **not** block Phases 1–4.

### D-2

**Wallet and signing provider.** Detail in [ADR 0009](../adr/0009-wallet-and-signing.md).

- **Why it matters:** §3.8 lists eight questions (key control, recovery, merchant signatories, fee payer…) that only a selected model can answer, and forbids inventing provider capabilities.
- **Options:** externally owned user wallets; embedded/MPC wallet provider; smart accounts; AORA-operated keys in an HSM/KMS; custodian API.
- **Recommendation:** decide D-1 first; it removes most options. No vendor is proposed.
- **Blocks:** Phase 5 [4] transaction submission. Read-only work (config, transfer verification, state machine, tests on a local chain with throwaway test keys) can proceed without it.

### D-3

**Local payment provider for the sandbox.**

- **Why it matters:** the adapter interface (ADR 0007) should be shaped by one real provider's behaviour early, or it will be shaped by guesses. CLAUDE.md rule 11 forbids guessing.
- **Options:**
  - (a) AORA-owned simulator only: an in-repo sandbox adapter with deterministic triggers for success, failure, timeout, duplicate and late webhooks.
  - (b) A mobile-money operator's own developer sandbox.
  - (c) A licensed aggregator's sandbox covering several rails.
- **Recommendation:** (a) for Phase 1; it needs no external access and tests every unknown-state path on demand. Choose (b) or (c) before Phase 3 [2] exits, so a second, real adapter proves the interface. Which providers offer a sandbox, what it supports and on what terms: **to verify**; I will not state it from memory.
- **Needs from you:** which provider(s) you have, or can get, sandbox credentials for.
- **Blocks:** Phase 3 [2] exit. Not Phase 1.

### D-4

**Legal entity and licence per product** (CHIWO payments, KONY acceptance and settlement, KELO credit, NAM investments, USDC activity).

- **Why it matters:** it decides which entity is the counterparty on consent records and disclosures (§7.4), who holds merchant funds between collection and payout (lessons §2 requires every balance view to name the controlling entity), and whether AORA is the payment service provider or an agent of a licensed partner. The ledger's chart of accounts differs between those models.
- **Options:** one entity for everything; one entity per regulated activity; partner-led (licensed partners hold funds and licences, AORA is the technology layer) with own licences later.
- **Recommendation:** model `legal_entity` as data from Phase 1 so that consent, disclosures and ledger accounts reference an entity ID rather than a constant. Then the choice does not block engineering until Phase 3 [2] (merchant funds flow). The choice itself, and Kenya's current requirements for payments, virtual assets, investments and lending, are for you and counsel: **to verify**.
- **Blocks:** Phase 3 [2] (funds-flow model and chart of accounts); Phase 13 [10].

### D-5

**Credit licence or lending partner.**

- **Why it matters:** lessons §4 says credit products need a licence or a licensed partner and must stay behind feature flags until the legal model is confirmed. The research notes long licensing queues (context only, not verified here).
- **Options:** apply for AORA's own licence; originate through a licensed partner (KELO as "authorized lender integration", §2.3); both, partner first.
- **Recommendation:** engineering can build KELO credit provider-neutral behind a lender adapter, so either works. Decide before Phase 11 planning. Not needed for Phase 4 [3] provisioning.
- **Blocks:** Phase 11.

### D-6

**Authentication and step-up mechanism.**

- **Why it matters:** this blocks Phase 1 directly. §2.1 makes the phone number an identifier but "not sufficient authentication"; CLAUDE.md rule 12 requires step-up for sensitive actions. Options differ in cost, in who stores credentials, and in SIM-swap exposure.
- **Options:**
  - (a) Self-built: AORA stores credential verifiers, issues sessions, implements OTP and passkeys.
  - (b) Self-hosted open-source identity server.
  - (c) Managed identity provider.
- **Recommendation:** keep the *identity domain* (person, account, business, membership, roles) in AORA's database whatever you choose; put only *authentication* behind an interface. For Phase 1 use a sandbox authenticator (fixed test users, a simulated second factor, clearly labelled) so the slice proves the step-up *policy* without a provider. Engineering preference for production is (b) or (c) over (a): credential storage is not where AORA should take risk. SMS OTP delivery needs a provider and has SIM-swap risk; passkeys or app-based factors are stronger. Vendor choice is yours.
- **Blocks:** Phase 1 exit for real authentication; the slice itself can run on the sandbox authenticator.

### D-7

**Canonical business identifier and duplicate rule.**

- **Why it matters:** §4.5 step 1 "resolve or create the canonical AORA business identity" and §10.1 "duplicate detection" need a rule for "same business". Sole traders and informal micro-merchants, the research's target segment, may have no company registration.
- **Options:** government registration number; tax PIN; owner's national ID plus trading name; tiered (whatever the KYB tier provides).
- **Recommendation:** a business has an internal immutable ID plus a set of typed external identifiers (`type`, `country`, `value`), unique per type and country. Duplicate detection matches on any verified identifier; ambiguous matches go to manual review, never auto-merge. Which identifier types exist in Kenya and which are mandatory per tier: yours and counsel's, **to verify**.
- **Blocks:** Phase 1 (schema shape is safe now; the mandatory set is needed before Phase 3 [2] onboarding).

### D-8

**KYC/KYB provider and tier limits** (lessons §7, tiered onboarding).

- **Recommendation:** stub behind an adapter with a sandbox implementation; tier limits are versioned configuration. Provider and limit values are yours.
- **Blocks:** Phase 3 [2] exit.

### D-9

**Hosting region and data residency.**

- **Why it matters:** it constrains the cloud provider and region, backups and log storage. Kenya's data-protection requirements on cross-border transfer: **to verify** with counsel.
- **Recommendation:** nothing is deployed in Phase 1 (local and CI only), so decide before the first shared environment.
- **Blocks:** first deployment; Phase 13 [10].

### D-10

**NAM product types and investment provider.** §6.1 lists five product types that differ legally and technically.

- **Recommendation:** decide which single product type is first. A plain USDC holding is the simplest; anything yield-bearing needs a verified product and provider (§6.1).
- **Blocks:** Phase 7 [6].

### D-11

**Base RPC provider** and whether a second provider is required for independent verification.

- **Recommendation:** two independent providers for anything that credits a balance, since one RPC endpoint is a single source of truth that can be wrong. Vendor choice and pricing are yours: **to verify**.
- **Blocks:** Phase 5 [4].

---

## E. Engineering proposals needing your approval

### E-1

**Tenant isolation mechanism.**

- **Options:** application-level scoping only; PostgreSQL row-level security (RLS) with a per-transaction tenant setting; schema or database per tenant.
- **Recommendation:** every tenant-owned row carries `tenant_id`; scoping is enforced in the data-access layer **and** by RLS as a second barrier, with isolation tests that try to cross tenants. How Prisma interacts with per-transaction settings and RLS must be proven in a Phase 1 spike before it is relied on: **to verify**. See ADR 0002.
- **Blocks:** Phase 1.

### E-2

**How "every sandbox record is visibly labelled" (CLAUDE.md rule 10) is implemented.**

- **Options:** (a) environment-level only (a sandbox deployment is all sandbox); (b) a non-null `mode` column (`sandbox` | `live`) on every financial and tenant record, plus an environment guard.
- **Recommendation:** (b). Lessons §6 wants a sandbox that behaves like production, which eventually means sandbox and live credentials for the same merchant. A column costs little now and is very expensive to add later. Until Phase 13 [10], a database constraint allows only `sandbox`, and every API response and screen carries the label.
- **Blocks:** Phase 1 (schema).

### E-3

**Runtime and tool versions.** Found during the scaffold:

- The development machine has Node 20.19.2, which is past its end-of-life date. The scaffold targets **Node 24 (LTS)** via `.nvmrc`, `engines` and CI. You need to install it locally (`nvm install`).
- TypeScript is pinned to the **6.0** line, not 7.x: the current `typescript-eslint` declares support for TypeScript `<6.1.0`. Revisit when the linter supports 7.
- Test runner is **Vitest**. NestJS dependency injection relies on decorator metadata, which Vitest's default transform does not emit; a compiler plugin is needed. This is unproven in this repo and must be the first thing Phase 1 checks. Fallback: Jest.
- **Blocks:** Phase 1 (first hour).

### E-4

**Is a read-only fork of Base mainnet allowed under "sandbox only"?** §13.2 permits "a controlled fork"; CLAUDE.md rule 10 says do not connect to live providers.

- **Why it matters:** a local fork reads real chain state (for example, the real USDC contract's behaviour) but moves no real funds and sends nothing to mainnet.
- **Recommendation:** allow read-only forking in tests from Phase 5 [4], with no signing key that has ever held mainnet funds. Needs your explicit yes, since it touches a hard rule.
- **Blocks:** Phase 5 [4] test design.

---

## X. Requirements that cannot be tested without external access

Each of these is required by the spec but cannot be proven from inside this repository. Until access exists, each is covered by an AORA-owned simulator or stub and reported as **mocked**, never as working.

| ID | Requirement (source) | What is missing | Interim approach | Blocks |
|---|---|---|---|---|
| X-1 | Real mobile-money and bank adapter behaviour: initiation, callbacks, status inquiry, reversal, error codes (§9.1) | Provider sandbox credentials and documentation; a public callback URL | AORA simulator adapter; adapter contract tests ready to run against a real sandbox | 3 [2] exit |
| X-2 | Reconciliation against provider settlement reports (§5.3, §8.5) | Real report formats and delivery method: **to verify** | Simulator-generated report in an AORA-defined format | 3 [2], 6 [5] |
| X-3 | Provider webhook authenticity (§5.6; signature scheme, source addresses) | Provider documentation: **to verify** | AORA's own signing scheme for the simulator; real schemes implemented per adapter later | 3 [2] |
| X-4 | Provider fees, free bands, caps, limits (lessons §1) | Current published tariffs and contract terms: **to verify** | Tariff tables populated with obviously fake sandbox values | 3 [2] |
| X-5 | Base testnet behaviour: RPC availability, confirmation and finality policy, reorg handling, dropped and replaced transactions (§3.4, §9.3, §13.2) | RPC provider account; testnet funds; verified testnet USDC address | Local development chain with a test token for deterministic tests; testnet runs once D-11 is decided | 5 [4] |
| X-6 | Wallet, signing and recovery flows (§3.8) | Provider selection and sandbox ([D-2](#d-2)) | Signer interface with a local test-key signer on a local chain only | 5 [4] |
| X-7 | KYC/KYB checks and sanctions screening (§7.3) | Provider access ([D-8](#d-8)) | Sandbox adapter with scripted outcomes | 3 [2] |
| X-8 | OTP delivery and SIM-swap safeguards (§2.1) | Messaging provider; any operator SIM-swap check: **to verify** that one exists | Sandbox authenticator ([D-6](#d-6)) | 1 exit (real auth) |
| X-9 | Investment-provider catalogue, orders, holdings, redemptions (§9.4) | Provider selection ([D-10](#d-10)) | Not started | 7 [6] |
| X-10 | FX rates and fiat↔USDC conversion (§3.3) | Approved conversion provider and legal model | Not started; conversion flows stay disabled | 6 [5]+ |
| X-11 | Independent security review, audited contracts, tested backups and recovery, infrastructure as code (§3.7, §12) | Auditor engagement; cloud account ([D-9](#d-9)) | Not started | 13 [10] |
| X-12 | This repository's own CI workflow | It only runs on GitHub after a push | Same commands run locally; workflow is unproven until the first push | 0 (flagged in report) |

Legal confirmations (§7.3 "for every launch jurisdiction, confirm the legal model…") are also external and are tracked under [D-4](#d-4) and [D-5](#d-5).

---

## M. Flags raised by the MVP definition

The MVP definition (owner, 2026-10-13) was checked against the brief and CLAUDE.md. These points conflict with, or stretch, a written rule. None is resolved silently; each has a proposed reading that I am following until told otherwise. Detail in [mvp-scope.md](../product/mvp-scope.md) §4.

| ID | Flag | Rule it touches | Proposed reading | Owner | Blocks |
|---|---|---|---|---|---|
| M-1 | The testnet signer key is kept in `.env.local`, and staging needs it too | CLAUDE.md rule 9; brief §3.8 ("never… plaintext configuration") | Permitted for a testnet-only key by the owner's ruling. Locally: `.env.local`. In staging: injected from the platform's secret store, not a file. Startup refuses it outside sandbox and off Base Sepolia | Owner | 5 |
| M-2 | Developer API keys and webhook signing secrets would be stored in the database | CLAUDE.md rule 9 ("API keys… never in database fields") | Read rule 9 as covering usable secrets. AORA-issued API keys are stored as hashes only and shown once. Outbound webhooks are signed with a platform key pair held in the secret store, so no per-merchant secret is stored | Owner | 3 |
| M-3 | One AORA-controlled testnet wallet holds every customer's USDC | Brief §6.5 (no implicit custody); ADR 0010 pending | Sandbox convenience only, labelled on every balance view. Decides nothing for production. Per-customer receive addresses need a design in the Phase 5 plan | Owner | 5 |
| M-4 | B2C payouts and settlement views imply AORA holds merchant fiat | ADR 0010 fiat options F1–F3 undecided; D-4 | Sandbox chart of accounts assumes an AORA-controlled collection account, labelled as an assumption | Owner | 3 |
| M-5 | KELO credit is built before the licence or partner decision | Lessons §4; D-5 | Sandbox only, behind a feature flag that is off by default; no lender named | Owner | 11 |
| M-6 | Simulated fiat-to-USDC conversion | Brief §3.3 (conversion only with an approved provider and legal model) | Simulator only, labelled "simulated conversion, no real rate"; rate and fee come from versioned sandbox data | Owner | 6 |
| M-7 | Named providers (Safaricom Daraja, Africa's Talking) | CLAUDE.md rule 11 | Their behaviour is taken only from their current documentation, read in the phase that integrates them, and recorded with source and date. Nothing is assumed in advance | Eng | 2, 3 |

---

## O. Owner defaults and questions from the KELO and hosting rulings

### Decided by the owner (defaults; may change)

| ID | Decision | Consequence for the build |
|---|---|---|
| O-1 | Merchant working-capital financing (cash advances) is deferred until after the MVP | The eligibility and reason-code engine is product-neutral so it can be reused (ADR 0018) |
| O-2 | Sandbox funding model: KELO pays the merchant upfront, less a merchant discount fee, once fulfilment is confirmed; the consumer repays KELO. Production model (own book, partner lender, or both) is pending | Every agreement names a lender of record; a `LenderAdapter` lets a partner plug in (ADR 0017) |
| O-3 | One merchant per order | No multi-merchant baskets |
| O-4 | BNPL is consumer credit and likely needs a CBK Digital Credit Provider licence or a licensed partner. Every credit feature stays behind a feature flag. Layaway is probably not credit | Flag `kelo_credit`; layaway is built outside it; see O-8, O-9 |

### Open, each with a recommended default

| ID | Question | Why it matters | Recommended default | Blocks |
|---|---|---|---|---|
| O-5 | Which MTN market for the sandbox integration? | Sets the country and currency records the MTN adapter is modelled on | **Ghana.** The research ranks it the second export market and moves Uganda down for its withdrawal tax. Not a launch decision | Rails checkpoint for MTN |
| O-6 | Which bank sandbox can you obtain? | The bank adapter needs one real provider | Candidates, all **to verify**: Equity (Jenga), KCB (Buni), Co-operative Bank, Stanbic, I&M. Pick whichever grants sandbox access fastest | Rails checkpoint for the bank |
| O-7 | Where are product images stored? | The API cannot carry uploads above 4.5 MB (ADR 0013), and images need a store | Vercel Blob, as the Vercel-native option. **Not yet verified; I will verify limits and pricing and ask before adopting it** | KELO catalogue checkpoint |
| O-8 | What do the CBK Digital Credit Provider conduct rules require of reminders, disclosure and late charges? | The collections design must follow them | Not yet read. First task of the credit checkpoint: read and cite the regulations, record findings in `docs/compliance/`, then design reminders. Until then the stricter owner rules apply (no contacts access, no third parties, no shaming, capped late charges) | KELO credit checkpoints (d), (e) |
| O-9 | Is layaway outside the definition of credit in Kenya, and may AORA hold layaway funds? | Decides whether layaway needs the credit flag, and who may hold the money | Treat as "not credit" in the sandbox, hold funds in a labelled sandbox liability account, and get counsel's view before any live use. **Not verified** | Live use only |
| O-10 | Which Vercel plan? | Per-minute cron needs **Pro** ($20 per month); Hobby allows one run per day | **Decided: Hobby, with background work driven by request-triggered draining plus a GitHub Actions schedule (ADR 0013), at no cost.** Caveat for the owner: Vercel's terms restrict Hobby to non-commercial, personal use, and AORA is a commercial project. Staying on Hobby risks the account being paused | Owner's call; no engineering block |

Providers the KELO phases will eventually need, listed now and requested later: an ID-verification sandbox, a credit-bureau sandbox, and image storage (O-7).

### Added with the Clerk and Resend rulings (2026-10-13)

Africa's Talking is dropped from the MVP and its credential request is withdrawn. Sign-in is by email code through Clerk; email is sent through Resend (ADRs 0019, 0020).

| ID | Question | Why it matters | Options | Recommended default | Blocks |
|---|---|---|---|---|---|
| O-11 | How is a phone number verified in the MVP? | The phone number is the payment identifier and financial identity (brief §2.1), but sign-in no longer proves control of it. Money sent to a wrong or someone else's number is the worst outcome | (a) **Clerk SMS verification.** Clerk restricts SMS to countries on an allowlist that by default contains only the US and Canada; other countries are enabled in the dashboard and charged at "market rate". Kenya's availability and price are **not verified**. (b) **An SMS adapter added later** behind the notifications channel interface. (c) **Confirm the number before any money is sent to it**: the first payout or transfer to a number shows the name the provider returns for it (where the rail offers a name lookup, to verify per rail) and needs a PIN step-up; collections from a number need no verification because the payer approves on their own handset | **(c) for the MVP**, since it needs no SMS provider and guards the one risky direction. Record the number as unverified. Add (a) or (b) before any pilot if a rail has no name lookup | Phase 3C payouts |
| O-12 | Cross-border processing of personal data | Clerk (email, phone, name, sign-in events) and Resend (email addresses, message content) process personal data outside Kenya. Neon and Vercel host in Frankfurt. Kenya's Data Protection Act has conditions for transferring personal data out of the country | Legal review is needed before any pilot with real people, covering: the lawful basis and safeguards for each transfer; whether consent or a contractual mechanism is required; each processor's data-processing terms and sub-processors; registration with the data protection regulator; data-subject rights, including erasure versus the duty to keep financial records (ADR 0019); breach notification; and where each processor stores data. **None of this has been verified; it is for counsel** | Sandbox only, with test identities, until reviewed. No real customer data in staging | Any pilot |
| O-13 | Does the owner have a domain to verify in Resend? | Without one, mail can be sent only from Resend's test sender and only to the Resend account owner's own address (ADR 0020) | (a) Verify a domain or subdomain the owner controls (for example `mail.<domain>`). (b) Stay on the test sender | (a), using a subdomain so the root domain's mail is untouched. DNS records are supplied when the domain is named | Staging sign-in for anyone but the owner |
