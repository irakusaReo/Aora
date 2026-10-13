# ADR 0012 — Canonical business identity and duplicate detection

- **Status:** Accepted (owner ruling on D-7, 2026-10-13)
- **Date:** 2026-10-13
- **Related:** brief §4.5, §7.1, §10.1; lessons §3, §7; ADR 0008; open question [D-7](../architecture/open-questions.md#d-7)

## Context

Every product must resolve to one canonical AORA business. Provisioning must "resolve or create" it and detect duplicates. The owner ruled that unregistered sole traders (market vendors, kiosks) are valid businesses:

- **Registered businesses** are identified by registration number.
- **Unregistered businesses** are identified by the owner's verified identity plus business name and location.

## Decision

**Model**

- `business` has an immutable internal ID, a `kind` (`registered` or `unregistered`), a display name, a `country`, and for unregistered businesses an `owner_person_id` and a location.
- `business_identifier` holds typed external identifiers: `type`, `country`, `value` (normalised), `verified_at`. Types are data, added per country. Unique on (`type`, `country`, `value`).
- Location for unregistered businesses is structured (country, administrative area, locality, free-text place such as a market and stall). Which administrative levels Kenya onboarding collects is set in Phase 3: **to verify**.
- A business never changes kind in place. An unregistered business that registers gains a registration identifier and its kind is changed by an audited operator action.

**Matching rule**

A candidate business is compared with existing ones in this order:

1. **Registered:** an existing business has the same verified registration identifier (same type, country and normalised value) → **same business**. Link to it.
2. **Unregistered:** an existing unregistered business has the same owner person, the same normalised name and the same location → **same business**. Link to it.
3. **Possible duplicate → manual review, never automatic:**
   - same owner person and same location, different name;
   - same owner person and same normalised name, different location;
   - same normalised name and same location, different owner;
   - a registered candidate whose owner already has an unregistered business with the same normalised name;
   - any identifier match where the identifier is not yet verified.
4. Otherwise → **new business**.

**Rules**

- Normalisation is deterministic and versioned: case-folding, whitespace collapse, punctuation removal, and removal of a configured list of legal-form suffixes. The version used is stored with each match decision.
- "Same owner" means the same `person` record, which requires the owner's identity to be verified at the tier the onboarding flow demands. An unverified owner can never produce an automatic match.
- One person may own several distinct unregistered businesses (two stalls in different markets are two businesses).
- **No automatic merge.** A review outcome is `same` (link) or `distinct` (create and record the decision so the pair is not flagged again). Merging two existing businesses is a separate audited operator action, not part of this ADR.
- Every match decision is stored with its inputs, rule, normalisation version and outcome.
- Exact-match guarantees are enforced by database unique constraints, not only by application checks.

## Alternatives considered

- **Registration number mandatory for all:** excludes the micro-merchant segment the product is aimed at.
- **Phone number as business identity:** numbers are recycled and shared, and are an identifier of a person at best.
- **Fuzzy name matching with automatic linking:** a false positive links two merchants' money; unacceptable.
- **No duplicate detection for unregistered businesses:** makes "exactly one workspace" in provisioning meaningless.

## Consequences

- Unregistered merchants can onboard, at the cost of weaker identity than a registry number; tier limits (D-8) should reflect that.
- Manual review needs an operator queue from Phase 3.
- The rule depends on verified owner identity, so it is only as strong as KYC (D-8).
- Phase 1 builds the tables and the two exact-match constraints; the review queue and normalisation list come with onboarding in Phase 3.
