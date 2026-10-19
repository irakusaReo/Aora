import { describe, expect, it } from 'vitest';
import { translator } from '../src/i18n';

describe('translator (ADR 0016 rule 11)', () => {
  const t = translator({ 'pay.total': 'Total: {amount}', 'pay.title': 'Pay' });

  it('fills named placeholders', () => {
    expect(t('pay.total', { amount: 'KES 150.00' })).toBe('Total: KES 150.00');
  });

  it('refuses a key that has no text, so missing copy fails a test instead of showing a key', () => {
    expect(() => t('pay.missing')).toThrow(/pay\.missing/);
  });

  it('refuses a placeholder left unfilled', () => {
    expect(() => t('pay.total')).toThrow(/amount/);
  });
});
