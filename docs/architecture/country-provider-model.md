# AORA — Country and Provider Model

- **Status:** owner decision of 2026-10-18. Mechanism in [ADR 0014](../adr/0014-multi-rail-multi-country.md).
- **Rule:** nothing here states a provider's API behaviour, limits, currencies or prices. A provider's behaviour is recorded only in `docs/providers/<provider>.md`, read from its current documentation with source and date, in the checkpoint that integrates it ([daraja.md](../providers/daraja.md) is the model). Anything not yet read is marked **to verify**.

## 1. Markets

| Market | Role | Basis | What it authorises now |
|---|---|---|---|
| Kenya | Home market; the only launch market | Brief; owner | Sandbox MVP |
| Tanzania | First export market | Teardown (interoperability mandate); owner, 2026-10-18 | Nothing beyond data-model support |
| Ghana | Export market | Teardown; owner, 2026-10-18 | Nothing beyond data-model support |
| Uganda | Export market | Teardown; owner, 2026-10-18 | Nothing beyond data-model support |
| Nigeria | Partnership / API tier only. **No direct merchant acquiring** | Owner, 2026-10-18 | Nothing |

Naming a market here authorises no integration, licence position or launch. Each market needs its own legal review (D-4, O-12) before any pilot.

## 2. Rails by market

Rail identifiers follow ADR 0014 (`<provider>_<country>`). "Sandbox" means the provider's sandbox; "simulator" means AORA's own simulator adapter.

| Rail | Provider | Country | MVP status | Notes |
|---|---|---|---|---|
| `mpesa_ke` | Safaricom M-Pesa through Daraja | KE | **Integrated (sandbox), Phase 3** | Behaviour in [daraja.md](../providers/daraja.md). The only real rail in the MVP |
| `airtel_ke` | Airtel Money | KE | Simulator | Rails expansion |
| `airtel_ug` | Airtel Money | UG | Simulator | Rails expansion. Per-country API differences **to verify** |
| `airtel_tz` | Airtel Money | TZ | Simulator | Rails expansion. Per-country API differences **to verify** |
| `mtn_gh` | MTN MoMo | GH | Simulator | Rails expansion. O-5 resolved: MTN covers Ghana and Uganda |
| `mtn_ug` | MTN MoMo | UG | Simulator | Rails expansion. Per-country API differences **to verify** |
| `mpesa_tz` | Vodacom M-Pesa | TZ | Not built | **A separate future adapter.** Vodacom's API is different from Safaricom's Daraja; nothing is shared with `mpesa_ke` except the ADR 0007 interfaces. Everything about it is **to verify** |
| `bank_<name>_ke` | One bank, named by the owner with the credentials (O-6) | KE | Simulator | Rails expansion |
| `sandbox_sim` | AORA simulator | any | Available | Fallback for every rail; always reported as simulated |

Nigeria has no rail: the partnership tier is an API product for licensed partners, not an acquiring rail.

## 3. Rules that follow

- **The data model stays country-neutral and rail-neutral.** Every money record carries its own `country` and `asset` (ADR 0014). No code path assumes Kenya, KES or M-Pesa.
- **No adapter beyond the simulator** for Airtel, MTN, Vodacom or the bank until the owner provides sandbox credentials and says so. Their credentials are not requested before then.
- **Same brand, different adapter.** Airtel in three countries and MTN in two are separate rails. Whether each country's API is the same is verified per country when that rail is integrated; it is never assumed.
- **Rail selection is configuration per environment** (ADR 0014). A rail without credentials runs on the simulator and is labelled as simulated on every screen and record.

## 4. Change log

- 2026-10-18: created from the owner's decisions (markets, O-5, O-6, Vodacom M-Pesa, rails deferred to the Rails expansion phase).
