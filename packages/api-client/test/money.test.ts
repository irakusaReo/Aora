import { describe, expect, it } from 'vitest';
import { formatMinor, toMinorUnits } from '../src/money';

describe('money for screens: exact, no floating point', () => {
  it('formats minor units with the asset exponent', () => {
    expect(formatMinor('15000', 2)).toBe('150.00');
    expect(formatMinor('5', 2)).toBe('0.05');
    expect(formatMinor('0', 2)).toBe('0.00');
    expect(formatMinor('1234567', 6)).toBe('1.234567');
    expect(formatMinor('42', 0)).toBe('42');
    expect(formatMinor('123456789012345678', 2)).toBe('1,234,567,890,123,456.78');
  });

  it('turns what a person typed into minor units exactly', () => {
    expect(toMinorUnits('150', 2)).toBe('15000');
    expect(toMinorUnits('150.5', 2)).toBe('15050');
    expect(toMinorUnits(' 1,250.05 ', 2)).toBe('125005');
    expect(toMinorUnits('0.1', 2)).toBe('10');
    expect(toMinorUnits('0.000001', 6)).toBe('1');
    expect(toMinorUnits('92233720368547758.07', 2)).toBe('9223372036854775807');
  });

  it('refuses anything that is not an exact positive amount in that asset', () => {
    for (const bad of [
      '',
      'abc',
      '-5',
      '1e3',
      '0',
      '0.00',
      '1.234',
      '1.2.3',
      '१२',
      'NaN',
      '92233720368547758.08',
    ]) {
      expect(toMinorUnits(bad, 2), bad).toBeNull();
    }
    expect(toMinorUnits('1.5', 0)).toBeNull();
  });

  it('round-trips every formatted amount', () => {
    for (const minor of ['1', '99', '100', '10050', '987654321']) {
      expect(toMinorUnits(formatMinor(minor, 2), 2)).toBe(minor);
    }
  });
});
