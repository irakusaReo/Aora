/**
 * Exact conversion of a database numeric(78,0) (a Prisma Decimal) to a bigint
 * (CLAUDE.md rule 3). The Decimal's string keeps every digit but may use
 * exponent notation for large values ("1.15e+77"), so the digits are re-placed
 * by hand; anything that is not a non-negative whole number is refused.
 */
export function exactInteger(value: { toString(): string }): bigint {
  const match = /^(\d+)(?:\.(\d+))?(?:e\+(\d+))?$/.exec(value.toString());
  if (!match) throw new Error('Expected a non-negative whole number.');
  const [, whole = '', fraction = '', exponent = '0'] = match;
  const shift = Number(exponent);
  if (fraction.length > shift && /[1-9]/.test(fraction.slice(shift))) {
    throw new Error('Expected a non-negative whole number.');
  }
  return BigInt(whole + fraction.slice(0, shift).padEnd(shift, '0'));
}
