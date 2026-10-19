import { AoraApiError, AoraNetworkError } from '@aora/api-client';

// How a screen reads a failed request (ADR 0016 rule 3, phase-9 P9-8). Only an
// answer from the API with an error code is a refusal. A timeout, a lost
// connection, a server failure or anything unrecognised is unknown: the
// screen says "we are checking", never "failed" and never "done".

export type Outcome =
  | { kind: 'refused'; code: string; message: string }
  | { kind: 'step_up' }
  | { kind: 'signed_out' }
  | { kind: 'unknown' };

export function classify(error: unknown): Outcome {
  if (error instanceof AoraNetworkError) return { kind: 'unknown' };
  if (error instanceof AoraApiError) {
    if (error.status >= 500) return { kind: 'unknown' };
    if (error.code === 'step_up_required') return { kind: 'step_up' };
    if (error.status === 401) return { kind: 'signed_out' };
    return { kind: 'refused', code: error.code, message: error.message };
  }
  return { kind: 'unknown' };
}
