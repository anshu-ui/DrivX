import { COLLECTIONS } from './collections';
import { RATING_SCORE_MAX, RATING_SCORE_MIN } from './enums';

/**
 * The ratings ledger, and the one arithmetic that touches a driver's number.
 *
 * A rating is written by a Cloud Function and nowhere else, so the only client
 * code that needs these helpers is the read path. The id is derived from the
 * booking rather than generated, because "one rating per customer per trip" is
 * the rule the owner asked for and a deterministic id is what makes a second
 * submit collide instead of becoming a second row.
 */

/** `ratings/{id}` — one person's verdict on one closed trip. */
export function ratingPath(id: string): string {
  return `${COLLECTIONS.ratings}/${id}`;
}

/** The customer's rating of the driver who drove their trip. */
export function customerRatingId(bookingId: string): string {
  return `customer_${bookingId}`;
}

/**
 * The two fields every profile carries and only a rating moves.
 *
 * `ratingAverage` is nullable because a freshly approved driver has never been
 * rated — the customer card and this arithmetic both have to cope with that
 * without a `?? 0` scattered at each call site.
 */
export type RatingAggregate = { ratingAverage: number | null; ratingCount: number };

/** The same pair once at least one score is in it — which is what folding a rating always produces. */
export type RatedAggregate = { ratingAverage: number; ratingCount: number };

/**
 * Fold one score into the running average.
 *
 * The stored average is what both apps show, so it is recomputed from the
 * previous average and count rather than from a list nobody keeps in sync. Two
 * decimals because that is how a star figure is read; below that the difference
 * between two drivers is decoration.
 */
export function applyRating(current: RatingAggregate, score: number): RatedAggregate {
  if (!Number.isInteger(score) || score < RATING_SCORE_MIN || score > RATING_SCORE_MAX) {
    throw new RangeError(`A rating score is a whole number between ${RATING_SCORE_MIN} and ${RATING_SCORE_MAX}.`);
  }
  const count = Math.max(0, Math.trunc(current.ratingCount));
  // A profile that has never been rated can hold null, and a null averaged into
  // an aggregate is NaN travelling down to every screen that reads it.
  const stored = current.ratingAverage;
  const average = typeof stored === 'number' && Number.isFinite(stored) ? stored : 0;
  const next = (average * count + score) / (count + 1);
  return { ratingAverage: Math.round(next * 100) / 100, ratingCount: count + 1 };
}
