import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SIM_SIGNATURE_HEADER, SimulatorProvider } from '../src/modules/payments/simulator.js';
import { type Harness, startHarness } from './support/harness.js';
import {
  type Caller,
  createIntent,
  exceptionTypes,
  ledgerFor,
  statusOf,
} from './support/payments.js';

let h: Harness;
let admin: Caller;
let simulator: SimulatorProvider;

beforeAll(async () => {
  h = await startHarness();
  admin = { token: await h.signIn('adminA'), workspace: h.seed.tenantA };
  simulator = h.app.get(SimulatorProvider);
});
afterAll(() => h.close());

function event(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event_id: randomUUID(),
    type: 'collection.result',
    operation_ref: randomUUID(),
    provider_reference: randomUUID(),
    result: 'succeeded',
    amount_minor: '1000',
    asset: 'KES',
    ...overrides,
  });
}

const post = (body: string, signature?: string) => {
  const call = h.http().post('/v1/webhooks/sandbox').set('Content-Type', 'application/json');
  return (signature ? call.set(SIM_SIGNATURE_HEADER, signature) : call).send(body);
};

const storedCount = async (): Promise<number> =>
  h.owner(async (client) => {
    const result = await client.query<{ n: string }>(
      `select count(*) as n from payments.webhook_event`,
    );
    return Number(result.rows[0]?.n);
  });

describe('webhook intake', () => {
  it('rejects a missing, wrong or mismatched signature, stores nothing, and audits the attempt', async () => {
    const body = event();
    const before = await storedCount();
    const missing = await post(body);
    const wrong = await post(body, 'sha256=' + '0'.repeat(64));
    const forOtherBody = await post(body, simulator.sign(event()));
    for (const response of [missing, wrong, forOtherBody]) {
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('invalid_signature');
    }
    expect(await storedCount()).toBe(before);
    const audits = await h.owner((client) =>
      client.query(
        `select count(*) as n from audit.audit_event where action = 'payments.webhook.rejected' and outcome = 'denied'`,
      ),
    );
    expect(audits.rows[0]?.n).toBe('3');
  });

  it('stores the payload byte for byte and acknowledges', async () => {
    // Unusual spacing and key order must survive: the signature covers these exact bytes.
    const body = `{ "event_id":"${randomUUID()}",   "type":"collection.result","operation_ref":"${randomUUID()}",
      "provider_reference":"p-1","result":"failed","amount_minor":"1000","asset":"KES" }`;
    const response = await post(body, simulator.sign(body));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true, mode: 'sandbox' });
    const stored = await h.owner((client) =>
      client.query(
        `select payload_raw from payments.webhook_event order by received_at desc limit 1`,
      ),
    );
    expect(stored.rows[0]?.payload_raw).toBe(body);
  });

  it('accepts a duplicate delivery and stores and queues it once', async () => {
    const body = event();
    const signature = simulator.sign(body);
    const before = await storedCount();
    expect((await post(body, signature)).status).toBe(200);
    expect((await post(body, signature)).status).toBe(200);
    expect(await storedCount()).toBe(before + 1);
    const queued = await h.owner((client) =>
      client.query(
        `select count(*) as n from outbox.outbox_event o join payments.webhook_event w
           on w.id::text = o.payload->>'webhook_event_id'
         where w.provider_event_id = $1`,
        [JSON.parse(body).event_id],
      ),
    );
    expect(queued.rows[0]?.n).toBe('1');
  });

  it('rejects a correctly signed payload that is not a recognised event', async () => {
    const body = JSON.stringify({ hello: 'world' });
    const response = await post(body, simulator.sign(body));
    expect(response.status).toBe(400);
  });

  it('never changes or deletes a stored payload', async () => {
    const body = event();
    await post(body, simulator.sign(body));
    await expect(
      h.owner((client) => client.query(`update payments.webhook_event set payload_raw = '{}'`)),
    ).rejects.toThrow(/never changed/);
    await expect(
      h.owner((client) => client.query(`delete from payments.webhook_event`)),
    ).rejects.toThrow(/append-only/);
  });

  it('records a result for a payment AORA does not know as an exception, not an error', async () => {
    const reference = `prov-${randomUUID()}`;
    const body = event({ provider_reference: reference });
    await post(body, simulator.sign(body));
    await h.settle();
    expect(await exceptionTypes(h, reference)).toEqual(['missing_internal']);
    const outbox = await h.owner((client) =>
      client.query(
        `select count(*) as n from outbox.outbox_event where status in ('dead', 'pending')`,
      ),
    );
    expect(outbox.rows[0]?.n).toBe('0');
  });

  it('cannot be used to mark a payment paid with a forged amount', async () => {
    const created = await createIntent(h, admin, { amount_minor: '50000', currency: 'KES' });
    const id = created.body.id as string;
    await h.settle(); // genuine success arrives first
    expect(await statusOf(h, admin, id)).toBe('succeeded');

    const body = event({ operation_ref: id, amount_minor: '1' });
    await post(body, simulator.sign(body));
    await h.settle();
    expect(await statusOf(h, admin, id)).toBe('reconciliation_required');
    // The genuine entry stands; nothing was added or removed.
    expect(await ledgerFor(h, id)).toEqual({ entries: 1, credited: '50000' });
  });
});
