import { addDays } from '../schedule.js';

/**
 * Repayment arithmetic (phase 8B). Pure and exact: integers only.
 *
 * - Interest is earned only to the day (r. 56(3)–(4)): a part's interest
 *   accrues evenly over its own period, so repaying early costs only the days
 *   that have passed, and the rest is waived.
 * - A repayment is allocated to principal, then charges, then interest (r. 56(2)).
 * - Late charges never exceed the agreement's cap (r. 29, r. 30(2)).
 */

export interface LineState {
  readonly seq: number;
  /** `YYYY-MM-DD`. */
  readonly due_on: string;
  readonly principal_minor: bigint;
  readonly interest_minor: bigint;
  readonly paid_principal_minor: bigint;
  readonly paid_interest_minor: bigint;
  readonly interest_waived_minor: bigint;
  readonly late_charges_minor: bigint;
  readonly paid_charges_minor: bigint;
  readonly status: string;
}

export interface Allocation {
  readonly seq: number;
  readonly principal_minor: bigint;
  readonly charges_minor: bigint;
  readonly interest_minor: bigint;
  /** Interest not yet earned, given up because the part is repaid early. */
  readonly waived_minor: bigint;
}

export interface Quote {
  readonly amount_minor: bigint;
  readonly principal_minor: bigint;
  readonly charges_minor: bigint;
  readonly interest_minor: bigint;
  readonly waived_minor: bigint;
  readonly lines: Allocation[];
}

/** Lines no repayment can touch: settled, cancelled, or paused by a return or dispute (8C). */
const CLOSED = new Set(['paid', 'cancelled', 'paused']);

/** Whole calendar days from one date to another (both UTC midnights, so the division is exact). */
function daysBetween(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}

/**
 * The interest a part has earned by `today`: none before its period starts,
 * pro rata inside it (rounded half up), and all of it from its due date.
 */
export function accruedInterest(
  line: LineState,
  today: string,
  terms: { intervalDays: number; checkoutSeq: number },
): bigint {
  if (line.interest_minor === 0n || line.seq === terms.checkoutSeq) return line.interest_minor;
  const periodStart = addDays(line.due_on, -terms.intervalDays);
  const elapsed = Math.min(Math.max(daysBetween(periodStart, today), 0), terms.intervalDays);
  const days = BigInt(terms.intervalDays);
  return (line.interest_minor * BigInt(elapsed) * 2n + days) / (2n * days);
}

/** What paying one line off today takes, in allocation order. */
function settle(
  line: LineState,
  today: string,
  terms: { intervalDays: number; checkoutSeq: number },
): Allocation {
  const earned = accruedInterest(line, today, terms);
  const outstandingInterest =
    line.interest_minor - line.paid_interest_minor - line.interest_waived_minor;
  const owedInterest = earned - line.paid_interest_minor - line.interest_waived_minor;
  const interest = owedInterest > 0n ? owedInterest : 0n;
  return {
    seq: line.seq,
    principal_minor: line.principal_minor - line.paid_principal_minor,
    charges_minor: line.late_charges_minor - line.paid_charges_minor,
    interest_minor: interest,
    waived_minor: outstandingInterest - interest,
  };
}

/**
 * A quote for paying the next open part (`next`) or everything (`payoff`)
 * today. Every figure is exact; the allocation lists what each part receives.
 */
export function quoteRepayment(input: {
  lines: readonly LineState[];
  today: string;
  kind: 'next' | 'payoff';
  intervalDays: number;
  checkoutSeq: number;
}): Quote {
  const open = [...input.lines]
    .filter((line) => !CLOSED.has(line.status))
    .sort((a, b) => a.seq - b.seq);
  const chosen = input.kind === 'next' ? open.slice(0, 1) : open;
  if (chosen.length === 0) throw new Error('Nothing is owed on this agreement.');
  const lines = chosen.map((line) => settle(line, input.today, input));
  const sum = (pick: (line: Allocation) => bigint): bigint =>
    lines.reduce((total, line) => total + pick(line), 0n);
  const principal = sum((line) => line.principal_minor);
  const charges = sum((line) => line.charges_minor);
  const interest = sum((line) => line.interest_minor);
  return {
    amount_minor: principal + charges + interest,
    principal_minor: principal,
    charges_minor: charges,
    interest_minor: interest,
    waived_minor: sum((line) => line.waived_minor),
    lines,
  };
}

/** The late charge for one late part: the fee, up to what the cap still allows. */
export function lateChargeFor(input: {
  feeMinor: bigint;
  capMinor: bigint;
  chargedSoFarMinor: bigint;
}): bigint {
  const room = input.capMinor - input.chargedSoFarMinor;
  if (room <= 0n) return 0n;
  return input.feeMinor < room ? input.feeMinor : room;
}
