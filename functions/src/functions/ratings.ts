import { onCall } from 'firebase-functions/v2/https';
import {
  applyRating,
  bookingRefPath,
  customerRatingId,
  DRIVER_RATING_TAGS,
  ratingPath,
  rateTripInputSchema,
  type BookingStatus,
} from '@drivx/domain';
import { db, epochMs, serverTimestamp } from '../lib/admin';
import { CALLABLE_OPTIONS } from '../lib/config';
import { failedPrecondition, notFound, parseInput, permissionDenied } from '../lib/errors';
import { requireCustomer, type Caller } from '../lib/guards';
import { deliverInbox } from '../lib/notify';

/**
 * The customer rates the driver, once, on a trip that actually finished.
 *
 * The owner asked for this twice: a rating against the driver, and a rating
 * section in the driver's own app. Only one of those can exist without the
 * other being wired first, and the order is fixed by the rules — `ratings` is
 * `write: if false` for every client, so the number the driver sees has to be
 * produced by a function. That is this file.
 *
 * Three things are decided here rather than on a screen:
 *
 * - **Only a closed trip can be rated.** An in-progress trip has no service to
 *   judge, and a rating written before the bill exists is a rating written
 *   against an outcome nobody knows yet.
 * - **Only the customer on the booking rates it,** and it lands on the driver
 *   the booking records — not on a uid a client typed.
 * - **One rating per trip.** The document id is derived from the booking id, so
 *   a second submit collides instead of becoming a second row, and the same
 *   answer comes back as the first one did rather than an error.
 *
 * The average is recomputed inside the transaction from the profile as it reads
 * at that moment, so two customers closing their trips in the same second cannot
 * both fold themselves into the same previous average and lose one.
 */

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** The chips, filtered to the set the product defines, in the order they were picked. */
function knownTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set<string>(DRIVER_RATING_TAGS);
  return value.filter((item): item is string => typeof item === 'string' && allowed.has(item));
}

const TAG_LABELS: Record<(typeof DRIVER_RATING_TAGS)[number], string> = {
  drove_carefully: 'drove carefully',
  knew_the_route: 'knew the route',
  arrived_on_time: 'arrived on time',
  polite: 'was polite',
  helped_with_luggage: 'helped with the luggage',
  car_was_clean: 'kept the car clean',
};

function describeTags(tags: string[]): string {
  const named = tags.map((tag) => TAG_LABELS[tag as (typeof DRIVER_RATING_TAGS)[number]] ?? tag);
  if (named.length === 0) return '';
  if (named.length === 1) return named[0]!;
  return `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
}

const RATABLE: BookingStatus[] = ['completed'];

export async function rateTripForCaller(caller: Caller, rawInput: unknown) {
  const input = parseInput(rateTripInputSchema, rawInput);
  const tags = knownTags(input.tags);

  const bookingSnap = await db().doc(bookingRefPath(input.bookingId)).get();
  if (!bookingSnap.exists) throw notFound('No booking with that id.');
  const booking = bookingSnap.data() ?? {};
  const status = booking.status as BookingStatus;

  if (booking.customerUid !== caller.uid) {
    throw permissionDenied('This booking is not yours.');
  }

  if (!RATABLE.includes(status)) {
    throw failedPrecondition(
      status === 'cancelled'
        ? 'A cancelled trip has no service to rate.'
        : 'The trip can be rated once it has been closed.',
    );
  }

  const driverUid = text(booking.assignedDriverUid);
  if (!driverUid) {
    throw failedPrecondition('This booking records no driver, so there is nobody to rate.');
  }

  const ratingRef = db().doc(ratingPath(customerRatingId(input.bookingId)));
  const profileRef = db().doc(`driverProfiles/${driverUid}`);
  const reference = text(booking.reference) ?? input.bookingId;

  const outcome = await db().runTransaction(async (tx) => {
    const existing = await tx.get(ratingRef);
    if (existing.exists) {
      const data = existing.data() ?? {};
      return {
        alreadyRated: true as const,
        ratingId: existing.id,
        bookingReference: text(data.bookingReference),
        score: count(data.score),
        tags: knownTags(data.tags),
        comment: text(data.comment),
        createdAtMs: epochMs(data.createdAtMs),
      };
    }

    const profileSnap = await tx.get(profileRef);
    if (!profileSnap.exists) {
      throw failedPrecondition('The driver this trip was assigned to has no profile to rate.');
    }
    const profile = profileSnap.data() ?? {};
    const aggregate = applyRating(
      { ratingAverage: profile.ratingAverage ?? null, ratingCount: count(profile.ratingCount) },
      input.score,
    );

    tx.create(ratingRef, {
      id: ratingRef.id,
      bookingId: input.bookingId,
      bookingReference: reference,
      raterUid: caller.uid,
      ratedUid: driverUid,
      direction: 'customer_to_driver',
      score: input.score,
      tags,
      comment: input.comment ?? null,
      createdAtMs: serverTimestamp(),
    });

    // The two fields every customer-facing screen already reads, moved by the
    // one event that is allowed to move them.
    tx.update(profileRef, { ...aggregate, updatedAtMs: serverTimestamp() });

    // The booking carries the score too, so the receipt the customer is looking
    // at can say what they gave without querying another collection.
    tx.update(bookingSnap.ref, { customerRating: input.score });

    return {
      alreadyRated: false as const,
      ratingId: ratingRef.id,
      bookingReference: reference,
      score: input.score,
      tags,
      comment: input.comment ?? null,
      createdAtMs: null,
      driverRating: aggregate,
      driverName: text(profile.fullName) ?? 'your driver',
    };
  });

  if (!outcome.alreadyRated) {
    const said = describeTags(outcome.tags);
    await deliverInbox({
      uid: driverUid,
      id: `rated_${input.bookingId}`,
      type: 'driver_rated',
      title: `You were rated on trip ${reference}`,
      body:
        `${outcome.score} star${outcome.score === 1 ? '' : 's'} from the customer${said ? ` — ${said}` : ''}. ` +
        `Your average is now ${outcome.driverRating.ratingAverage.toFixed(2)} from ` +
        `${outcome.driverRating.ratingCount} rating${outcome.driverRating.ratingCount === 1 ? '' : 's'}, ` +
        'on your Account screen.',
      // No route: `/account` is one URL shared by both apps' Account screens, so
      // a deep link here lands a driver on the customer's screen and the surface
      // guard bounces them to Duty. The inbox row is a message, not a broken link.
      route: null,
      bookingId: input.bookingId,
    });
  }

  return outcome;
}

export const rateTrip = onCall(CALLABLE_OPTIONS, async (request) =>
  rateTripForCaller(requireCustomer(request), request.data),
);
