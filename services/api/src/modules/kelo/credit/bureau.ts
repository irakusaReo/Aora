/**
 * SANDBOX credit bureau (owner decision 2026-10-18: simulators only). No real
 * bureau is contacted and nothing is ever reported to one. The result is
 * scripted by the caller; without a script, a person has a thin file.
 */
export const BUREAU_RESULTS = ['clear', 'thin_file', 'adverse'] as const;
export type BureauResult = (typeof BUREAU_RESULTS)[number];

export function sandboxBureau(scripted: BureauResult | null): BureauResult {
  return scripted ?? 'thin_file';
}
