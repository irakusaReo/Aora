import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAllowedWebhookUrl } from '../src/modules/developer/developer.service.js';
import { type Harness, startHarness } from './support/harness.js';
import { type Caller, createIntent } from './support/payments.js';

interface Received {
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let h: Harness;
let admin: Caller;
let receiver: Server;
let receiverUrl: string;
const received: Received[] = [];
let failNext = 0;

const keyPair = generateKeyPairSync('ed25519');

const asAdmin = (method: 'get' | 'post' | 'delete', path: string) =>
  h
    .http()
    [method](path)
    .set('Authorization', `Bearer ${admin.token}`)
    .set('Aora-Workspace-Id', admin.workspace);

const withKey = (key: string, method: 'get' | 'post', path: string, workspace = h.seed.tenantA) =>
  h.http()[method](path).set('Authorization', `Bearer ${key}`).set('Aora-Workspace-Id', workspace);

beforeAll(async () => {
  receiver = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    request.on('end', () => {
      received.push({ headers: request.headers, body });
      if (failNext > 0) {
        failNext -= 1;
        response.writeHead(500).end();
        return;
      }
      response.writeHead(200).end('ok');
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const address = receiver.address();
  receiverUrl = `http://127.0.0.1:${String(typeof address === 'object' && address ? address.port : 0)}/hooks`;

  h = await startHarness({
    config: (config) => ({
      ...config,
      outbox: { maxAttempts: 8, retryDelaySeconds: 0 },
      webhooks: {
        signingPrivateKey: keyPair.privateKey
          .export({ type: 'pkcs8', format: 'der' })
          .toString('base64'),
        maxAttempts: 3,
      },
    }),
  });
  admin = { token: await h.signIn('adminA'), workspace: h.seed.tenantA };
  await h.stepUp(admin.token);
});
afterAll(async () => {
  await h.close();
  await new Promise<void>((resolve) => {
    receiver.close(() => {
      resolve();
    });
  });
});

describe('API keys (journey J7)', () => {
  let collectKey = '';
  let keyId = '';

  it('shows a new key once, and stores only its hash', async () => {
    const created = await asAdmin('post', '/v1/api-keys').send({
      name: 'Till integration',
      scope: 'collect',
    });
    expect(created.status).toBe(201);
    collectKey = created.body.key as string;
    keyId = created.body.id as string;
    expect(collectKey).toMatch(/^aora_sk_sandbox_[A-Za-z0-9]{32,}$/);
    expect(created.body).toMatchObject({
      name: 'Till integration',
      scope: 'collect',
      prefix: collectKey.slice(0, 20),
    });

    const listed = await asAdmin('get', '/v1/api-keys');
    expect(JSON.stringify(listed.body)).not.toContain(collectKey);
    const stored = await h.owner((client) =>
      client.query(`select row_to_json(k)::text as row from developer.api_key k`),
    );
    expect(stored.rows[0].row).not.toContain(collectKey);
  });

  it('needs an admin and a PIN step-up to create', async () => {
    const finance = await h.signIn('financeA');
    await h.stepUp(finance);
    const denied = await h
      .http()
      .post('/v1/api-keys')
      .set('Authorization', `Bearer ${finance}`)
      .set('Aora-Workspace-Id', h.seed.tenantA)
      .send({ name: 'x', scope: 'collect' });
    expect(denied.status).toBe(403);
  });

  it('calls /v1 idempotently with the key', async () => {
    const key = randomUUID();
    const first = await withKey(collectKey, 'post', '/v1/payment-intents')
      .set('Idempotency-Key', key)
      .send({ amount_minor: '5000', currency: 'KES', sandbox_scenario: 'success' });
    expect(first.status).toBe(201);
    const again = await withKey(collectKey, 'post', '/v1/payment-intents')
      .set('Idempotency-Key', key)
      .send({ amount_minor: '5000', currency: 'KES', sandbox_scenario: 'success' });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect(
      (await withKey(collectKey, 'get', `/v1/payment-intents/${first.body.id as string}`)).status,
    ).toBe(200);
  });

  it('acts only within its scope and its own workspace', async () => {
    expect((await withKey(collectKey, 'get', '/v1/ledger/balances')).status).toBe(403);
    expect((await withKey(collectKey, 'get', '/v1/payment-intents', h.seed.tenantB)).status).toBe(
      403,
    );
  });

  it('can never do anything that needs a PIN step-up, nor manage keys', async () => {
    const full = await asAdmin('post', '/v1/api-keys').send({ name: 'Back office', scope: 'full' });
    const fullKey = full.body.key as string;
    const invite = await withKey(fullKey, 'post', '/v1/workspace/invitations').send({
      email: 'x@people.aora.test',
      role: 'cashier',
    });
    expect(invite.status).toBe(403);
    expect(
      (await withKey(fullKey, 'post', '/v1/api-keys').send({ name: 'y', scope: 'full' })).status,
    ).toBe(403);
    expect((await withKey(fullKey, 'get', '/v1/ledger/balances')).status).toBe(200);
  });

  it('stops working the moment it is revoked', async () => {
    const revoked = await asAdmin('delete', `/v1/api-keys/${keyId}`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.revoked_at).toEqual(expect.any(String));
    const after = await withKey(collectKey, 'get', '/v1/payment-intents');
    expect(after.status).toBe(401);
  });

  it('refuses a made-up key without revealing whether a key exists', async () => {
    const response = await withKey(
      'aora_sk_sandbox_' + 'A'.repeat(40),
      'get',
      '/v1/payment-intents',
    );
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('unauthenticated');
  });

  it('records which key acted, in the audit trail', async () => {
    const rows = await h.owner((client) =>
      client.query(
        `select count(*)::int as n from audit.audit_event where action = 'payments.intent.created' and detail ? 'api_key_id'`,
      ),
    );
    expect(rows.rows[0].n).toBeGreaterThan(0);
  });
});

describe('signed webhooks', () => {
  let publicKeyPem = '';
  let endpointId = '';

  it('publishes the public key that verifies every webhook', async () => {
    const response = await h.http().get('/v1/webhook-signing-key');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ algorithm: 'ed25519' });
    publicKeyPem = response.body.public_key_pem as string;
    expect(createPublicKey(publicKeyPem).asymmetricKeyType).toBe('ed25519');
  });

  it('registers an endpoint (admin, PIN step-up) and refuses an address that is not allowed', async () => {
    const bad = await asAdmin('post', '/v1/webhook-endpoints').send({
      url: 'ftp://example.com/x',
      event_types: ['payment_intent.succeeded'],
    });
    expect(bad.status).toBe(400);
    const created = await asAdmin('post', '/v1/webhook-endpoints').send({
      url: receiverUrl,
      event_types: ['payment_intent.succeeded', 'payment_intent.failed'],
    });
    expect(created.status).toBe(201);
    endpointId = created.body.id as string;
  });

  it('delivers a signed event when a collection succeeds, which verifies with the published key', async () => {
    // Finish anything earlier tests started, so only this collection's event is counted.
    await h.settle();
    received.length = 0;
    const intent = await createIntent(h, admin, {
      amount_minor: '7000',
      currency: 'KES',
      sandbox_scenario: 'success',
    });
    await h.settle();
    expect(received).toHaveLength(1);
    const delivery = received[0];
    if (!delivery) return;
    const event = JSON.parse(delivery.body) as {
      id: string;
      type: string;
      data: { id: string };
      mode: string;
    };
    expect(event).toMatchObject({
      type: 'payment_intent.succeeded',
      mode: 'sandbox',
      data: { id: intent.body.id },
    });
    expect(delivery.headers['aora-event-id']).toBe(event.id);

    const signature = String(delivery.headers['aora-signature']);
    const [, timestamp, signed] = /^t=(\d+),v1=([A-Za-z0-9+/=]+)$/.exec(signature) ?? [];
    const key = createPublicKey(publicKeyPem);
    expect(
      verify(
        null,
        Buffer.from(`${timestamp ?? ''}.${delivery.body}`),
        key,
        Buffer.from(signed ?? '', 'base64'),
      ),
    ).toBe(true);
    // A changed body no longer verifies.
    expect(
      verify(
        null,
        Buffer.from(`${timestamp ?? ''}.${delivery.body} `),
        key,
        Buffer.from(signed ?? '', 'base64'),
      ),
    ).toBe(false);
  });

  it('retries a failing endpoint, logs each attempt, and gives up after the configured attempts', async () => {
    received.length = 0;
    failNext = 10;
    await createIntent(h, admin, {
      amount_minor: '7100',
      currency: 'KES',
      sandbox_scenario: 'decline',
    });
    for (let round = 0; round < 5; round += 1) {
      await h.makeDelayedEventsDue();
      await h.settle();
    }
    failNext = 0;
    expect(received).toHaveLength(3);
    const log = await asAdmin('get', '/v1/webhook-deliveries');
    const latest = (log.body.data as { status: string; attempts: number; event_type: string }[])[0];
    expect(latest).toMatchObject({
      status: 'dead',
      attempts: 3,
      event_type: 'payment_intent.failed',
    });
  });

  it('replays a delivery with the same event id, so a receiver that deduplicates sees no second effect', async () => {
    const log = await asAdmin('get', '/v1/webhook-deliveries');
    const dead = (log.body.data as { id: string; event_id: string }[])[0];
    received.length = 0;
    const replay = await asAdmin('post', `/v1/webhook-deliveries/${dead?.id ?? ''}/replay`);
    expect(replay.status).toBe(201);
    await h.settle();
    expect(received).toHaveLength(1);
    const event = JSON.parse(received[0]?.body ?? '{}') as { id: string };
    expect(event.id).toBe(dead?.event_id);
    const effects = new Set([event.id, dead?.event_id]);
    expect(effects.size).toBe(1);
  });

  it('never sends one workspace’s events to another’s endpoint', async () => {
    received.length = 0;
    const other = { token: await h.signIn('adminB'), workspace: h.seed.tenantB };
    await createIntent(h, other, {
      amount_minor: '3000',
      currency: 'KES',
      sandbox_scenario: 'success',
    });
    await h.settle();
    expect(received).toHaveLength(0);
    expect(endpointId).not.toBe('');
  });
});

describe('webhook addresses', () => {
  it('allows only https on a deployed environment, and never a private or loopback address', () => {
    expect(isAllowedWebhookUrl('https://merchant.example.com/hooks', true)).toBe(true);
    for (const url of [
      'http://merchant.example.com/hooks',
      'https://127.0.0.1/x',
      'https://10.0.0.5/x',
      'https://192.168.1.2/x',
      'https://172.16.0.1/x',
      'https://169.254.169.254/latest',
      'https://localhost/x',
      'https://[::1]/x',
      'https://user:pass@merchant.example.com/x',
    ]) {
      expect(isAllowedWebhookUrl(url, true), url).toBe(false);
    }
    // On a developer machine, a local receiver is allowed for tests.
    expect(isAllowedWebhookUrl('http://127.0.0.1:4000/hooks', false)).toBe(true);
  });
});
