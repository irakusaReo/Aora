import { Injectable } from '@nestjs/common';
import type { Tx } from '../../platform/database.js';
import { AppError } from '../../platform/errors.js';

export type Operation = 'collection' | 'payout' | 'refund';
export type Rounding = 'half_up' | 'down';

/** One band of a tariff. It applies from `minAmount` up to the next band's `minAmount`. */
export interface Band {
  readonly minAmount: bigint;
  /** Hundredths of a percent of the amount. */
  readonly bps: number;
  readonly flatAmount: bigint;
  readonly minFee: bigint;
  readonly maxFee: bigint | null;
}

export interface Quote {
  readonly amount: bigint;
  readonly fee: bigint;
  readonly net: bigint;
  readonly tariffVersionId: string;
  readonly tariffVersion: number;
}

interface TariffKey {
  readonly operation: Operation;
  readonly rail: string;
  readonly country: string;
  readonly assetCode: string;
}

const BPS_DENOMINATOR = 10_000n;

/**
 * The fee for an amount under a set of bands, in exact integer minor units
 * (ADR 0021):
 *
 *   fee = clamp(flat + amount × bps / 10 000, minFee, maxFee), and never more than the amount.
 */
export function computeFee(bands: readonly Band[], rounding: Rounding, amount: bigint): bigint {
  let band: Band | undefined;
  for (const candidate of bands) {
    if (candidate.minAmount <= amount && (!band || candidate.minAmount > band.minAmount)) {
      band = candidate;
    }
  }
  if (!band) throw new Error('The tariff has no band for this amount.');
  const product = amount * BigInt(band.bps);
  const proportional =
    rounding === 'half_up'
      ? (product + BPS_DENOMINATOR / 2n) / BPS_DENOMINATOR
      : product / BPS_DENOMINATOR;
  let fee = band.flatAmount + proportional;
  if (fee < band.minFee) fee = band.minFee;
  if (band.maxFee !== null && fee > band.maxFee) fee = band.maxFee;
  return fee > amount ? amount : fee;
}

/**
 * Prices are data (lessons §1). This service only reads the tariff version in
 * effect and applies it; nothing about a price is written in code.
 */
@Injectable()
export class PricingService {
  /** The fee for an operation under the tariff version in effect at `at`. */
  async quote(tx: Tx, input: TariffKey & { amount: bigint; at?: Date }): Promise<Quote> {
    const at = input.at ?? new Date();
    const version = await tx.tariff_version.findFirst({
      where: {
        operation: input.operation,
        rail: input.rail,
        country: input.country,
        asset_code: input.assetCode,
        effective_from: { lte: at },
        OR: [{ effective_to: null }, { effective_to: { gt: at } }],
      },
      include: { tariff_band: true },
    });
    if (!version) {
      throw new AppError(
        'capability_not_supported',
        'This operation is not available on this rail and currency.',
      );
    }
    const bands = version.tariff_band.map((row) => ({
      minAmount: row.min_amount,
      bps: row.bps,
      flatAmount: row.flat_amount,
      minFee: row.min_fee,
      maxFee: row.max_fee,
    }));
    let fee: bigint;
    try {
      fee = computeFee(bands, version.rounding as Rounding, input.amount);
    } catch {
      throw new AppError('invalid_request', 'The amount is below the minimum for this rail.');
    }
    return {
      amount: input.amount,
      fee,
      net: input.amount - fee,
      tariffVersionId: version.id,
      tariffVersion: version.version,
    };
  }

  /**
   * Publishes the next version of a tariff and closes the one it replaces at
   * the same instant. Published versions and their bands are immutable.
   */
  async publish(
    tx: Tx,
    input: TariffKey & {
      name: string;
      rounding: Rounding;
      effectiveFrom: Date;
      bands: readonly Band[];
    },
  ): Promise<{ id: string; version: number }> {
    const key = {
      operation: input.operation,
      rail: input.rail,
      country: input.country,
      asset_code: input.assetCode,
    };
    await tx.tariff_version.updateMany({
      where: { ...key, effective_to: null, effective_from: { lt: input.effectiveFrom } },
      data: { effective_to: input.effectiveFrom },
    });
    const latest = await tx.tariff_version.aggregate({ where: key, _max: { version: true } });
    const created = await tx.tariff_version.create({
      data: {
        ...key,
        version: (latest._max.version ?? 0) + 1,
        name: input.name,
        rounding: input.rounding,
        effective_from: input.effectiveFrom,
        tariff_band: {
          create: input.bands.map((band) => ({
            min_amount: band.minAmount,
            bps: band.bps,
            flat_amount: band.flatAmount,
            min_fee: band.minFee,
            max_fee: band.maxFee,
          })),
        },
      },
    });
    return { id: created.id, version: created.version };
  }
}
