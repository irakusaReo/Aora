/**
 * Provider adapter contracts (ADR 0007).
 *
 * Capabilities are separate interfaces. An adapter implements only what its
 * provider documents and declares it in `capabilities`; nothing is inferred
 * from another provider. Adapters never retry a money-moving call themselves.
 */

export type Capability = 'collect' | 'status_inquiry' | 'webhook' | 'settlement_report';

export interface CapabilityDeclaration {
  readonly provider: string;
  readonly rail: string;
  readonly country: string;
  readonly assets: readonly string[];
  readonly capabilities: readonly Capability[];
}

/**
 * The outcome of a call that can move money. `unknown` means the provider may
 * or may not have acted (timeout, dropped connection, ambiguous reply): the
 * caller must query or reconcile, and must not call again.
 */
export type MoneyOutcome =
  | { readonly kind: 'accepted'; readonly providerReference: string }
  | { readonly kind: 'rejected'; readonly reason: string }
  | { readonly kind: 'unknown' };

export interface CollectRequest {
  /** AORA's reference for the operation; the provider's idempotency key where it has one. */
  readonly operationRef: string;
  readonly amount: bigint;
  readonly assetCode: string;
  readonly scenario: string | null;
}

export interface CollectCapability {
  collect(request: CollectRequest): Promise<MoneyOutcome>;
}

export type ProviderStatus =
  | { readonly kind: 'succeeded'; readonly amount: bigint; readonly providerReference: string }
  | { readonly kind: 'failed'; readonly providerReference: string }
  | { readonly kind: 'pending' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unknown' };

export interface StatusInquiryCapability {
  queryStatus(operationRef: string): Promise<ProviderStatus>;
}

export interface ProviderEvent {
  readonly eventId: string;
  readonly operationRef: string;
  readonly providerReference: string;
  readonly result: 'succeeded' | 'failed';
  readonly amount: bigint;
}

export interface WebhookCapability {
  /** True only if the raw body carries a valid signature from the provider. */
  verifySignature(rawBody: Buffer, signature: string | undefined): boolean;
  /** Normalises a verified payload. Throws if it is not a recognised event. */
  parseEvent(rawBody: string): ProviderEvent;
}

export interface SettlementLine {
  readonly providerReference: string;
  readonly operationRef: string;
  readonly amount: bigint;
  readonly assetCode: string;
}

export interface SettlementReportCapability {
  fetchSettlementReport(): Promise<SettlementLine[]>;
}

export interface ProviderAdapter {
  readonly declaration: CapabilityDeclaration;
}

export function supports(adapter: ProviderAdapter, capability: Capability): boolean {
  return adapter.declaration.capabilities.includes(capability);
}
