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
