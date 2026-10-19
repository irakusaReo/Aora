import { AoraApiError, AoraNetworkError } from '@aora/api-client';
import { describe, expect, it } from 'vitest';
import { classify } from '../src/outcome';

// ADR 0016 rule 3, CLAUDE.md rules 6 and 7: a timeout is "we are checking",
// never "failed" and never "done". Written first.

describe('outcome of a failed request', () => {
  it('is unknown after a timeout or a lost connection', () => {
    expect(classify(new AoraNetworkError('timeout')).kind).toBe('unknown');
    expect(classify(new AoraNetworkError('network')).kind).toBe('unknown');
  });

  it('is unknown when the API itself failed (5xx)', () => {
    expect(classify(new AoraApiError(500, 'internal_error', 'x', null)).kind).toBe('unknown');
    expect(classify(new AoraApiError(503, 'internal_error', 'x', null)).kind).toBe('unknown');
  });

  it('asks for the PIN when the API wants a step-up', () => {
    expect(classify(new AoraApiError(403, 'step_up_required', 'PIN', null)).kind).toBe('step_up');
  });

  it('is a refusal, in the API’s own words, when the API answered with a code', () => {
    const outcome = classify(new AoraApiError(409, 'fee_changed', 'The fee changed.', 'req_1'));
    expect(outcome).toEqual({ kind: 'refused', code: 'fee_changed', message: 'The fee changed.' });
  });

  it('treats a signed-out session as its own case', () => {
    expect(classify(new AoraApiError(401, 'unauthenticated', 'x', null)).kind).toBe('signed_out');
  });

  it('treats anything unrecognised as unknown, never as failed', () => {
    expect(classify(new Error('boom')).kind).toBe('unknown');
    expect(classify('weird').kind).toBe('unknown');
  });
});
