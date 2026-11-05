import { describe, expect, it } from 'vitest';
import { BOOKING_STATUSES, CANCELLABLE_STATUSES, CANCELLATION_BY, isCancellable } from '../src/enums';
import { ALLOWED_TRANSITIONS, allowedNextStates, canTransition } from '../src/ports';
import { cancelBookingInputSchema } from '../src/validation';

/**
 * The owner's rule, written as a test rather than left to a comment: a trip is
 * ended by the customer who booked it and by nobody else. The state machine is
 * the only place that authorises a transition, so if a driver edge to
 * `cancelled` ever comes back, this is what fails.
 */
describe('who may end a booking', () => {
  it('authorises cancellation for the customer alone', () => {
    const actors = ALLOWED_TRANSITIONS.filter((t) => t.to === 'cancelled').map((t) => t.actor);
    expect([...new Set(actors)]).toEqual(['customer']);
  });

  it.each(BOOKING_STATUSES)('refuses a driver cancellation from %s', (status) => {
    expect(canTransition(status, 'cancelled', 'driver')).toBe(false);
  });

  it.each(['admin', 'ops', 'system'] as const)(
    'refuses a %s cancellation — staff closure is not a surface yet',
    (actor) => {
      for (const status of BOOKING_STATUSES) {
        expect(canTransition(status, 'cancelled', actor)).toBe(false);
      }
    },
  );

  it('gives a driver who cannot attend the way back to the pool', () => {
    expect(canTransition('assigned', 'searching_driver', 'driver')).toBe(true);
    expect(allowedNextStates('assigned', 'driver')).toEqual(['driver_en_route', 'searching_driver']);
  });

  it('records no driver among the ways a booking ends', () => {
    expect(CANCELLATION_BY).not.toContain('driver');
  });

  it('agrees with the statuses the app puts a Cancel button on', () => {
    // `isCancellable` is what the button reads. A status it calls cancellable
    // while the machine refuses the move would be a control that only ever
    // answers with an error.
    expect([...CANCELLABLE_STATUSES]).toEqual(
      BOOKING_STATUSES.filter((status) => canTransition(status, 'cancelled', 'customer')),
    );
    for (const status of CANCELLABLE_STATUSES) expect(isCancellable(status)).toBe(true);
  });
});

describe('cancelBookingInputSchema', () => {
  const bookingId = 'bk-12345678';

  it('accepts a reason the app offers', () => {
    expect(cancelBookingInputSchema.safeParse({ bookingId, reasonCode: 'plan_changed' }).success).toBe(true);
  });

  it('defaults an absent note to null rather than undefined', () => {
    const parsed = cancelBookingInputSchema.parse({ bookingId, reasonCode: 'other' });
    expect(parsed.reasonText).toBeNull();
  });

  it('refuses a reason it has no label or report line for', () => {
    expect(cancelBookingInputSchema.safeParse({ bookingId, reasonCode: 'driver_was_late' }).success).toBe(false);
  });

  it('refuses an id too short to be a booking', () => {
    expect(cancelBookingInputSchema.safeParse({ bookingId: 'bk-1', reasonCode: 'other' }).success).toBe(false);
  });

  it('caps the free text at what an operator will actually read', () => {
    expect(
      cancelBookingInputSchema.safeParse({ bookingId, reasonCode: 'other', reasonText: 'x'.repeat(301) }).success,
    ).toBe(false);
  });
});
