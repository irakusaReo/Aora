import { AppError } from './errors.js';

const MAX_BIGINT = 9_223_372_036_854_775_807n;
const DIGITS = /^(0|[1-9][0-9]{0,18})$/;

/**
 * Parses an amount in minor units. Only a string of decimal digits is accepted:
 * no JSON numbers (they are floats), no decimal point, exponent, sign, spaces
 * or leading zeros. The result is an exact bigint.
 */
export function parseMinorUnits(value: unknown): bigint {
  if (typeof value !== 'string' || !DIGITS.test(value)) {
    throw new AppError(
      'invalid_request',
      'Amount must be a string of digits in minor units, for example "15000".',
    );
  }
  const amount = BigInt(value);
  if (amount <= 0n || amount > MAX_BIGINT) {
    throw new AppError('invalid_request', 'Amount is out of range.');
  }
  return amount;
}

/** Display only. Never parse the result back into an amount. */
export function formatMinorUnits(amount: bigint, exponent: number): string {
  const digits = amount.toString().padStart(exponent + 1, '0');
  return exponent === 0 ? digits : `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
}
