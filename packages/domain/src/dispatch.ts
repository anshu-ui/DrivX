import type { EpochMs, MoneyPaise } from './common';
import type { AvailabilityState, BookingStatus, ServiceTypeId, VerificationStatus } from './enums';

/**
 * The duty agreement, and who may be handed a trip.
 *
 * The owner's rule of 2026-10-27: "term agree karne ke baad hi uske paas vo
 * booking aaegi" — a driver is only offered work after they have agreed the
 * terms of duty, and the trip stops reaching them again the moment the office
 * changes those terms, because an acceptance only counts for the version it was
 * read against. That is why the version is a string on this file rather than a
 * boolean on a profile: `true` cannot tell a driver "the rules moved, agree
 * again", and dispatch must be able to.
 *
 * Every line here describes something the code actually enforces. Nothing in a
 * driver-facing agreement may promise a control that does not exist — the
 * commission hold, the metered bill, the customer's codes and the decline-not-
 * cancel rule are all implemented, so all four are stated.
 */
export const DUTY_TERMS = {
  version: 'drivx-duty-v1',
  title: 'Duty terms',
  lines: [
    'Duty means DrivX sends trips to you. Each one is yours to accept or decline before its offer lapses; nobody is obliged to take a trip.',
    'The start code and the end code belong to the customer. You enter what they read out to you — a code you guessed, kept or reused is not an arrival, it is a false trip.',
    'The bill is priced from the odometer you report at pickup and at the drop. Enter the dial as it stands; DrivX meters the difference between the two readings.',
    `DrivX keeps its commission share of every completed trip plus GST on that share. The rate the trip was billed at is on the trip itself, and it does not change afterwards.`,
    'While that commission is unpaid, new trips are held. Pay in the app or hand the amount at the office — the hold lifts as soon as nothing is owed.',
    'Only the customer can cancel a trip. If you cannot drive one, decline it: the booking goes back to be offered again instead of ending, so the customer still gets a driver.',
    'Your Aadhaar and driving licence stay on the office record. If they are sent back or lapse, your approval ends and duty stops with it.',
  ],
} as const;

/** Sentinel expiry for offers that stay open until accepted or declined. */
export const OFFER_NEVER_EXPIRES_AT_MS = Number.MAX_SAFE_INTEGER;

/** Drivers outside this straight-line radius are never offered a pickup. */
export const DISPATCH_RADIUS_METERS = 100_000;

/** Location fixes older than this cannot keep a driver in the dispatch pool. */
export const DISPATCH_LOCATION_MAX_AGE_MS = 30_000;

/**
 * How many approved drivers one dispatch reads at a time.
 *
 * Candidates are filtered and ranked in one pass rather than by nine queries per
 * eligibility rule, so this is the read budget for a single offer. Live location
 * checks then reduce these candidates to the 100 km pickup radius.
 */
export const DISPATCH_CANDIDATE_LIMIT = 50;

/** The one offer per driver per booking, so a retried dispatch collides. */
export function assignmentIdFor(bookingId: string, driverUid: string): string {
  return `as-${bookingId}-${driverUid}`;
}

/**
 * The statuses in which a driver is holding a trip.
 *
 * Shared by the Duty screen's own "in hand" query and by dispatch, because a
 * driver busy on one of these must not be handed a second one — and two lists
 * of the same states is how a driver ends up with two live bills.
 */
export const DRIVER_ON_DUTY_STATUSES: readonly BookingStatus[] = [
  'assigned',
  'driver_en_route',
  'driver_arrived',
  'trip_started',
  'in_progress',
  'destination_reached',
];

export function isOnDuty(status: BookingStatus | string): boolean {
  return (DRIVER_ON_DUTY_STATUSES as readonly string[]).includes(status);
}

/**
 * What one `driverProfiles/{uid}` document already answers.
 *
 * Split from the rest of the eligibility test on purpose: these six fields come
 * from a single query, while the money and the in-progress trip are per-driver
 * reads. Dispatch filters and ranks on what it has cheaply, then confirms the
 * expensive facts for the one driver it is about to offer — which is how a
 * market of fifty approved drivers costs one profile read plus two lookups, not
 * a hundred and fifty.
 */
export type DispatchProfileFacts = {
  uid: string;
  fullName: string | null;
  verificationStatus: VerificationStatus;
  availabilityState: AvailabilityState;
  serviceTypeIds: ServiceTypeId[];
  /** The version of `DUTY_TERMS` this driver agreed to; null until they do. */
  dutyTermsVersion: string | null;
  /** When they last went online — the waiting order offers are handed out in. */
  availabilitySinceMs: EpochMs | null;
};

/** What the ledger and the trip list add, read one driver at a time. */
export type DispatchWorkFacts = {
  /** Rupees owed and not cleared. Anything above zero holds new work. */
  outstandingPaise: MoneyPaise;
  /** True while they already carry a trip in one of the on-duty statuses. */
  carryingBooking: boolean;
};

/** A driver as dispatch sees them, with every fact the decision needs. */
export type DispatchCandidate = DispatchProfileFacts & DispatchWorkFacts;

/** A booking as far as dispatch cares about it: what kind of drive it needs. */
export type DispatchTripNeed = {
  serviceTypeId: ServiceTypeId;
};

export const DISPATCH_REFUSALS = [
  'not_approved',
  'duty_terms',
  'outstanding_dues',
  'busy',
  'service_type',
  'offline',
  /** This driver has already been asked about this trip — one offer each. */
  'already_offered',
  /** A different trip is still waiting on this driver's answer. */
  'pending_offer',
] as const;
export type DispatchRefusal = (typeof DISPATCH_REFUSALS)[number];

/** The profile half of the test: approval, the duty terms, the service, being online. */
export function profileRefusalFor(
  facts: DispatchProfileFacts,
  request: DispatchTripNeed,
  termsVersion: string = DUTY_TERMS.version,
): DispatchRefusal | null {
  if (facts.verificationStatus !== 'approved') return 'not_approved';
  if (facts.dutyTermsVersion !== termsVersion) return 'duty_terms';
  if (!facts.serviceTypeIds.includes(request.serviceTypeId)) return 'service_type';
  if (facts.availabilityState !== 'online') return 'offline';
  return null;
}

/** The money-and-work half: an unpaid bill or a trip already in hand. */
export function workRefusalFor(facts: DispatchWorkFacts): DispatchRefusal | null {
  if (facts.outstandingPaise > 0) return 'outstanding_dues';
  if (facts.carryingBooking) return 'busy';
  return null;
}

/** Why one driver was not handed this trip, or null when they may be. */
export function dispatchRefusalFor(
  candidate: DispatchCandidate,
  request: DispatchTripNeed,
  termsVersion: string = DUTY_TERMS.version,
): DispatchRefusal | null {
  return profileRefusalFor(candidate, request, termsVersion) ?? workRefusalFor(candidate);
}

/**
 * The waiting order: whoever went online first is asked first.
 *
 * This is the only fairness signal that exists today. Live position is not
 * published yet (`publishDriverLocation` is still Phase 3), so dispatch cannot
 * claim nearest-first — and a driver reading the log should not be told the car
 * that was closest was picked when the one that waited longest was.
 */
export function rankDispatchProfiles(
  profiles: readonly DispatchProfileFacts[],
  request: DispatchTripNeed,
  termsVersion: string = DUTY_TERMS.version,
): DispatchProfileFacts[] {
  return profiles
    .filter((profile) => profileRefusalFor(profile, request, termsVersion) === null)
    .sort(byWaitingTime);
}

function byWaitingTime(a: DispatchProfileFacts, b: DispatchProfileFacts): number {
  const aWait = a.availabilitySinceMs ?? Number.MAX_SAFE_INTEGER;
  const bWait = b.availabilitySinceMs ?? Number.MAX_SAFE_INTEGER;
  if (aWait !== bWait) return aWait - bWait;
  return a.uid < b.uid ? -1 : 1;
}

/** The full test and the full order, for a caller that already holds every fact. */
export function rankDispatchCandidates(
  candidates: readonly DispatchCandidate[],
  request: DispatchTripNeed,
  termsVersion: string = DUTY_TERMS.version,
): DispatchCandidate[] {
  return candidates
    .filter((candidate) => dispatchRefusalFor(candidate, request, termsVersion) === null)
    .sort(byWaitingTime);
}

/**
 * Every reason a candidate was skipped, for the log a dispatcher reads back.
 *
 * A booking that finds no driver is the interesting case, and "nobody matched"
 * is not an answer — whether it was six drivers who had not agreed the terms or
 * two who were already carrying a trip changes what the office does next.
 */
export function dispatchRefusalsFor(
  candidates: readonly DispatchCandidate[],
  request: DispatchTripNeed,
  termsVersion: string = DUTY_TERMS.version,
): Array<{ uid: string; refusal: DispatchRefusal }> {
  return candidates
    .map((candidate) => ({ uid: candidate.uid, refusal: dispatchRefusalFor(candidate, request, termsVersion) }))
    .filter((entry): entry is { uid: string; refusal: DispatchRefusal } => entry.refusal !== null);
}

/** The two profile fields that hold an acceptance, so they travel together. */
export const DUTY_TERMS_FIELDS = ['dutyTermsVersion', 'dutyTermsAcceptedAtMs'] as const;

export function hasAcceptedDutyTerms(
  facts: Pick<DispatchProfileFacts, 'dutyTermsVersion'>,
  termsVersion: string = DUTY_TERMS.version,
): boolean {
  return facts.dutyTermsVersion === termsVersion;
}
