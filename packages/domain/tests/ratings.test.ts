import { describe, expect, it } from 'vitest';
import { applyRating, customerRatingId, ratingPath } from '../src/ratings';
import { DRIVER_RATING_TAGS } from '../src/enums';
import { rateTripInputSchema } from '../src/validation';

describe('applyRating', () => {
  it('starts the average at the first score on an unrated account', () => {
    expect(applyRating({ ratingAverage: null, ratingCount: 0 }, 4)).toEqual({
      ratingAverage: 4,
      ratingCount: 1,
    });
  });

  it('folds the new score into the running average, not into a list', () => {
    // 18 ratings at 4.7 is 84.6; a 19th at 4 is 88.6 / 19 = 4.663…, two decimals.
    expect(applyRating({ ratingAverage: 4.7, ratingCount: 18 }, 4)).toEqual({
      ratingAverage: 4.66,
      ratingCount: 19,
    });
  });

  it('keeps a perfect account perfect', () => {
    expect(applyRating({ ratingAverage: 5, ratingCount: 40 }, 5).ratingAverage).toBe(5);
  });

  it('lifts a one-star account by the share the new rating is worth', () => {
    expect(applyRating({ ratingAverage: 1, ratingCount: 1 }, 5)).toEqual({
      ratingAverage: 3,
      ratingCount: 2,
    });
  });

  it('treats a corrupt count as no ratings rather than a negative weight', () => {
    expect(applyRating({ ratingAverage: 3, ratingCount: -5 }, 5)).toEqual({
      ratingAverage: 5,
      ratingCount: 1,
    });
  });

  it.each([0, 6, 2.5, Number.NaN])('refuses a score of %j instead of writing it', (score) => {
    expect(() => applyRating({ ratingAverage: 4, ratingCount: 3 }, score)).toThrow(RangeError);
  });
});

describe('rating ids', () => {
  it('names the customer rating after the booking, so a second one collides', () => {
    expect(customerRatingId('bk-7K3QD2')).toBe('customer_bk-7K3QD2');
    expect(ratingPath(customerRatingId('bk-7K3QD2'))).toBe('ratings/customer_bk-7K3QD2');
  });
});

describe('rateTripInputSchema', () => {
  it('accepts the payload the trip receipt submits', () => {
    const parsed = rateTripInputSchema.parse({
      bookingId: 'bk-7K3QD2AB',
      score: 4,
      tags: ['polite', 'arrived_on_time'],
      comment: 'Waited without complaint.',
    });
    expect(parsed).toEqual({
      bookingId: 'bk-7K3QD2AB',
      score: 4,
      tags: ['polite', 'arrived_on_time'],
      comment: 'Waited without complaint.',
    });
  });

  it('takes a score alone and stores no tags and no comment', () => {
    expect(rateTripInputSchema.parse({ bookingId: 'bk-7K3QD2AB', score: 3 })).toEqual({
      bookingId: 'bk-7K3QD2AB',
      score: 3,
      tags: [],
      comment: null,
    });
  });

  it.each([0, 6, 4.5])('refuses a score of %j', (score) => {
    expect(rateTripInputSchema.safeParse({ bookingId: 'bk-7K3QD2AB', score }).success).toBe(false);
  });

  it('refuses a tag the product has never defined', () => {
    expect(
      rateTripInputSchema.safeParse({ bookingId: 'bk-7K3QD2AB', score: 5, tags: ['gave_a_bribe'] })
        .success,
    ).toBe(false);
  });

  it.each([...DRIVER_RATING_TAGS])('accepts the shipped tag %j', (tag) => {
    expect(rateTripInputSchema.safeParse({ bookingId: 'bk-7K3QD2AB', score: 5, tags: [tag] }).success)
      .toBe(true);
  });

  it('refuses a booking id that is too short to be one', () => {
    expect(rateTripInputSchema.safeParse({ bookingId: 'bk-1', score: 5 }).success).toBe(false);
  });
});
