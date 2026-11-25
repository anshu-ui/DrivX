import { describe, expect, it } from 'vitest';
import { createBookingInputSchema, emailSchema, signUpProfileInputSchema } from '../src/validation';

const bookingInput = {
  serviceTypeId: 'chauffeur_own_car',
  pickup: {
    label: 'Connaught Place, New Delhi', addressLine1: 'Connaught Place', city: 'New Delhi', state: 'Delhi',
    pincode: '110001', location: { lat: 28.6315, lng: 77.2167 }, source: 'map_pin',
  },
  destination: {
    label: 'India Gate, New Delhi', addressLine1: 'India Gate', city: 'New Delhi', state: 'Delhi',
    pincode: '110001', location: { lat: 28.6129, lng: 77.2295 }, source: 'map_pin',
  },
  preferences: { transmission: 'either', carType: 'either' },
  idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
};

describe('createBookingInputSchema scheduling', () => {
  it('accepts an ASAP booking with a null schedule', () => {
    expect(createBookingInputSchema.safeParse({ ...bookingInput, scheduledForMs: null }).success).toBe(true);
  });

  it('requires scheduled pickups to be at least 30 minutes ahead', () => {
    const result = createBookingInputSchema.safeParse({
      ...bookingInput,
      scheduledForMs: Date.now() + 10 * 60 * 1000,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.message === 'Pickups must be scheduled at least 30 minutes ahead'))
      .toBe(true);
  });

  it('accepts an in-range scheduled booking and rejects dates beyond six months', () => {
    expect(createBookingInputSchema.safeParse({
      ...bookingInput,
      scheduledForMs: Date.now() + 60 * 60 * 1000,
    }).success).toBe(true);
    const result = createBookingInputSchema.safeParse({
      ...bookingInput,
      scheduledForMs: Date.now() + 210 * 24 * 60 * 60 * 1000,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.message === 'Bookings can be scheduled up to 6 months ahead'))
      .toBe(true);
  });
});

describe('emailSchema', () => {
  it('stores the address lowercased and trimmed', () => {
    expect(emailSchema.parse('  Amit@DrivX.Test ')).toBe('amit@drivx.test');
  });

  it('accepts an address with a subdomain and a plus tag', () => {
    expect(emailSchema.safeParse('a.b+c@mail.drivx.test').success).toBe(true);
  });

  it.each(['', 'no-at-sign', 'two@@at.test', 'no-domain@', 'short@x'])('refuses %j', (value) => {
    expect(emailSchema.safeParse(value).success).toBe(false);
  });

  it('explains the refusal instead of a generic parse error', () => {
    const result = emailSchema.safeParse('not an email');
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('Enter a valid email address');
  });

  it('refuses an address longer than a mailbox can hold', () => {
    expect(emailSchema.safeParse(`${'a'.repeat(250)}@drivx.test`).success).toBe(false);
  });
});

describe('signUpProfileInputSchema', () => {
  it('accepts the pair the first-run form submits', () => {
    const parsed = signUpProfileInputSchema.parse({
      fullName: 'Amit Chauhan',
      email: 'AMIT@example.test',
    });
    expect(parsed).toEqual({ fullName: 'Amit Chauhan', email: 'amit@example.test' });
  });

  it('refuses a one-character name', () => {
    expect(signUpProfileInputSchema.safeParse({ fullName: 'A', email: 'a@example.test' }).success)
      .toBe(false);
  });

  it('refuses a sign-up with no email', () => {
    expect(signUpProfileInputSchema.safeParse({ fullName: 'Amit', email: '' }).success).toBe(false);
  });
});
