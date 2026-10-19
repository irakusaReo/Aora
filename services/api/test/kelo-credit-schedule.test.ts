import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  aprText,
  type CreditTerms,
  creditSchedule,
  dailyRateText,
  withinRecoveryCap,
} from '../src/modules/kelo/schedule.js';

/**
 * The credit schedule engine (phase-8 P8-2 to P8-4, ADR 0018; r. 29 and r. 54(4)
 * of the CBK Non-Deposit Taking Credit Providers Regulations, 2026). Written
 * before the code.
 */

const PAY_IN_4: CreditTerms = {
  instalmentCount: 4,
  intervalDays: 14,
  dailyRatePpm: 0,
  depositBps: 0,
  firstPaymentAtCheckout: true,
  lateFeeTotalCapMinor: 20_000n,
};

const MONTHLY_6: CreditTerms = {
  instalmentCount: 6,
  intervalDays: 30,
  dailyRatePpm: 500,
  depositBps: 1000,
  firstPaymentAtCheckout: false,
  lateFeeTotalCapMinor: 60_000n,
};

describe('credit schedule', () => {
  it('Pay in 4: the first part at checkout, no cost to the buyer, the last part taking the remainder', () => {
    const schedule = creditSchedule({
      priceMinor: 800_001n,
      terms: PAY_IN_4,
      startDate: '2026-10-19',
    });
    expect(schedule).toMatchObject({
      price_minor: 800_001n,
      deposit_minor: 0n,
      financed_minor: 800_001n,
      interest_total_minor: 0n,
      total_payable_minor: 800_001n,
      checkout_seq: 1,
    });
    expect(schedule.lines).toEqual([
      {
        seq: 1,
        due_on: '2026-10-19',
        principal_minor: 200_000n,
        interest_minor: 0n,
        amount_minor: 200_000n,
      },
      {
        seq: 2,
        due_on: '2026-11-02',
        principal_minor: 200_000n,
        interest_minor: 0n,
        amount_minor: 200_000n,
      },
      {
        seq: 3,
        due_on: '2026-11-16',
        principal_minor: 200_000n,
        interest_minor: 0n,
        amount_minor: 200_000n,
      },
      {
        seq: 4,
        due_on: '2026-11-30',
        principal_minor: 200_001n,
        interest_minor: 0n,
        amount_minor: 200_001n,
      },
    ]);
    expect(schedule.apr_text).toBe('0.00%');
  });

  it('monthly financing: a deposit, then equal principal with simple daily interest on what is still owed', () => {
    const schedule = creditSchedule({
      priceMinor: 4_500_000n,
      terms: MONTHLY_6,
      startDate: '2026-10-19',
    });
    // Deposit 10% = 450,000; financed 4,050,000 in six parts of 675,000.
    expect(schedule.deposit_minor).toBe(450_000n);
    expect(schedule.financed_minor).toBe(4_050_000n);
    expect(schedule.checkout_seq).toBe(0);
    expect(schedule.lines[0]).toEqual({
      seq: 0,
      due_on: '2026-10-19',
      principal_minor: 450_000n,
      interest_minor: 0n,
      amount_minor: 450_000n,
    });
    // 500 ppm a day for 30 days on 4,050,000 is 60,750; then on 3,375,000 it is 50,625.
    expect(schedule.lines.slice(1).map((line) => line.interest_minor)).toEqual([
      60_750n,
      50_625n,
      40_500n,
      30_375n,
      20_250n,
      10_125n,
    ]);
    expect(schedule.lines.slice(1).map((line) => line.due_on)).toEqual([
      '2026-11-18',
      '2026-12-18',
      '2027-01-17',
      '2027-02-16',
      '2027-03-18',
      '2027-04-17',
    ]);
    expect(schedule.interest_total_minor).toBe(212_625n);
    expect(schedule.total_payable_minor).toBe(4_712_625n);
    // 0.05% a day × 365 = 18.25% a year, nominal.
    expect(schedule.apr_text).toBe('18.25%');
    expect(schedule.daily_rate_text).toBe('0.0500%');
  });

  it('rounds each line’s interest half up', () => {
    // 3 ppm × 30 days on 50,001 is 4.50009, which rounds to 5; on 25,001 (after 25,000) is 2.25009, which rounds to 2.
    const schedule = creditSchedule({
      priceMinor: 50_001n,
      terms: {
        ...MONTHLY_6,
        dailyRatePpm: 3,
        depositBps: 0,
        firstPaymentAtCheckout: false,
        instalmentCount: 2,
      },
      startDate: '2026-10-19',
    });
    expect(schedule.lines.map((line) => line.interest_minor)).toEqual([5n, 2n]);
  });

  it('always sums exactly: principal to the price, lines to the total payable, with every part positive', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1_000n, max: 10n ** 12n }),
        fc.integer({ min: 1, max: 24 }),
        fc.integer({ min: 1, max: 62 }),
        fc.integer({ min: 0, max: 2_000 }),
        fc.integer({ min: 0, max: 5_000 }),
        fc.boolean(),
        (price, count, interval, rate, depositBps, firstAtCheckout) => {
          const terms: CreditTerms = {
            instalmentCount: count,
            intervalDays: interval,
            dailyRatePpm: rate,
            depositBps: firstAtCheckout ? 0 : Math.max(depositBps, 1),
            firstPaymentAtCheckout: firstAtCheckout,
            lateFeeTotalCapMinor: 0n,
          };
          const schedule = creditSchedule({ priceMinor: price, terms, startDate: '2026-01-31' });
          const principal = schedule.lines.reduce((sum, line) => sum + line.principal_minor, 0n);
          const interest = schedule.lines.reduce((sum, line) => sum + line.interest_minor, 0n);
          const amount = schedule.lines.reduce((sum, line) => sum + line.amount_minor, 0n);
          expect(principal).toBe(price);
          expect(interest).toBe(schedule.interest_total_minor);
          expect(amount).toBe(schedule.total_payable_minor);
          expect(schedule.total_payable_minor).toBe(price + schedule.interest_total_minor);
          expect(schedule.deposit_minor + schedule.financed_minor).toBe(price);
          expect(
            schedule.lines.every(
              (line) =>
                line.principal_minor > 0n &&
                line.interest_minor >= 0n &&
                line.amount_minor === line.principal_minor + line.interest_minor,
            ),
          ).toBe(true);
          expect(schedule.lines.filter((line) => line.seq > 0)).toHaveLength(count);
        },
      ),
    );
  });

  it('refuses a price too small to split', () => {
    expect(() =>
      creditSchedule({ priceMinor: 3n, terms: PAY_IN_4, startDate: '2026-10-19' }),
    ).toThrow();
  });

  it('states the APR and the daily rate as text from the rate, to two and four decimals', () => {
    expect(aprText(0)).toBe('0.00%');
    expect(aprText(1000)).toBe('36.50%');
    expect(aprText(1)).toBe('0.04%'); // 0.0365, half up
    expect(aprText(273_973)).toBe('10000.01%');
    expect(dailyRateText(1)).toBe('0.0001%');
    expect(dailyRateText(12_345)).toBe('1.2345%');
  });
});

describe('the r. 29 recovery cap, checked when a template is configured', () => {
  it('accepts the sandbox templates', () => {
    expect(withinRecoveryCap(PAY_IN_4, 200_000n)).toBe(true);
    expect(withinRecoveryCap(MONTHLY_6, 1_000_000n)).toBe(true);
  });

  it('refuses terms whose interest and late charges could exceed the principal', () => {
    // 3,000 ppm a day for 360 days is 108% of the principal before any late charge.
    expect(
      withinRecoveryCap({ ...MONTHLY_6, dailyRatePpm: 3_000, instalmentCount: 12 }, 1_000_000n),
    ).toBe(false);
    // Late charges alone above a small order's principal.
    expect(withinRecoveryCap({ ...PAY_IN_4, lateFeeTotalCapMinor: 300_000n }, 200_000n)).toBe(
      false,
    );
  });

  it('never lets an accepted template charge more than the principal, at any price', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1_000n, max: 10n ** 9n }),
        fc.bigInt({ min: 0n, max: 10n ** 9n }),
        fc.integer({ min: 1, max: 24 }),
        fc.integer({ min: 1, max: 62 }),
        fc.integer({ min: 0, max: 3_000 }),
        fc.integer({ min: 1, max: 5_000 }),
        fc.bigInt({ min: 0n, max: 10n ** 6n }),
        (minOrder, extra, count, interval, rate, depositBps, lateCap) => {
          const terms: CreditTerms = {
            instalmentCount: count,
            intervalDays: interval,
            dailyRatePpm: rate,
            depositBps,
            firstPaymentAtCheckout: false,
            lateFeeTotalCapMinor: lateCap,
          };
          fc.pre(withinRecoveryCap(terms, minOrder));
          const schedule = creditSchedule({
            priceMinor: minOrder + extra,
            terms,
            startDate: '2026-10-19',
          });
          expect(schedule.interest_total_minor + lateCap <= schedule.financed_minor).toBe(true);
        },
      ),
    );
  });
});
