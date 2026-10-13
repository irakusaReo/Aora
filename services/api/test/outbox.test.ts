import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type OutboxEvent, OutboxService } from '../src/modules/outbox/outbox.service.js';
import { type Harness, startHarness } from './support/harness.js';

let h: Harness;
let outbox: OutboxService;
const seen: OutboxEvent[] = [];
let failures = 0;

beforeAll(async () => {
  h = await startHarness({
    config: (config) => ({ ...config, outbox: { maxAttempts: 3, retryDelaySeconds: 0 } }),
  });
  outbox = h.app.get(OutboxService);
  outbox.register('test.record', (event) => {
    seen.push(event);
    return Promise.resolve();
  });
  outbox.register('test.fail', () => {
    failures += 1;
    return Promise.reject(new Error('secret-detail-that-must-not-be-stored'));
  });
});
afterAll(() => h.close());
beforeEach(async () => {
  await h.owner((client) => client.query(`delete from outbox.outbox_event`));
  seen.length = 0;
  failures = 0;
});

const rows = (): Promise<
  { type: string; status: string; attempts: number; last_error: string | null }[]
> =>
  h.owner(async (client) => {
    const result = await client.query(
      `select type, status, attempts, last_error from outbox.outbox_event order by created_at`,
    );
    return result.rows;
  });

describe('transactional outbox', () => {
  it('stores the event only if the surrounding transaction commits', async () => {
    await expect(
      h.db.asPlatform(async (tx) => {
        await outbox.enqueue(tx, { tenantId: null, type: 'test.record', payload: { n: 1 } });
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    expect(await rows()).toEqual([]);

    await h.db.asPlatform((tx) =>
      outbox.enqueue(tx, { tenantId: null, type: 'test.record', payload: { n: 2 } }),
    );
    expect(await outbox.runUntilIdle()).toBe(1);
    expect(seen.map((event) => event.payload)).toEqual([{ n: 2 }]);
    expect(await rows()).toEqual([
      { type: 'test.record', status: 'done', attempts: 1, last_error: null },
    ]);
  });

  it('delivers each event once when several workers run at the same time', async () => {
    await h.db.asPlatform(async (tx) => {
      for (let n = 0; n < 25; n += 1) {
        await outbox.enqueue(tx, { tenantId: null, type: 'test.record', payload: { n } });
      }
    });
    await Promise.all(Array.from({ length: 5 }, () => outbox.runUntilIdle()));
    expect(seen).toHaveLength(25);
    expect(new Set(seen.map((event) => event.id)).size).toBe(25);
  });

  it('retries a failing handler, then marks the event dead, storing no error detail', async () => {
    await h.db.asPlatform((tx) =>
      outbox.enqueue(tx, { tenantId: null, type: 'test.fail', payload: {} }),
    );
    await outbox.runUntilIdle();
    expect(failures).toBe(3);
    expect(await rows()).toEqual([
      { type: 'test.fail', status: 'dead', attempts: 3, last_error: 'Error' },
    ]);
    expect(await outbox.runUntilIdle()).toBe(0);
  });

  it('marks an event with no registered handler dead instead of dropping it', async () => {
    await h.db.asPlatform((tx) =>
      outbox.enqueue(tx, { tenantId: null, type: 'test.nobody-listens', payload: {} }),
    );
    await outbox.runUntilIdle();
    expect((await rows())[0]?.status).toBe('dead');
  });

  it('does not deliver an event before it is due', async () => {
    await h.db.asPlatform((tx) =>
      outbox.enqueue(tx, {
        tenantId: null,
        type: 'test.record',
        payload: {},
        availableAt: new Date(Date.now() + 60_000),
      }),
    );
    expect(await outbox.runUntilIdle()).toBe(0);
    await h.owner((client) => client.query(`update outbox.outbox_event set available_at = now()`));
    expect(await outbox.runUntilIdle()).toBe(1);
  });

  it('picks up an event abandoned by a worker that died while processing it', async () => {
    await h.db.asPlatform((tx) =>
      outbox.enqueue(tx, { tenantId: null, type: 'test.record', payload: {} }),
    );
    await h.owner((client) =>
      client.query(`update outbox.outbox_event set status = 'processing', locked_at = now()`),
    );
    expect(await outbox.runUntilIdle()).toBe(0);
    await h.owner((client) =>
      client.query(`update outbox.outbox_event set locked_at = now() - interval '10 minutes'`),
    );
    expect(await outbox.runUntilIdle()).toBe(1);
    expect(seen).toHaveLength(1);
  });

  it('lets a tenant request enqueue only for its own tenant, and read nothing', async () => {
    const enqueue = (tenantId: string): Promise<string> =>
      h.db.withTenant(h.seed.tenantA, (tx) =>
        outbox.enqueue(tx, { tenantId, type: 'test.record', payload: {} }),
      );
    await expect(enqueue(h.seed.tenantB)).rejects.toThrow(/row-level security/);
    await expect(
      h.db.withTenant(h.seed.tenantA, (tx) => tx.outbox_event.findMany()),
    ).rejects.toThrow(/permission denied/);
  });
});
