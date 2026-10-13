import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Guards CLAUDE.md rules 9 and 10: .env.example holds placeholders only,
// and the only mode it offers is sandbox.

const path = fileURLToPath(new URL('../.env.example', import.meta.url));

const entries = readFileSync(path, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('#'))
  .map((line) => {
    const index = line.indexOf('=');
    return { key: line.slice(0, index), value: line.slice(index + 1) };
  });

const SENSITIVE_KEY = /SECRET|PASSWORD|PRIVATE|TOKEN|MNEMONIC|SEED|API_?KEY|_KEY$/;
const PLACEHOLDER = /^<[a-z0-9-]+>$/;
// Long hex or base64-like runs look like key material, not placeholders.
const KEY_MATERIAL = /(0x)?[0-9a-fA-F]{32,}|[A-Za-z0-9+/_-]{40,}/;

describe('.env.example', () => {
  it('defines at least one variable, each as KEY=value', () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const { key } of entries) {
      expect(key).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it('offers sandbox as the only mode', () => {
    expect(entries.find((entry) => entry.key === 'AORA_MODE')?.value).toBe('sandbox');
  });

  it('gives sensitive variables an empty or <placeholder> value', () => {
    for (const { key, value } of entries.filter((entry) => SENSITIVE_KEY.test(entry.key))) {
      expect(value === '' || PLACEHOLDER.test(value), key).toBe(true);
    }
  });

  it('contains nothing that looks like key material', () => {
    for (const { key, value } of entries) {
      expect(KEY_MATERIAL.test(value), key).toBe(false);
    }
  });

  it('uses <placeholder> credentials in connection strings', () => {
    for (const { key, value } of entries.filter((entry) => entry.value.includes('://'))) {
      expect(value, key).toMatch(/:\/\/<[a-z0-9-]+>:<[a-z0-9-]+>@/);
    }
  });
});
