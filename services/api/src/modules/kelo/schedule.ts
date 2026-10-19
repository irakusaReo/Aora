/**
 * The one schedule engine (ADR 0018). Integer minor units only; screens render
 * exactly what this returns and compute nothing themselves.
 */

export interface ScheduleLine {
  readonly seq: number;
  /** A calendar date, `YYYY-MM-DD`. */
  readonly due_on: string;
  readonly amount_minor: bigint;
}

/** `YYYY-MM-DD` plus whole days, in calendar arithmetic (no clock, no time zone). */
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map((part) => Number.parseInt(part, 10));
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`Not a date: ${date}`);
  }
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/**
 * Equal instalments, the first on the start date, then every `intervalDays`.
 * The last instalment takes the remainder, so the lines always sum exactly to
 * the total.
 */
export function layawaySchedule(input: {
  totalMinor: bigint;
  instalmentCount: number;
  intervalDays: number;
  startDate: string;
}): ScheduleLine[] {
  const count = BigInt(input.instalmentCount);
  if (input.instalmentCount < 1 || input.totalMinor < count) {
    throw new Error('A schedule needs at least one minor unit per instalment.');
  }
  const base = input.totalMinor / count;
  return Array.from({ length: input.instalmentCount }, (_unused, index) => ({
    seq: index + 1,
    due_on: addDays(input.startDate, index * input.intervalDays),
    amount_minor:
      index === input.instalmentCount - 1 ? input.totalMinor - base * (count - 1n) : base,
  }));
}

/** `amount × bps / 10 000`, rounded half up, in integers. */
export function basisPoints(amount: bigint, bps: number): bigint {
  return (amount * BigInt(bps) * 2n + 10_000n) / 20_000n;
}

export interface RefundRule {
  readonly feeBps: number;
  readonly feeCapMinor: bigint;
  readonly afterStartReturnedBps: number;
}

/**
 * What a cancelling buyer gets back (ADR 0018). Before a session starts: what
 * was paid less a percentage fee, capped. After it starts: only the configured
 * share, rounded in the buyer's favour. Refund and fee always sum to what was paid.
 */
export function cancellationRefund(input: {
  paidMinor: bigint;
  rule: RefundRule;
  sessionStarted: boolean;
}): { feeMinor: bigint; refundMinor: bigint } {
  if (input.sessionStarted) {
    const returned = basisPoints(input.paidMinor, input.rule.afterStartReturnedBps);
    const refund = returned > input.paidMinor ? input.paidMinor : returned;
    return { feeMinor: input.paidMinor - refund, refundMinor: refund };
  }
  const percentage = basisPoints(input.paidMinor, input.rule.feeBps);
  const fee = percentage > input.rule.feeCapMinor ? input.rule.feeCapMinor : percentage;
  return { feeMinor: fee, refundMinor: input.paidMinor - fee };
}

/** Today's date in Nairobi (UTC+3 all year), where KELO's schedules are dated. */
export function nairobiToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
}

// --- Credit (phase-8 P8-2 to P8-4) ---

/** A credit template's terms, as the engine needs them. Rates are integers. */
export interface CreditTerms {
  readonly instalmentCount: number;
  readonly intervalDays: number;
  /** Simple interest per day on the principal still owed, in parts per million. */
  readonly dailyRatePpm: number;
  /** Paid at checkout, in basis points of the price. */
  readonly depositBps: number;
  /** Pay in N: the first part is paid at checkout instead of a deposit. */
  readonly firstPaymentAtCheckout: boolean;
  /** The most late charges an agreement can ever carry (r. 30(2)). */
  readonly lateFeeTotalCapMinor: bigint;
}

export interface CreditLine {
  /** 0 is the deposit; 1 to N are the instalments. */
  readonly seq: number;
  readonly due_on: string;
  readonly principal_minor: bigint;
  readonly interest_minor: bigint;
  readonly amount_minor: bigint;
}

export interface CreditSchedule {
  readonly price_minor: bigint;
  readonly deposit_minor: bigint;
  /** What is lent: the price less the deposit. */
  readonly financed_minor: bigint;
  readonly lines: CreditLine[];
  /** The total cost of credit. */
  readonly interest_total_minor: bigint;
  readonly total_payable_minor: bigint;
  /** The line paid at checkout: the deposit (0), the first part (1), or none. */
  readonly checkout_seq: number | null;
  readonly daily_rate_ppm: number;
  readonly daily_rate_text: string;
  readonly apr_text: string;
}

const MILLION = 1_000_000n;

/** `amount × ppm × days / 1 000 000`, rounded half up, in integers. */
function interestFor(amount: bigint, ppm: number, days: number): bigint {
  return (amount * BigInt(ppm) * BigInt(days) * 2n + MILLION) / (2n * MILLION);
}

/** The nominal annual rate, daily rate × 365, as text to two decimals, rounded half up. */
export function aprText(dailyRatePpm: number): string {
  // ppm × 365 / 100 is the annual rate in hundredths of a percent.
  const hundredths = (BigInt(dailyRatePpm) * 365n * 2n + 100n) / 200n;
  return `${(hundredths / 100n).toString()}.${(hundredths % 100n).toString().padStart(2, '0')}%`;
}

/** The daily rate as text to four decimals (exact: one ppm is 0.0001%). */
export function dailyRateText(dailyRatePpm: number): string {
  const ppm = BigInt(dailyRatePpm);
  return `${(ppm / 10_000n).toString()}.${(ppm % 10_000n).toString().padStart(4, '0')}%`;
}

/**
 * An optional deposit at checkout, then equal principal parts (the last takes
 * the remainder), each carrying simple interest on the principal owed during
 * its period (P8-3). Pay in N has no deposit; its first part is due at checkout
 * and so carries no interest.
 */
export function creditSchedule(input: {
  priceMinor: bigint;
  terms: CreditTerms;
  startDate: string;
}): CreditSchedule {
  const { terms } = input;
  const deposit = basisPoints(input.priceMinor, terms.depositBps);
  const financed = input.priceMinor - deposit;
  const count = BigInt(terms.instalmentCount);
  if (terms.instalmentCount < 1 || financed < count) {
    throw new Error('A credit schedule needs at least one minor unit of principal per part.');
  }
  const base = financed / count;
  const lines: CreditLine[] = [];
  if (deposit > 0n) {
    lines.push({
      seq: 0,
      due_on: input.startDate,
      principal_minor: deposit,
      interest_minor: 0n,
      amount_minor: deposit,
    });
  }
  let owed = financed;
  for (let index = 0; index < terms.instalmentCount; index += 1) {
    const principal = index === terms.instalmentCount - 1 ? owed : base;
    const atCheckout = terms.firstPaymentAtCheckout && index === 0;
    const days = atCheckout ? 0 : terms.intervalDays;
    const interest = interestFor(owed, terms.dailyRatePpm, days);
    lines.push({
      seq: index + 1,
      due_on: addDays(
        input.startDate,
        (terms.firstPaymentAtCheckout ? index : index + 1) * terms.intervalDays,
      ),
      principal_minor: principal,
      interest_minor: interest,
      amount_minor: principal + interest,
    });
    owed -= principal;
  }
  const interestTotal = lines.reduce((sum, line) => sum + line.interest_minor, 0n);
  return {
    price_minor: input.priceMinor,
    deposit_minor: deposit,
    financed_minor: financed,
    lines,
    interest_total_minor: interestTotal,
    total_payable_minor: input.priceMinor + interestTotal,
    checkout_seq: deposit > 0n ? 0 : terms.firstPaymentAtCheckout ? 1 : null,
    daily_rate_ppm: terms.dailyRatePpm,
    daily_rate_text: dailyRateText(terms.dailyRatePpm),
    apr_text: aprText(terms.dailyRatePpm),
  };
}

/**
 * r. 29 at configuration time (P8-4): the most interest the terms can ever
 * charge (the whole financed amount owed for the whole tenor, plus half a minor
 * unit of rounding per line, bounded by one) plus the late-charge cap stays
 * within the principal, for every order from the template's minimum up. The
 * database check `plan_template_recovery_cap` is the same inequality.
 */
export function withinRecoveryCap(terms: CreditTerms, minOrderMinor: bigint): boolean {
  const rateOverTenor =
    BigInt(terms.dailyRatePpm) * BigInt(terms.instalmentCount) * BigInt(terms.intervalDays);
  if (rateOverTenor >= MILLION) return false;
  const smallestFinanced = minOrderMinor - basisPoints(minOrderMinor, terms.depositBps);
  return (
    smallestFinanced * (MILLION - rateOverTenor) >=
    (terms.lateFeeTotalCapMinor + BigInt(terms.instalmentCount)) * MILLION
  );
}
