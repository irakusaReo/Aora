import type { Prisma } from '../../generated/prisma/client.js';
import type { Tx } from '../../platform/database.js';
import {
  type BusinessLocation,
  locationKey,
  normaliseIdentifier,
  normaliseName,
} from './business.service.js';

/**
 * ADR 0012's matching rule, shared by KONY onboarding and KELO provisioning so
 * that a business arriving by either door is recognised by the same rules.
 */
export interface MatchSubject {
  readonly kind: 'registered' | 'unregistered';
  readonly name: string;
  readonly country: string;
  readonly registrationType: string | null;
  readonly registrationValue: string | null;
  /** The stored location object of an unregistered business. */
  readonly location: Prisma.JsonValue | null;
  readonly verification: 'verified' | 'unverified';
}

export interface Match {
  readonly rule: string;
  readonly outcome: 'same' | 'new' | 'review';
  readonly matchedBusinessId: string | null;
}

export function locationOf(subject: MatchSubject): BusinessLocation {
  const location = (subject.location ?? {}) as Record<string, unknown>;
  const part = (key: string): string => (typeof location[key] === 'string' ? location[key] : '');
  return {
    country: subject.country,
    area: part('area'),
    locality: part('locality'),
    place: part('place'),
  };
}

/** Reads only; decides nothing. Callers hold the locks from `matchLockKeys` first. */
export async function matchBusiness(
  tx: Tx,
  subject: MatchSubject,
  ownerPersonId: string,
): Promise<Match> {
  const name = normaliseName(subject.name);
  if (subject.kind === 'registered') {
    const identifier = await tx.business_identifier.findFirst({
      where: {
        type: subject.registrationType ?? '',
        country: subject.country,
        value_normalised: normaliseIdentifier(subject.registrationValue ?? ''),
      },
    });
    if (identifier) {
      // Only a verified identifier, on both sides, can match automatically.
      return identifier.verified_at && subject.verification === 'verified'
        ? {
            rule: 'registered_identifier_match',
            outcome: 'same',
            matchedBusinessId: identifier.business_id,
          }
        : {
            rule: 'unverified_identifier_match',
            outcome: 'review',
            matchedBusinessId: identifier.business_id,
          };
    }
    const informal = await tx.business.findFirst({
      where: { kind: 'unregistered', owner_person_id: ownerPersonId, name_normalised: name },
    });
    if (informal) {
      return {
        rule: 'owner_has_unregistered_same_name',
        outcome: 'review',
        matchedBusinessId: informal.id,
      };
    }
    return { rule: 'new_business', outcome: 'new', matchedBusinessId: null };
  }

  const place = locationKey(locationOf(subject));
  const candidates = await tx.business.findMany({
    where: {
      kind: 'unregistered',
      OR: [
        { owner_person_id: ownerPersonId, location_key: place },
        { owner_person_id: ownerPersonId, name_normalised: name },
        { name_normalised: name, location_key: place },
      ],
    },
  });
  const find = (test: (row: (typeof candidates)[number]) => boolean): string | null =>
    candidates.find(test)?.id ?? null;
  const mine = (row: (typeof candidates)[number]): boolean => row.owner_person_id === ownerPersonId;

  const exact = find(
    (row) => mine(row) && row.name_normalised === name && row.location_key === place,
  );
  if (exact) {
    return { rule: 'unregistered_identity_match', outcome: 'same', matchedBusinessId: exact };
  }
  const samePlace = find((row) => mine(row) && row.location_key === place);
  if (samePlace) {
    return { rule: 'same_owner_same_location', outcome: 'review', matchedBusinessId: samePlace };
  }
  const sameName = find((row) => mine(row) && row.name_normalised === name);
  if (sameName) {
    return { rule: 'same_owner_same_name', outcome: 'review', matchedBusinessId: sameName };
  }
  const otherOwner = find((row) => row.name_normalised === name && row.location_key === place);
  if (otherOwner) {
    return { rule: 'same_name_same_location', outcome: 'review', matchedBusinessId: otherOwner };
  }
  return { rule: 'new_business', outcome: 'new', matchedBusinessId: null };
}

/**
 * Advisory-lock keys for subjects that could be the same business, so two of
 * them can never both conclude "new". Sorted, so lockers never deadlock.
 */
export function matchLockKeys(subject: MatchSubject, ownerPersonId: string): string[] {
  const name = normaliseName(subject.name);
  if (subject.kind === 'registered') {
    return [
      `onboarding:id:${subject.registrationType ?? ''}:${subject.country}:${normaliseIdentifier(subject.registrationValue ?? '')}`,
      `onboarding:owner:${ownerPersonId}`,
    ].sort();
  }
  return [
    `onboarding:owner:${ownerPersonId}`,
    `onboarding:place:${name}:${locationKey(locationOf(subject))}`,
  ].sort();
}

export async function lockMatchKeys(tx: Tx, subject: MatchSubject, ownerPersonId: string) {
  for (const key of matchLockKeys(subject, ownerPersonId)) {
    await tx.$executeRaw`select pg_advisory_xact_lock(hashtextextended(${key}::text, 0))`;
  }
}

/** What a decision was based on. Normalised values only; no contact details. */
export function matchInputs(subject: MatchSubject): Prisma.InputJsonObject {
  return subject.kind === 'registered'
    ? {
        kind: 'registered',
        name_normalised: normaliseName(subject.name),
        registration_type: subject.registrationType,
        registration_value_normalised: normaliseIdentifier(subject.registrationValue ?? ''),
        verification: subject.verification,
      }
    : {
        kind: 'unregistered',
        name_normalised: normaliseName(subject.name),
        location_key: locationKey(locationOf(subject)),
        verification: subject.verification,
      };
}
