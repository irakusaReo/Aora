# ADR 0014 — Multi-rail and multi-country model

- **Status:** Accepted (owner scope decision, 2026-10-13). The MTN market and the bank are proposals awaiting the owner.
- **Related:** ADR 0003, 0007; lessons §1, §3; brief §3.3, §5.1; open questions D-3, M-7, O-5, O-6

No provider's API behaviour, limits, currencies or prices are stated here. Each is read from the provider's current documentation in the checkpoint that integrates it, and recorded with source and date in `docs/architecture/country-provider-model.md`.

## Context

The MVP adds real rails: M-Pesa through Safaricom Daraja (Kenya), Airtel Money (Kenya), MTN MoMo (not available in Kenya, so one other market, sandbox only) and one bank. The simulator stays as the fallback. Kenya is still the only launch market; an MTN sandbox integration authorises nothing in that market.

## Decision

**Rail accounts, not providers, are what the platform routes on.**

- **`rail`** is reference data: an identifier, a kind (`mobile_money`, `bank`, `simulator`, later `chain`), the adapter that serves it, a `country` and the currencies it handles. Example identifiers: `mpesa_ke`, `airtel_ke`, `mtn_gh`, `bank_<name>_ke`, `sandbox_sim`.
- **Every money record carries its own `country` and `asset`**: payment intents, payouts, tariffs, ledger accounts, settlement lines. Nothing infers the currency from the tenant or assumes Kenya (lessons §3).
- **One adapter per rail**, each implementing only the ADR 0007 capability interfaces its provider documents, with a capability declaration per (rail, country, asset). Orchestration refuses an undeclared capability with `capability_not_supported`; it never substitutes another rail silently.
- **A merchant's collection points** (lessons §3) each belong to one rail. A merchant can have several rails; a payment intent names a collection point, or a rail, explicitly.
- **Ledger:** one `provider_clearing` account per rail and asset. A journal entry stays within one asset; cross-asset movement goes through conversion clearing accounts (ADR 0003) and, in the MVP, only through the labelled simulator.
- **Sandbox currencies are taken as the sandbox reports them.** If a provider's sandbox only transacts in a test currency, that currency is registered as a ledger asset flagged `sandbox_only`, with its exponent from the provider's documentation. The platform does not relabel it as the market's real currency, and screens show it as a sandbox test currency.
- **Tariffs** are keyed by rail, country, asset and effective dates (lessons §1). Sandbox tariff values are visibly fake until real published tariffs are verified.
- **Callbacks:** one intake route per rail, `/v1/webhooks/<rail>`, each with that provider's own authenticity check implemented from its documentation. If a provider offers no signature, the compensating control (for example a secret path segment plus a status inquiry before any state change) is recorded per adapter.
- **Selection is configuration:** each environment declares which adapter serves each rail (`simulator` or the real one). A rail whose credentials are missing falls back to the simulator and is reported as simulated, never as integrated.
- **One rail per checkpoint.** A rail is "integrated" only when the shared adapter contract suite passes against its real sandbox and reconciliation is clean.

### Proposals for the owner

- **MTN market: Ghana.** The research ranks Ghana as the second export market and moves Uganda down because of its withdrawal tax; Tanzania, the first export market, has no MTN. Integrating Ghana therefore exercises the model against the more likely future market. Open question O-5.
- **Bank:** candidates with public developer programmes, all **to verify**: Equity Bank (Jenga), KCB (Buni), Co-operative Bank, Stanbic, I&M. The choice depends on which sandbox the owner can obtain. Open question O-6.

## Alternatives considered

- **Provider-specific tables and code paths:** fastest for Daraja alone; every later rail becomes a rewrite.
- **A single aggregator for all rails:** fewer integrations, but the owner asked for direct sandboxes, and it hides per-rail behaviour the adapters must model anyway.
- **Mapping a sandbox test currency onto the real one:** makes demos look right and makes the ledger lie.
- **Country as a tenant attribute:** breaks as soon as one merchant uses rails in two currencies.

## Consequences

- Adding a rail is an adapter, reference data and configuration; no change to payments, ledger or reconciliation code.
- Reports must group by asset; a single "total collected" across currencies is never shown.
- The Phase 1 payment intent gains `rail` and `country`; its `provider` column becomes the adapter name.
- Each real rail needs credentials and a reachable callback URL, so each checkpoint starts with a credential request.
