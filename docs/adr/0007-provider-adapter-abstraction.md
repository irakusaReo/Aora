# ADR 0007 — Provider adapter abstraction

- **Status:** Proposed
- **Date:** 2026-10-13
- **Related:** brief §3.3, §5.1, §9.1; lessons §3, §6; CLAUDE.md rules 6, 7, 11; open questions [D-3](../architecture/open-questions.md#d-3), X-1 to X-4

## Context

Local payment rails (mobile money, banks, later cards) must connect through provider-neutral adapters. Each adapter must declare its capabilities, error mappings, status inquiry, webhook behaviour and reconciliation support, and the platform must never infer that one provider supports what another does. No provider's real behaviour is documented in this repository yet.

## Decision

**Small capability interfaces, an explicit capability declaration per adapter, and an AORA-owned simulator as the first adapter.**

- **Capabilities are separate interfaces**, for example: collect (customer-initiated and merchant-initiated are different capabilities), pay out, query status, refund or reverse, parse and verify webhook, fetch settlement report. An adapter implements only what its provider documents.
- **Each adapter publishes a static capability declaration** per rail, country and currency. Orchestration checks it before routing. An undeclared capability is a stable `capability_not_supported` error, never a fallback to another provider.
- **Every call that can move money returns a typed outcome**: accepted, rejected (with a mapped reason), or **unknown** (timeout, connection error, ambiguous response). `unknown` moves the operation to `status_unknown`; the orchestrator then uses status inquiry or reconciliation. Adapters never retry a money-moving call on their own.
- **Every money-moving call carries AORA's operation reference**, used as the provider idempotency or reference field where the provider supports one (to verify per provider).
- **Webhooks:** the adapter verifies authenticity and normalises the payload into a platform event. The raw payload is stored unmodified. Processing is idempotent on the provider's event identity; duplicates, out-of-order and late events are expected cases with tests.
- **Error mapping:** provider codes map to a small stable platform set; the raw code is kept on the adapter record.
- **Rail-specific data stays in adapter-owned records.** The platform's payment intent and the ledger see only normalised fields.
- **The sandbox adapter is an AORA simulator.** It is not an imitation of any named provider. It has deterministic triggers for success, decline, timeout-then-success, timeout-then-failure, duplicate webhook, late webhook, amount mismatch and missing settlement line.
- **One shared contract-test suite** runs against every adapter, so a real adapter must pass the same state and idempotency tests as the simulator.
- **The Base/USDC integration is not a payment adapter.** It is a distinct rail type with its own module (ADR 0004); orchestration treats both as rails with declared capabilities.

## Alternatives considered

- **One large interface with optional methods:** every adapter appears to support everything; unsupported paths fail at runtime.
- **Calling provider SDKs from domain code:** fast for one provider, and it leaks provider states and errors into payments and the ledger.
- **Relying on a single aggregator's API as the abstraction:** ties the platform's model to one vendor, and the choice of provider is still open (D-3).
- **Designing the interface from provider behaviour recalled from memory:** forbidden by CLAUDE.md rule 11.

## Consequences

- The interface is shaped by the simulator first, so it will need revision when the first real provider is integrated. The contract tests make that revision visible.
- Capability checks add a step to routing but make "this rail cannot do that" an explicit, testable answer.
- Unknown-state handling is exercised from the first slice instead of being discovered in production.
- A provider that lacks status inquiry or an idempotency reference will need compensating controls, decided per adapter.
