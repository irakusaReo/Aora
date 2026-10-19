import { describe, expect, it } from 'vitest';
import { IntentKeys, type KeyValueStore } from '../src/intent-keys';

// ADR 0016 rule 2 and K8: the idempotency key of a money action is created
// before the first attempt and survives the app being killed. Written first
// (CLAUDE.md: tests strictly first for idempotency).

/** Stands in for the device's secure storage: it outlives any one IntentKeys. */
function memoryStore(): KeyValueStore & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => Promise.resolve(entries.get(key) ?? null),
    setItem: (key, value) => {
      entries.set(key, value);
      return Promise.resolve();
    },
    deleteItem: (key) => {
      entries.delete(key);
      return Promise.resolve();
    },
  };
}

function counter(): () => string {
  let next = 0;
  return () => `id-${String(++next)}`;
}

describe('intent keys', () => {
  it('gives the same key for the same slot on every retry', async () => {
    const keys = new IntentKeys(memoryStore(), counter());
    const first = await keys.keyFor('kony.payout:r1:5000');
    expect(await keys.keyFor('kony.payout:r1:5000')).toBe(first);
  });

  it('gives the same key after the app restarts', async () => {
    const store = memoryStore();
    const ids = counter();
    const before = await new IntentKeys(store, ids).keyFor('kelo.instalment:p1:3');
    // A new process: new IntentKeys, same secure storage.
    const after = await new IntentKeys(store, ids).keyFor('kelo.instalment:p1:3');
    expect(after).toBe(before);
  });

  it('saves the key before handing it out', async () => {
    const store = memoryStore();
    const key = await new IntentKeys(store, counter()).keyFor('chiwo.pay:AB12CD34:15000');
    expect([...store.entries.values()]).toContain(key);
  });

  it('never shares a key between slots', async () => {
    const keys = new IntentKeys(memoryStore(), counter());
    const a = await keys.keyFor('kony.payout:r1:5000');
    const b = await keys.keyFor('kony.payout:r1:5001');
    expect(a).not.toBe(b);
  });

  it('issues a new key only after the slot is settled', async () => {
    const keys = new IntentKeys(memoryStore(), counter());
    const first = await keys.keyFor('kony.refund:pi_1:100');
    expect(await keys.pending('kony.refund:pi_1:100')).toBe(first);
    await keys.settle('kony.refund:pi_1:100');
    expect(await keys.pending('kony.refund:pi_1:100')).toBeNull();
    expect(await keys.keyFor('kony.refund:pi_1:100')).not.toBe(first);
  });

  it('stores slots under names secure storage accepts, without collisions', async () => {
    const store = memoryStore();
    const keys = new IntentKeys(store, counter());
    await keys.keyFor('a:b');
    await keys.keyFor('a_b');
    await keys.keyFor('a/b c');
    const names = [...store.entries.keys()];
    expect(new Set(names).size).toBe(3);
    for (const name of names) expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});
