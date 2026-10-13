import { Injectable } from '@nestjs/common';
import type { Tx } from '../../platform/database.js';

/** Bump when the rules change; stored with match decisions from Phase 3 (ADR 0012). */
export const NORMALISATION_VERSION = 1;

export function normaliseName(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normaliseIdentifier(value: string): string {
  return value
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

export interface BusinessLocation {
  readonly country: string;
  readonly area: string;
  readonly locality: string;
  readonly place: string;
}

export function locationKey(location: BusinessLocation): string {
  return [location.country, location.area, location.locality, location.place]
    .map(normaliseName)
    .join('|');
}

/**
 * Canonical business records. Phase 1 creates them from seed data only; the
 * exact-match rules of ADR 0012 are enforced by unique constraints, and the
 * review queue arrives with onboarding in Phase 3.
 */
@Injectable()
export class BusinessService {
  async createRegistered(
    tx: Tx,
    input: { name: string; country: string; registrationType: string; registrationValue: string },
  ): Promise<string> {
    const business = await tx.business.create({
      data: {
        kind: 'registered',
        name: input.name,
        name_normalised: normaliseName(input.name),
        country: input.country,
      },
    });
    await tx.business_identifier.create({
      data: {
        business_id: business.id,
        type: input.registrationType,
        country: input.country,
        value_normalised: normaliseIdentifier(input.registrationValue),
      },
    });
    return business.id;
  }

  async createUnregistered(
    tx: Tx,
    input: { name: string; ownerPersonId: string; location: BusinessLocation },
  ): Promise<string> {
    const business = await tx.business.create({
      data: {
        kind: 'unregistered',
        name: input.name,
        name_normalised: normaliseName(input.name),
        country: input.location.country,
        owner_person_id: input.ownerPersonId,
        location: { ...input.location },
        location_key: locationKey(input.location),
      },
    });
    return business.id;
  }
}
