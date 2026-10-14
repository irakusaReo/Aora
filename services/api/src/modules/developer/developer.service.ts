import {
  createHash,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  randomBytes,
  randomUUID,
  sign,
} from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { APP_CONFIG, type AppConfig } from '../../platform/config.js';
import { Database, type Tx } from '../../platform/database.js';
import { AppError } from '../../platform/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { type OutboxEvent, OutboxService } from '../outbox/outbox.service.js';

export const EVENT_WEBHOOK_DELIVER = 'developer.webhook.deliver';

/** The events a merchant can subscribe to. */
export const WEBHOOK_EVENT_TYPES = [
  'payment_intent.succeeded',
  'payment_intent.failed',
  'payout.succeeded',
  'payout.failed',
  'refund.succeeded',
  'refund.failed',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export type KeyScope = 'collect' | 'full';

export interface ApiKeyView {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly scope: KeyScope;
  readonly created_at: string;
  readonly last_used_at: string | null;
  readonly revoked_at: string | null;
}

export interface EndpointView {
  readonly id: string;
  readonly url: string;
  readonly event_types: string[];
  readonly status: string;
  readonly created_at: string;
}

export interface DeliveryView {
  readonly id: string;
  readonly event_id: string;
  readonly event_type: string;
  readonly endpoint_id: string;
  readonly status: string;
  readonly attempts: number;
  readonly last_response_status: number | null;
  readonly replay_of: string | null;
  readonly created_at: string;
  readonly delivered_at: string | null;
}

/** What an API key authenticates as. */
export interface KeyIdentity {
  readonly apiKeyId: string;
  readonly tenantId: string;
  readonly scope: KeyScope;
  readonly createdBy: string;
}

interface Actor {
  readonly tenantId: string;
  readonly accountId: string;
  readonly requestId: string;
}

const KEY_PREFIX = 'aora_sk_sandbox_';
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

const hashKey = (key: string): string => createHash('sha256').update(key).digest('hex');

/** True for loopback, private, link-local, unique-local and unspecified addresses. */
function isPrivateAddress(address: string): boolean {
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const v6 = address.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    v6 === '::1' ||
    v6 === '::' ||
    v6.startsWith('fc') ||
    v6.startsWith('fd') ||
    v6.startsWith('fe80') ||
    v6.startsWith('::ffff:')
  );
}

/**
 * Where AORA may send a webhook. On a deployed environment: HTTPS only, no
 * credentials in the URL, and never a private, loopback or link-local address
 * (the hostname is checked again, by DNS, at delivery). On a developer machine
 * a local receiver is allowed, for tests.
 */
export function isAllowedWebhookUrl(value: string, deployed: boolean): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (!deployed) return url.protocol === 'https:' || url.protocol === 'http:';
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal'))
    return false;
  return isIP(host) === 0 || !isPrivateAddress(host);
}

/**
 * The developer API (ADR 0023): API keys stored only as hashes, and outbound
 * webhooks signed with one platform Ed25519 key. A webhook body is written
 * once and replayed byte for byte, so a receiver can deduplicate on its id.
 */
@Injectable()
export class DeveloperService implements OnModuleInit {
  private readonly logger = new Logger('Webhooks');
  private readonly signingKey: KeyObject | null;

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {
    const encoded = config.webhooks.signingPrivateKey;
    this.signingKey = encoded
      ? createPrivateKey({ key: Buffer.from(encoded, 'base64'), format: 'der', type: 'pkcs8' })
      : null;
  }

  onModuleInit(): void {
    this.outbox.register(EVENT_WEBHOOK_DELIVER, (event) => this.handleDelivery(event));
  }

  // --- API keys ---

  async createKey(
    actor: Actor,
    input: { name: string; scope: KeyScope },
  ): Promise<ApiKeyView & { key: string }> {
    const secret = Array.from(randomBytes(40), (byte) =>
      ALPHABET.charAt(byte % ALPHABET.length),
    ).join('');
    const key = `${KEY_PREFIX}${secret}`;
    return this.db.asPlatform(async (tx) => {
      const row = await tx.api_key.create({
        data: {
          tenant_id: actor.tenantId,
          name: input.name,
          prefix: key.slice(0, 20),
          key_hash: hashKey(key),
          scope: input.scope,
          created_by: actor.accountId,
        },
      });
      await this.audit.record(tx, {
        tenantId: actor.tenantId,
        actorKind: 'user',
        actorAccountId: actor.accountId,
        action: 'developer.api_key.created',
        subjectType: 'api_key',
        subjectId: row.id,
        outcome: 'success',
        requestId: actor.requestId,
        detail: { scope: input.scope },
      });
      // The only time the key itself is ever returned.
      return { ...keyView(row), key };
    });
  }

  async listKeys(tenantId: string): Promise<ApiKeyView[]> {
    const rows = await this.db.withTenant(tenantId, (tx) =>
      tx.api_key.findMany({ orderBy: { created_at: 'desc' } }),
    );
    return rows.map(keyView);
  }

  async revokeKey(actor: Actor, keyId: string): Promise<ApiKeyView> {
    return this.db.asPlatform(async (tx) => {
      const row = await tx.api_key.findFirst({ where: { id: keyId, tenant_id: actor.tenantId } });
      if (!row) throw new AppError('not_found', 'API key not found.');
      if (row.revoked_at) return keyView(row);
      const updated = await tx.api_key.update({
        where: { id: row.id },
        data: { revoked_at: new Date(), revoked_by: actor.accountId },
      });
      await this.audit.record(tx, {
        tenantId: actor.tenantId,
        actorKind: 'user',
        actorAccountId: actor.accountId,
        action: 'developer.api_key.revoked',
        subjectType: 'api_key',
        subjectId: row.id,
        outcome: 'success',
        requestId: actor.requestId,
      });
      return keyView(updated);
    });
  }

  /** Resolves a presented key; null for anything unknown or revoked, without saying which. */
  async authenticateKey(presented: string): Promise<KeyIdentity | null> {
    if (!presented.startsWith(KEY_PREFIX)) return null;
    return this.db.asPlatform(async (tx) => {
      const row = await tx.api_key.findUnique({ where: { key_hash: hashKey(presented) } });
      if (!row || row.revoked_at) return null;
      await tx.api_key.update({ where: { id: row.id }, data: { last_used_at: new Date() } });
      return {
        apiKeyId: row.id,
        tenantId: row.tenant_id,
        scope: row.scope as KeyScope,
        createdBy: row.created_by,
      };
    });
  }

  // --- Webhook endpoints and deliveries ---

  async createEndpoint(
    actor: Actor,
    input: { url: string; eventTypes: WebhookEventType[] },
  ): Promise<EndpointView> {
    if (!isAllowedWebhookUrl(input.url, this.config.deployed)) {
      throw new AppError('invalid_request', 'Invalid request: url.');
    }
    return this.db.asPlatform(async (tx) => {
      const row = await tx.webhook_endpoint.create({
        data: {
          tenant_id: actor.tenantId,
          url: input.url,
          event_types: input.eventTypes,
          created_by: actor.accountId,
        },
      });
      await this.audit.record(tx, {
        tenantId: actor.tenantId,
        actorKind: 'user',
        actorAccountId: actor.accountId,
        action: 'developer.webhook_endpoint.created',
        subjectType: 'webhook_endpoint',
        subjectId: row.id,
        outcome: 'success',
        requestId: actor.requestId,
        detail: { event_types: input.eventTypes },
      });
      return endpointView(row);
    });
  }

  async listEndpoints(tenantId: string): Promise<EndpointView[]> {
    const rows = await this.db.withTenant(tenantId, (tx) =>
      tx.webhook_endpoint.findMany({ orderBy: { created_at: 'asc' } }),
    );
    return rows.map(endpointView);
  }

  async listDeliveries(tenantId: string): Promise<DeliveryView[]> {
    return this.db.asPlatform(async (tx) => {
      const rows = await tx.webhook_delivery.findMany({
        where: { tenant_id: tenantId },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        take: 100,
        include: { webhook_event: { select: { type: true } } },
      });
      return rows.map((row) => ({
        id: row.id,
        event_id: row.event_id,
        event_type: row.webhook_event.type,
        endpoint_id: row.endpoint_id,
        status: row.status,
        attempts: row.attempts,
        last_response_status: row.last_response_status,
        replay_of: row.replay_of,
        created_at: row.created_at.toISOString(),
        delivered_at: row.delivered_at?.toISOString() ?? null,
      }));
    });
  }

  /** Sends an event again as a new delivery. Same event id and body: no second effect on a deduplicating receiver. */
  async replay(actor: Actor, deliveryId: string): Promise<{ id: string; replay_of: string }> {
    return this.db.asPlatform(async (tx) => {
      const original = await tx.webhook_delivery.findFirst({
        where: { id: deliveryId, tenant_id: actor.tenantId },
      });
      if (!original) throw new AppError('not_found', 'Delivery not found.');
      const row = await tx.webhook_delivery.create({
        data: {
          event_id: original.event_id,
          endpoint_id: original.endpoint_id,
          tenant_id: actor.tenantId,
          replay_of: original.id,
        },
      });
      await this.audit.record(tx, {
        tenantId: actor.tenantId,
        actorKind: 'user',
        actorAccountId: actor.accountId,
        action: 'developer.webhook.replayed',
        subjectType: 'webhook_delivery',
        subjectId: row.id,
        outcome: 'success',
        requestId: actor.requestId,
        detail: { replay_of: original.id },
      });
      await this.outbox.enqueue(tx, {
        tenantId: actor.tenantId,
        type: EVENT_WEBHOOK_DELIVER,
        payload: { delivery_id: row.id },
      });
      return { id: row.id, replay_of: original.id };
    });
  }

  /** The public half of the signing key, for receivers to verify with. */
  publicKey(): { algorithm: 'ed25519'; key_id: string; public_key_pem: string } {
    if (!this.signingKey)
      throw new AppError('capability_not_supported', 'Webhook signing is not configured.');
    const pem = createPublicKey(this.signingKey).export({ type: 'spki', format: 'pem' }).toString();
    return {
      algorithm: 'ed25519',
      key_id: createHash('sha256').update(pem).digest('hex').slice(0, 16),
      public_key_pem: pem,
    };
  }

  /**
   * Records an event in the caller's transaction and queues one delivery per
   * subscribed endpoint of that workspace. Emitting the same event twice is harmless.
   */
  async emit(
    tx: Tx,
    input: {
      tenantId: string;
      type: WebhookEventType;
      subjectId: string;
      data: Prisma.InputJsonObject;
    },
  ): Promise<void> {
    const endpoints = await tx.webhook_endpoint.findMany({
      where: { tenant_id: input.tenantId, status: 'active', event_types: { has: input.type } },
    });
    if (endpoints.length === 0) return;
    const id = randomUUID();
    const body = JSON.stringify({
      id,
      type: input.type,
      created_at: new Date().toISOString(),
      data: input.data,
      mode: 'sandbox',
    });
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      insert into developer.webhook_event (id, tenant_id, type, dedupe_key, body)
      values (${id}::uuid, ${input.tenantId}::uuid, ${input.type}, ${`${input.type}:${input.subjectId}`}, ${body})
      on conflict (dedupe_key) do nothing
      returning id`;
    if (!inserted[0]) return;
    for (const endpoint of endpoints) {
      const delivery = await tx.webhook_delivery.create({
        data: { event_id: id, endpoint_id: endpoint.id, tenant_id: input.tenantId },
      });
      await this.outbox.enqueue(tx, {
        tenantId: input.tenantId,
        type: EVENT_WEBHOOK_DELIVER,
        payload: { delivery_id: delivery.id },
      });
    }
  }

  /** One attempt. Never throws: the delivery's own attempt count decides retries. */
  private async handleDelivery(event: OutboxEvent): Promise<void> {
    const payload = event.payload as { delivery_id?: unknown };
    const deliveryId = typeof payload.delivery_id === 'string' ? payload.delivery_id : '';
    const delivery = await this.db.asPlatform((tx) =>
      tx.webhook_delivery.findUnique({
        where: { id: deliveryId },
        include: { webhook_event: true, webhook_endpoint: true },
      }),
    );
    if (!delivery || delivery.status !== 'pending' || !this.signingKey) return;
    const body = delivery.webhook_event.body;
    const timestamp = Math.trunc(Date.now() / 1000).toString();
    const signature = sign(null, Buffer.from(`${timestamp}.${body}`), this.signingKey).toString(
      'base64',
    );

    let status = 0;
    if (await this.safeToSend(delivery.webhook_endpoint.url)) {
      try {
        const response = (await fetch(delivery.webhook_endpoint.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'aora-event-id': delivery.event_id,
            'aora-signature': `t=${timestamp},v1=${signature}`,
            'aora-mode': 'sandbox',
          },
          body,
          redirect: 'manual',
          signal: AbortSignal.timeout(10_000),
        })) as unknown as { status: number };
        status = response.status;
      } catch {
        status = 0;
      }
    }
    const attempts = delivery.attempts + 1;
    const delivered = status >= 200 && status < 300;
    const dead = !delivered && attempts >= this.config.webhooks.maxAttempts;
    await this.db.asPlatform(async (tx) => {
      await tx.webhook_delivery.update({
        where: { id: delivery.id },
        data: {
          attempts,
          last_response_status: status === 0 ? null : status,
          status: delivered ? 'delivered' : dead ? 'dead' : 'pending',
          ...(delivered ? { delivered_at: new Date() } : {}),
        },
      });
      if (!delivered && !dead) {
        await this.outbox.enqueue(tx, {
          tenantId: delivery.tenant_id,
          type: EVENT_WEBHOOK_DELIVER,
          payload: { delivery_id: delivery.id },
          availableAt: new Date(Date.now() + 30_000 * 2 ** (attempts - 1)),
        });
      }
    });
    if (dead)
      this.logger.warn(
        `webhook delivery ${delivery.id} is dead after ${String(attempts)} attempts`,
      );
  }

  /** On a deployed environment the hostname must not resolve to a private address. */
  private async safeToSend(url: string): Promise<boolean> {
    if (!isAllowedWebhookUrl(url, this.config.deployed)) return false;
    if (!this.config.deployed) return true;
    try {
      const addresses = await lookup(new URL(url).hostname, { all: true });
      return addresses.every((entry) => !isPrivateAddress(entry.address));
    } catch {
      return false;
    }
  }
}

function keyView(row: Prisma.api_keyGetPayload<object>): ApiKeyView {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scope: row.scope as KeyScope,
    created_at: row.created_at.toISOString(),
    last_used_at: row.last_used_at?.toISOString() ?? null,
    revoked_at: row.revoked_at?.toISOString() ?? null,
  };
}

function endpointView(row: Prisma.webhook_endpointGetPayload<object>): EndpointView {
  return {
    id: row.id,
    url: row.url,
    event_types: row.event_types,
    status: row.status,
    created_at: row.created_at.toISOString(),
  };
}
