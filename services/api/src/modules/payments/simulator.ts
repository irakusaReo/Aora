import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../../platform/config.js';
import { Database } from '../../platform/database.js';
import { SANDBOX_PROVIDER } from '../../seed-data.js';
import type {
  CapabilityDeclaration,
  CollectCapability,
  CollectRequest,
  MoneyOutcome,
  ProviderAdapter,
  ProviderEvent,
  ProviderStatus,
  SettlementLine,
  SettlementReportCapability,
  StatusInquiryCapability,
  WebhookCapability,
} from './adapter.js';

export const SCENARIOS = [
  'success',
  'decline',
  'timeout_then_success',
  'timeout_then_failure',
  'duplicate_webhook',
  'late_webhook',
  'amount_mismatch',
  'missing_settlement_line',
] as const;
export type Scenario = (typeof SCENARIOS)[number];

export const SIM_SIGNATURE_HEADER = 'aora-sim-signature';

const eventSchema = z.strictObject({
  event_id: z.string().min(1),
  type: z.literal('collection.result'),
  operation_ref: z.string().min(1),
  provider_reference: z.string().min(1),
  result: z.enum(['succeeded', 'failed']),
  amount_minor: z.string().regex(/^[1-9][0-9]{0,18}$/),
  asset: z.string().min(1),
});

/**
 * SANDBOX ONLY. An AORA-owned simulator of a payment provider. It imitates no
 * real provider; it exists to exercise every state the platform must handle,
 * on demand: success, decline, timeouts, duplicate and late webhooks, amount
 * mismatches and gaps in the settlement report.
 *
 * Its tables (schema `sim`) stand in for the provider's own systems.
 */
@Injectable()
export class SimulatorProvider
  implements
    ProviderAdapter,
    CollectCapability,
    StatusInquiryCapability,
    WebhookCapability,
    SettlementReportCapability
{
  readonly declaration: CapabilityDeclaration = {
    provider: SANDBOX_PROVIDER,
    rail: 'simulator',
    country: 'KE',
    assets: ['KES'],
    capabilities: ['collect', 'status_inquiry', 'webhook', 'settlement_report'],
  };

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    if ((config.mode as string) !== 'sandbox') {
      throw new Error('SimulatorProvider is forbidden outside sandbox mode.');
    }
  }

  async collect(request: CollectRequest): Promise<MoneyOutcome> {
    const scenario = (request.scenario ?? 'success') as Scenario;
    return this.db.asPlatform(async (tx) => {
      // Idempotent on the operation reference, like a well-behaved provider.
      const existing = await tx.sim_transaction.findUnique({
        where: { operation_ref: request.operationRef },
      });
      if (existing) return { kind: 'accepted', providerReference: existing.id };

      const status =
        scenario === 'decline' || scenario === 'timeout_then_failure' ? 'failed' : 'succeeded';
      const collected = scenario === 'amount_mismatch' ? request.amount + 1n : request.amount;
      const record = await tx.sim_transaction.create({
        data: {
          operation_ref: request.operationRef,
          amount: collected,
          asset_code: request.assetCode,
          scenario,
          status,
          report_copies: scenario === 'missing_settlement_line' ? 0 : 1,
        },
      });

      const event = (result: 'succeeded' | 'failed', eventId = randomUUID()): string =>
        JSON.stringify({
          event_id: eventId,
          type: 'collection.result',
          operation_ref: request.operationRef,
          provider_reference: record.id,
          result,
          amount_minor: collected.toString(),
          asset: request.assetCode,
        });
      const queue = (bodies: string[]): Promise<unknown> =>
        tx.sim_webhook_delivery.createMany({
          data: bodies.map((body) => ({ transaction_id: record.id, body })),
        });

      switch (scenario) {
        case 'decline':
          return { kind: 'rejected', reason: 'declined' };
        case 'timeout_then_success':
        case 'timeout_then_failure':
          // The provider acted (or refused) but the caller never hears back.
          return { kind: 'unknown' };
        case 'duplicate_webhook': {
          const body = event('succeeded');
          await queue([body, body]);
          break;
        }
        case 'late_webhook':
          // A failure notice first, then the real outcome.
          await queue([event('failed'), event('succeeded')]);
          break;
        default:
          await queue([event('succeeded')]);
      }
      return { kind: 'accepted', providerReference: record.id };
    });
  }

  async queryStatus(operationRef: string): Promise<ProviderStatus> {
    const record = await this.db.asPlatform((tx) =>
      tx.sim_transaction.findUnique({ where: { operation_ref: operationRef } }),
    );
    if (!record) return { kind: 'not_found' };
    if (record.status === 'succeeded') {
      return { kind: 'succeeded', amount: record.amount, providerReference: record.id };
    }
    return record.status === 'failed'
      ? { kind: 'failed', providerReference: record.id }
      : { kind: 'pending' };
  }

  sign(rawBody: string): string {
    const mac = createHmac('sha256', this.config.simWebhookSecret).update(rawBody).digest('hex');
    return `sha256=${mac}`;
  }

  verifySignature(rawBody: Buffer, signature: string | undefined): boolean {
    if (!signature) return false;
    const expected = Buffer.from(this.sign(rawBody.toString('utf8')));
    const actual = Buffer.from(signature);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  parseEvent(rawBody: string): ProviderEvent {
    const event = eventSchema.parse(JSON.parse(rawBody));
    return {
      eventId: event.event_id,
      operationRef: event.operation_ref,
      providerReference: event.provider_reference,
      result: event.result,
      amount: BigInt(event.amount_minor),
    };
  }

  /**
   * A payout or refund at the simulated provider. Same scripted behaviour as a
   * collection: success, decline, or a timeout after which the caller must ask.
   * Idempotent on the operation reference.
   */
  async moveMoney(input: {
    kind: 'payout' | 'refund';
    operationRef: string;
    amount: bigint;
    assetCode: string;
    scenario: string | null;
  }): Promise<MoneyOutcome> {
    const scenario = input.scenario ?? 'success';
    return this.db.asPlatform(async (tx) => {
      const existing = await tx.sim_transaction.findUnique({
        where: { operation_ref: input.operationRef },
      });
      if (existing) return { kind: 'accepted', providerReference: existing.id };
      const failed = scenario === 'decline' || scenario === 'timeout_then_failure';
      const record = await tx.sim_transaction.create({
        data: {
          operation_ref: input.operationRef,
          amount: input.amount,
          asset_code: input.assetCode,
          scenario,
          status: failed ? 'failed' : 'succeeded',
          kind: input.kind,
          report_copies: 0,
        },
      });
      if (scenario === 'decline') return { kind: 'rejected', reason: 'declined' };
      if (scenario.startsWith('timeout')) return { kind: 'unknown' };
      return { kind: 'accepted', providerReference: record.id };
    });
  }

  async fetchSettlementReport(): Promise<SettlementLine[]> {
    const records = await this.db.asPlatform((tx) =>
      tx.sim_transaction.findMany({
        where: { status: 'succeeded', kind: 'collection' },
        orderBy: { created_at: 'asc' },
      }),
    );
    return records.flatMap((record) =>
      Array.from({ length: record.report_copies }, () => ({
        providerReference: record.id,
        operationRef: record.operation_ref,
        amount: record.amount,
        assetCode: record.asset_code,
      })),
    );
  }

  /**
   * Sends due webhooks through `send` (which must go over HTTP to the real
   * intake endpoint) and marks those that were accepted. Returns how many.
   */
  async deliverDueWebhooks(
    send: (rawBody: string, signature: string) => Promise<number>,
  ): Promise<number> {
    const due = await this.db.asPlatform((tx) =>
      tx.sim_webhook_delivery.findMany({
        where: { delivered_at: null, deliver_after: { lte: new Date() } },
        orderBy: { sequence: 'asc' },
      }),
    );
    let delivered = 0;
    for (const delivery of due) {
      const status = await send(delivery.body, this.sign(delivery.body));
      if (status >= 200 && status < 300) {
        await this.db.asPlatform((tx) =>
          tx.sim_webhook_delivery.update({
            where: { id: delivery.id },
            data: { delivered_at: new Date() },
          }),
        );
        delivered += 1;
      }
    }
    return delivered;
  }

  // --- Controls for tests and demos: make the provider's records disagree with AORA's. ---

  /** A settled transaction the platform has never heard of. */
  async injectOrphanTransaction(amount: bigint): Promise<string> {
    const record = await this.db.asPlatform((tx) =>
      tx.sim_transaction.create({
        data: {
          operation_ref: `orphan-${randomUUID()}`,
          amount,
          asset_code: 'KES',
          scenario: 'orphan',
          status: 'succeeded',
        },
      }),
    );
    return record.operation_ref;
  }

  /** Makes the settlement report list a transaction twice. */
  async duplicateSettlementLine(operationRef: string): Promise<void> {
    await this.db.asPlatform((tx) =>
      tx.sim_transaction.update({
        where: { operation_ref: operationRef },
        data: { report_copies: 2 },
      }),
    );
  }
}
