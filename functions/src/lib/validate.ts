import { z } from 'zod';

/**
 * Bridges a frozen `as const` tuple into zod's enum signature so the closed
 * sets in `@drivx/domain` remain the single source of truth on both sides of
 * the wire.
 */
export function zodEnum<T extends readonly string[]>(values: T) {
  return z.enum(values as unknown as [T[number], ...T[number][]]);
}

/**
 * An account id from Firebase Auth.
 *
 * OTP-generated UIDs are 20 characters on legacy projects and 28 on newer ones,
 * so the floor is 20 rather than 28 — a 28-character check silently refused
 * every real admin action against a 20-character account. It is still a floor:
 * the hand-written ids in `scripts/seed.mjs` (`drv-1`, `admin-1`) are fixtures for
 * reading, not accounts, and a privileged callable must not accept them.
 */
export const uidSchema = z.string().min(20).max(128);

export const e164PhoneSchema = z.string().regex(/^\+[1-9]\d{7,14}$/, 'Expected an E.164 phone number');

export const placeSchema = z.object({
  label: z.string().min(4).max(300),
  addressLine1: z.string().min(3).max(200),
  // The callable transport turns an absent field into `null`, so `.optional()`
  // alone would reject a well-formed request that simply has no line two.
  addressLine2: z
    .string()
    .max(200)
    .nullish()
    .transform((v) => v ?? undefined),
  city: z.string().min(2).max(80),
  state: z.string().min(2).max(80),
  pincode: z
    .string()
    .regex(/^[1-9]\d{5}$/)
    .nullish()
    .transform((v) => v ?? undefined),
  location: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }),
  placeId: z
    .string()
    .max(120)
    .nullish()
    .transform((v) => v ?? undefined),
  source: z.enum(['places_autocomplete', 'map_pin', 'saved_place', 'reverse_geocode']),
});
