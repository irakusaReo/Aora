# ADR 0016 — Mobile architecture

- **Status:** Accepted (owner scope decision, 2026-10-13). Library and service specifics are confirmed against current documentation when the first app is created.
- **Related:** ADR 0001, 0002, 0011; brief §11.1; `docs/product/kelo-experience.md`

## Context

The MVP adds three native apps: `apps/chiwo-mobile`, `apps/kony-mobile` and `apps/kelo-mobile`. They must work on mid-range Android phones over slow connections, share code with the web apps, and hold no business logic. Mobile screens for a journey are built only after that journey's web flow is stable.

## Decision

**Expo (React Native, TypeScript), one app per product, thin clients over the same `/v1` API.**

### Shared packages

| Package | Contents | Used by |
|---|---|---|
| `packages/api-client` | Typed client generated from `docs/api/openapi.yaml`; idempotency-key handling; error-code mapping | web and mobile |
| `packages/validation` | Input schemas shared with forms (phone numbers, amounts as minor-unit strings) | web and mobile |
| `packages/design-tokens` | AORA colour, type, spacing and motion tokens, exported for web CSS and for React Native | web and mobile |

No UI component library is shared between web and native in the MVP; tokens are shared, components are not. This avoids a cross-platform component layer before there is evidence it pays for itself.

### Rules

1. **No business logic in clients.** No fee, instalment, limit, eligibility or balance is computed on the device. The API returns display-ready values (for example every instalment's date and amount); the client renders them. Amounts stay strings of minor units until the last formatting step.
2. **Money actions are idempotent from the device.** The client creates the idempotency key before the first attempt and reuses it on every retry, including after the app is killed.
3. **Unknown is a first-class screen state.** A timeout shows "we are checking", never "failed" and never "done".
4. **Session tokens live only in the platform's secure storage** (Keychain and Keystore, through Expo's secure-storage module). Never in plain storage, logs, analytics or crash reports. Sign-out and server-side revocation both clear them.
5. **PIN entry is never stored** on the device. Biometric unlock, if added later, unlocks a server-issued step-up, not a stored PIN.
6. **Slow networks and modest phones:**
   - lists are paginated and virtualised; images are requested at the size shown;
   - last successful read responses are cached for display while refreshing, and marked as possibly out of date;
   - nothing that moves money is queued offline;
   - a JavaScript bundle and start-up time budget is set per app and checked in CI.
7. **Every screen shows the sandbox label.**
8. **Roles and tenant scope are enforced by the API**; hiding a button is presentation, not security.
9. **KELO merchant screens** live in `kony-mobile`; consumer marketplace screens live in `kelo-mobile`. One identity signs in to all three apps.
10. **Push notifications** carry no amounts, names or account details in their payload; they prompt the user to open the app.
11. **Copy is externalised** from the first screen (English, Swahili-ready).

### Local development and builds

Expo Go or a development build for local testing. Building installable binaries needs an Expo account or an EAS token, requested from the owner only at that point.

### Testing, including end to end

| Level | What | Where |
|---|---|---|
| Unit | Formatting, input validation, state reducers, api-client error mapping | Vitest, in CI |
| Component | Screens rendered with a mocked api-client, including loading, empty, error and unknown states | React Native Testing Library, in CI |
| Contract | The generated client is checked against `openapi.yaml`; a drift fails the build | CI |
| End to end | The same journey scripts as mvp-scope §exit tests, driven against a development build on an Android emulator, talking to a local API with the simulator rails and seeded data | Maestro flows (tool to verify when adopted), in CI on Android; iOS run manually before the MVP gate |
| Device check | Each journey once on a real mid-range Android phone on a throttled connection | Manual, at each mobile checkpoint |

End-to-end runs use the sandbox authenticator only against a local database, consistent with the deployed-environment rule; against staging they sign in with a real one-time code delivered by the SMS sandbox.

## Alternatives considered

- **One "super app":** fewer binaries, but three audiences, three permission sets and a much larger app for low-end phones.
- **React Native without Expo:** more native control that the MVP does not need, and more build infrastructure.
- **Web views or a PWA only:** cheapest, but weaker secure storage, notifications and offline tolerance, and the owner asked for native apps.
- **Sharing UI components across web and native now:** deferred; tokens only.

## Consequences

- Three apps to keep in step with the API; the generated client and the contract test are what make that affordable.
- The API must return display-ready schedules and decisions, which is also what keeps web and mobile consistent.
- iOS coverage is manual until there is demand for more.
- App-store accounts, signing and distribution are not part of the MVP.
