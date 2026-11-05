import type { ServiceTypeId, UserRole } from './enums';

/**
 * Firebase Auth custom claims. Only Cloud Functions with the Admin SDK may
 * set these, and every rule reads them from `request.auth.token`.
 *
 * Claims are capped at ~1000 bytes, so they carry identity and capability
 * flags only — never booking lists or location data.
 */
export type AuthClaims = {
  /** Which surface the account opens first. Not a permission — read `roles`. */
  role: UserRole;
  /** Everything this account may do. Additive, and one number may hold two. */
  roles: UserRole[];
  /** Denormalised for terse rules. */
  admin: boolean;
  ops: boolean;
  /** True only after an admin has approved every required driver document. */
  driverVerified: boolean;
  zoneId: string | null;
  serviceTypeIds: ServiceTypeId[];
  /** Accounts created outside production hardening, e.g. emulator seeds. */
  testAccount?: boolean;
};

export const CLAIM_DEFAULTS: AuthClaims = {
  role: 'customer',
  roles: ['customer'],
  admin: false,
  ops: false,
  driverVerified: false,
  zoneId: null,
  serviceTypeIds: [],
};

/**
 * Whether an account may act in `role` at all.
 *
 * `roles` is the authority; `role` only says which surface the account opens by
 * default. One phone number can belong to a paying customer and a working
 * driver, and a check against the single `role` would lock that person out of
 * whichever half they are not currently standing in.
 */
export function holdsRole(
  claims: Pick<AuthClaims, 'role' | 'roles'>,
  role: UserRole,
): boolean {
  return Array.isArray(claims.roles) ? claims.roles.includes(role) : claims.role === role;
}

/**
 * Access-control mirror written to `authz/{bookingId}` in the Realtime
 * Database by Cloud Functions.
 *
 * Realtime Database rules cannot read Firestore, but rule expressions *can*
 * traverse `root` without being subject to rules themselves. That lets the
 * rules below authorise a tracker read from this mirror while clients have no
 * direct access to it.
 */
export type BookingAuthzMirror = {
  bookingId: string;
  customerUid: string;
  driverUid: string | null;
  /**
   * Trip-share grants as `uid -> true`. A map rather than an array because the
   * rules test membership with `sharedWith.child(uid).exists()`, which RTDB
   * cannot do against a list. Operations staff come through the `ops` claim
   * instead, so a temporary grant never needs a write here.
   */
  sharedWith: Record<string, boolean>;
  /** Mirrored so the rules can refuse location reads after completion. */
  trackingEnabled: boolean;
  expiresAtMs: number;
};

export const RTDB_AUTHZ_SEGMENT = 'authz';

export function rtdbAuthzPath(bookingId: string): string {
  return `${RTDB_AUTHZ_SEGMENT}/${bookingId}`;
}
