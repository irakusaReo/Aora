import { formatMinor } from '@aora/api-client';

// Amounts stay strings of minor units until this last step (ADR 0016 rule 1,
// CLAUDE.md rule 3). The exponent always comes from the API's asset list.

/** `money('15000', 'KES', 2)` → `"KES 150.00"`. Display only. */
export function money(minor: string, code: string, exponent: number): string {
  const negative = minor.startsWith('-');
  const text = `${code} ${formatMinor(negative ? minor.slice(1) : minor, exponent)}`;
  return negative ? `−${text}` : text;
}
