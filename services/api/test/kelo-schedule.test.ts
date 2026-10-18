import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { cancellationRefund, layawaySchedule } from '../src/modules/kelo/schedule.js';

/** The schedule engine and the cancellation rule (ADR 0018). Written before the code. */

describe('layaway schedule', () => {
  it('splits a total into equal instalments, the last one taking the remainder', () => {
    const schedule = layawaySchedule({
      totalMinor: 1_000_001n,
      instalmentCount: 4,
      intervalDays: 14,
      startDate: '2026-10-18',
    });
    expect(schedule).toEqual([
      { seq: 1, due_on: '2026-10-18', amount_minor: 250_000n },
      { seq: 2, due_on: '2026-11-01', amount_minor: 250_000n },
      { seq: 3, due_on: '2026-11-15', amount_minor: 250_000n },
      { seq: 4, due_on: '2026-11-29', amount_minor: 250_001n },
    ]);
  });

  it('always sums exactly to the total, with every instalment positive', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 15n }),
        fc.integer({ min: 1, max: 24 }),
        fc.integer({ min: 1, max: 62 }),
        (total, count, interval) => {
          fc.pre(total >= BigInt(count));
          const schedule = layawaySchedule({
            totalMinor: total,
            instalmentCount: count,
            intervalDays: interval,
            startDate: '2026-01-31',
          });
          expect(schedule).toHaveLength(count);
          expect(schedule.reduce((sum, line) => sum + line.amount_minor, 0n)).toBe(total);
          expect(schedule.every((line) => line.amount_minor > 0n)).toBe(true);
          const base = total / BigInt(count);
          expect(schedule.slice(0, -1).every((line) => line.amount_minor === base)).toBe(true);
        },
      ),
    );
  });

  it('refuses a total smaller than the number of instalments', () => {
    expect(() =>
      layawaySchedule({
        totalMinor: 3n,
        instalmentCount: 4,
        intervalDays: 7,
        startDate: '2026-10-18',
      }),
    ).toThrow();
  });

  it('counts dates in calendar days, across month and year ends', () => {
    const schedule = layawaySchedule({
      totalMinor: 300n,
      instalmentCount: 3,
      intervalDays: 30,
      startDate: '2026-12-15',
    });
    expect(schedule.map((line) => line.due_on)).toEqual(['2026-12-15', '2027-01-14', '2027-02-13']);
  });
});

describe('cancellation refund', () => {
  const rule = { feeBps: 500, feeCapMinor: 100_000n, afterStartReturnedBps: 0 };

  it('keeps a percentage fee, rounded half up, never more than its cap', () => {
    expect(cancellationRefund({ paidMinor: 1_000_000n, rule, sessionStarted: false })).toEqual({
      feeMinor: 50_000n,
      refundMinor: 950_000n,
    });
    // 5% of 10,000,000 is 500,000; the cap is 100,000.
    expect(cancellationRefund({ paidMinor: 10_000_000n, rule, sessionStarted: false })).toEqual({
      feeMinor: 100_000n,
      refundMinor: 9_900_000n,
    });
    // 5% of 30 is 1.5, half up to 2.
    expect(cancellationRefund({ paidMinor: 30n, rule, sessionStarted: false })).toEqual({
      feeMinor: 2n,
      refundMinor: 28n,
    });
  });

  it('returns only the after-start share once the session has started', () => {
    expect(cancellationRefund({ paidMinor: 1_000_000n, rule, sessionStarted: true })).toEqual({
      feeMinor: 1_000_000n,
      refundMinor: 0n,
    });
    const half = { ...rule, afterStartReturnedBps: 5000 };
    expect(cancellationRefund({ paidMinor: 1_000_001n, rule: half, sessionStarted: true })).toEqual(
      {
        feeMinor: 500_000n,
        refundMinor: 500_001n,
      },
    );
  });

  it('always splits what was paid exactly between refund and fee', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 15n }),
        fc.integer({ min: 0, max: 10_000 }),
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.integer({ min: 0, max: 10_000 }),
        fc.boolean(),
        (paid, feeBps, cap, returnedBps, started) => {
          const result = cancellationRefund({
            paidMinor: paid,
            rule: { feeBps, feeCapMinor: cap, afterStartReturnedBps: returnedBps },
            sessionStarted: started,
          });
          expect(result.feeMinor + result.refundMinor).toBe(paid);
          expect(result.feeMinor >= 0n && result.refundMinor >= 0n).toBe(true);
          if (!started) expect(result.feeMinor <= cap).toBe(true);
        },
      ),
    );
  });
});
