import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  accruedInterest,
  type LineState,
  lateChargeFor,
  quoteRepayment,
} from '../src/modules/kelo/credit/repayment.js';
import { addDays, creditSchedule } from '../src/modules/kelo/schedule.js';

/**
 * Repayments (phase 8B): interest only to the day on early repayment (r. 56(4)),
 * allocation principal, then charges, then interest (r. 56(2)), late charges
 * capped by the agreement (r. 29, r. 30(2)). Written before the code.
 */

const START = '2026-10-19';
const MONTHLY = creditSchedule({
  priceMinor: 4_500_000n,
  terms: {
    instalmentCount: 6,
    intervalDays: 30,
    dailyRatePpm: 500,
    depositBps: 1000,
    firstPaymentAtCheckout: false,
    lateFeeTotalCapMinor: 60_000n,
  },
  startDate: START,
});

/** The monthly-financing lines with the deposit already paid. */
function monthlyLines(): LineState[] {
  return MONTHLY.lines.map((line) => ({
    seq: line.seq,
    due_on: line.due_on,
    principal_minor: line.principal_minor,
    interest_minor: line.interest_minor,
    paid_principal_minor: line.seq === 0 ? line.principal_minor : 0n,
    paid_interest_minor: 0n,
    interest_waived_minor: 0n,
    late_charges_minor: 0n,
    paid_charges_minor: 0n,
    status: line.seq === 0 ? 'paid' : 'due',
  }));
}

const TERMS = { intervalDays: 30, checkoutSeq: 0 };

describe('interest to the day', () => {
  it('accrues nothing before a part’s period starts, pro rata inside it, and all of it once due', () => {
    const [, first, second] = monthlyLines();
    if (!first || !second) throw new Error('schedule');
    expect(accruedInterest(first, START, TERMS)).toBe(0n);
    expect(accruedInterest(first, addDays(START, 10), TERMS)).toBe(20_250n);
    expect(accruedInterest(first, first.due_on, TERMS)).toBe(60_750n);
    expect(accruedInterest(first, addDays(first.due_on, 40), TERMS)).toBe(60_750n);
    expect(accruedInterest(second, addDays(START, 10), TERMS)).toBe(0n);
    // 50,625 × 5 / 30 = 8,437.5, half up.
    expect(accruedInterest(second, addDays(first.due_on, 5), TERMS)).toBe(8_438n);
  });
});

describe('quotes', () => {
  it('paying off on the first day costs the principal only, and waives all interest', () => {
    const quote = quoteRepayment({ lines: monthlyLines(), today: START, kind: 'payoff', ...TERMS });
    expect(quote).toMatchObject({
      amount_minor: 4_050_000n,
      principal_minor: 4_050_000n,
      charges_minor: 0n,
      interest_minor: 0n,
      waived_minor: 212_625n,
    });
    expect(quote.lines.map((line) => line.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('paying off ten days in costs ten days of interest on what is owed', () => {
    const quote = quoteRepayment({
      lines: monthlyLines(),
      today: addDays(START, 10),
      kind: 'payoff',
      ...TERMS,
    });
    expect(quote.amount_minor).toBe(4_050_000n + 20_250n);
    expect(quote.waived_minor).toBe(212_625n - 20_250n);
  });

  it('paying the next part early takes its principal and its interest so far', () => {
    const quote = quoteRepayment({
      lines: monthlyLines(),
      today: addDays(START, 10),
      kind: 'next',
      ...TERMS,
    });
    expect(quote).toMatchObject({
      amount_minor: 675_000n + 20_250n,
      principal_minor: 675_000n,
      interest_minor: 20_250n,
      waived_minor: 40_500n,
    });
    expect(quote.lines).toEqual([
      {
        seq: 1,
        principal_minor: 675_000n,
        charges_minor: 0n,
        interest_minor: 20_250n,
        waived_minor: 40_500n,
      },
    ]);
  });

  it('a late part costs its full interest and its late charge; principal is allocated first, then charges, then interest', () => {
    const lines = monthlyLines().map((line) =>
      line.seq === 1 ? { ...line, status: 'late', late_charges_minor: 10_000n } : line,
    );
    const first = lines[1];
    if (!first) throw new Error('schedule');
    const today = addDays(first.due_on, 6);
    const quote = quoteRepayment({ lines, today, kind: 'payoff', ...TERMS });
    // Line 1 in full with its charge; line 2 six days into its period.
    const second = (50_625n * 6n * 2n + 30n) / 60n;
    expect(quote.charges_minor).toBe(10_000n);
    expect(quote.interest_minor).toBe(60_750n + second);
    expect(quote.amount_minor).toBe(4_050_000n + 10_000n + 60_750n + second);
    expect(Object.keys(quote.lines[0] ?? {})).toEqual([
      'seq',
      'principal_minor',
      'charges_minor',
      'interest_minor',
      'waived_minor',
    ]);
  });

  it('skips paid and paused parts, and refuses when nothing is owed', () => {
    const lines = monthlyLines().map((line) =>
      line.seq === 1 ? { ...line, status: 'paused' } : line,
    );
    expect(quoteRepayment({ lines, today: START, kind: 'next', ...TERMS }).lines[0]?.seq).toBe(2);
    const paid = monthlyLines().map((line) => ({
      ...line,
      status: 'paid',
      paid_principal_minor: line.principal_minor,
      paid_interest_minor: line.interest_minor,
    }));
    expect(() => quoteRepayment({ lines: paid, today: START, kind: 'payoff', ...TERMS })).toThrow();
  });

  it('never asks more than the schedule plus charges, splits exactly, and never goes down with time', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 240 }), fc.integer({ min: 0, max: 60 }), (a, b) => {
        const lines = monthlyLines();
        const remaining = lines
          .filter((line) => line.status !== 'paid')
          .reduce((sum, line) => sum + line.principal_minor + line.interest_minor, 0n);
        const earlier = quoteRepayment({
          lines,
          today: addDays(START, a),
          kind: 'payoff',
          ...TERMS,
        });
        const later = quoteRepayment({
          lines,
          today: addDays(START, a + b),
          kind: 'payoff',
          ...TERMS,
        });
        for (const quote of [earlier, later]) {
          expect(quote.amount_minor <= remaining).toBe(true);
          expect(quote.principal_minor).toBe(4_050_000n);
          expect(quote.interest_minor + quote.waived_minor).toBe(212_625n);
          expect(quote.amount_minor).toBe(
            quote.principal_minor + quote.charges_minor + quote.interest_minor,
          );
          const sum = quote.lines.reduce(
            (total, line) =>
              total + line.principal_minor + line.charges_minor + line.interest_minor,
            0n,
          );
          expect(sum).toBe(quote.amount_minor);
        }
        expect(later.amount_minor >= earlier.amount_minor).toBe(true);
      }),
    );
  });
});

describe('late charges', () => {
  it('charges the fee once, never beyond the agreement’s cap', () => {
    expect(lateChargeFor({ feeMinor: 10_000n, capMinor: 60_000n, chargedSoFarMinor: 0n })).toBe(
      10_000n,
    );
    expect(
      lateChargeFor({ feeMinor: 10_000n, capMinor: 60_000n, chargedSoFarMinor: 55_000n }),
    ).toBe(5_000n);
    expect(
      lateChargeFor({ feeMinor: 10_000n, capMinor: 60_000n, chargedSoFarMinor: 60_000n }),
    ).toBe(0n);
  });
});
