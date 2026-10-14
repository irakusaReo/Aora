// Money on screens (CLAUDE.md rule 3). Amounts travel as strings of minor
// units and are converted with string and bigint arithmetic only: never a
// JavaScript number, never parseFloat. The exponent always comes from the
// asset, never an assumption of two decimal places.

const MAX = 9_223_372_036_854_775_807n;

/** `"15000"`, 2 → `"150.00"`. Display only: never parse the result back for arithmetic. */
export function formatMinor(minor: string, exponent: number): string {
  const digits = BigInt(minor)
    .toString()
    .padStart(exponent + 1, '0');
  const whole = exponent === 0 ? digits : digits.slice(0, -exponent);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return exponent === 0 ? grouped : `${grouped}.${digits.slice(-exponent)}`;
}

/**
 * What a person typed (`"1,250.05"`) → minor units (`"125005"`), or null if it
 * is not an exact positive amount in an asset with this exponent. Thousands
 * separators are allowed; anything more precise than the asset is refused, not rounded.
 */
export function toMinorUnits(typed: string, exponent: number): string | null {
  const text = typed.trim().replaceAll(',', '');
  const match = /^([0-9]+)(?:\.([0-9]+))?$/.exec(text);
  if (!match) return null;
  const whole = match[1] ?? '';
  const fraction = match[2] ?? '';
  if (fraction.length > exponent) return null;
  const minor = BigInt(whole + fraction.padEnd(exponent, '0'));
  if (minor <= 0n || minor > MAX) return null;
  return minor.toString();
}
