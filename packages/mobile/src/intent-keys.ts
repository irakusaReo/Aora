// Idempotency keys for money actions taken on a device (ADR 0016 rule 2,
// phase-9 P9-7). A slot names one request: the action and every input that
// defines it, for example `kony.payout:<recipient>:<amount>`. Its key is saved
// before the first attempt, reused on every retry and after the app is killed,
// and released only once the outcome is definite. An unknown outcome keeps the
// key, so "check again" repeats the same request and the API answers from its
// record instead of acting twice (CLAUDE.md rule 6).

/** The device's secure storage, or an in-memory stand-in in tests. */
export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

const PREFIX = 'aora.intent.';

/**
 * Secure storage accepts letters, digits, `.`, `-` and `_` in a name. Every
 * other character, and `_` itself, becomes `_` and its code in hex, so two
 * different slots never share a name.
 */
function storageName(slot: string): string {
  return (
    PREFIX +
    slot.replace(/[^A-Za-z0-9.-]/g, (char) => `_${(char.codePointAt(0) ?? 0).toString(16)}_`)
  );
}

export class IntentKeys {
  constructor(
    private readonly store: KeyValueStore,
    private readonly newId: () => string,
  ) {}

  /** The key for this request: the saved one, or a new one saved before it is returned. */
  async keyFor(slot: string): Promise<string> {
    const name = storageName(slot);
    const saved = await this.store.getItem(name);
    if (saved) return saved;
    const key = this.newId();
    await this.store.setItem(name, key);
    return key;
  }

  /** The saved key, if a request in this slot has not reached a definite outcome. */
  pending(slot: string): Promise<string | null> {
    return this.store.getItem(storageName(slot));
  }

  /** The outcome is definite (done, or refused by the API): the next request is a new one. */
  settle(slot: string): Promise<void> {
    return this.store.deleteItem(storageName(slot));
  }
}
