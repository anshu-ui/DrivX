import type { CallableRequest } from 'firebase-functions/v2/https';
import type { AuthClaims } from '@drivx/domain';
import { CLAIM_DEFAULTS, holdsRole } from '@drivx/domain';
import { db } from './admin';
import { assertNoOutstandingDues } from './dues';
import { failedPrecondition, permissionDenied } from './errors';

/** The caller, verified from the ID token the SDK attached to the request. */
export type Caller = {
  uid: string;
  claims: AuthClaims;
};

/** Build the same normalized caller used by callable handlers from a verified Auth token. */
export function callerFromVerifiedToken(uid: string, token: Record<string, unknown>): Caller {
  const role = typeof token.role === 'string' ? (token.role as AuthClaims['role']) : CLAIM_DEFAULTS.role;
  return {
    uid,
    claims: {
      ...CLAIM_DEFAULTS,
      serviceTypeIds: [],
      zoneId: null,
      roles: Array.isArray(token.roles) ? (token.roles as AuthClaims['roles']) : [role],
      role,
      admin: token.admin === true,
      ops: token.ops === true,
      driverVerified: token.driverVerified === true,
    },
  };
}

export function requireAuth(request: CallableRequest<unknown>): Caller {
  const auth = request.auth;
  if (!auth) throw permissionDenied('Sign-in required.');

  return callerFromVerifiedToken(auth.uid, auth.token as unknown as Record<string, unknown>);
}

export function requireAdmin(request: CallableRequest<unknown>): Caller {
  const caller = requireAuth(request);
  return requireAdminCaller(caller);
}

export function requireAdminCaller(caller: Caller): Caller {
  if (!caller.claims.admin) throw permissionDenied('Administrator role required.');
  return caller;
}

/** Staff covers both administrators and operations personnel. */
export function requireStaff(request: CallableRequest<unknown>): Caller {
  const caller = requireAuth(request);
  if (!caller.claims.admin && !caller.claims.ops) {
    throw permissionDenied('Administrator or operations role required.');
  }
  return caller;
}

export function requireDriver(request: CallableRequest<unknown>): Caller {
  const caller = requireAuth(request);
  return requireDriverCaller(caller);
}

export function requireDriverCaller(caller: Caller): Caller {
  // `role` selects the default surface; `roles` is the permission list. A
  // phone account may hold both customer and driver access, so guard by the
  // granted capability instead of the preferred surface.
  if (!holdsRole(caller.claims, 'driver')) throw permissionDenied('Driver role required.');
  return caller;
}

export function requireCustomer(request: CallableRequest<unknown>): Caller {
  const caller = requireAuth(request);
  return requireCustomerCaller(caller);
}

export function requireCustomerCaller(caller: Caller): Caller {
  if (!holdsRole(caller.claims, 'customer')) throw permissionDenied('Customer role required.');
  return caller;
}

export function requireVerifiedDriver(request: CallableRequest<unknown>): Caller {
  const caller = requireDriver(request);
  return requireVerifiedDriverCaller(caller);
}

export function requireVerifiedDriverCaller(caller: Caller): Caller {
  if (!caller.claims.driverVerified) {
    throw permissionDenied('Your documents must be approved before you can accept bookings.');
  }
  return caller;
}

/**
 * A driver who may be handed *new* work: approved, and with nothing unpaid.
 *
 * This is the owner's rule that a driver with uncleared dues stops receiving
 * bookings, placed on the two calls that put a driver in front of a customer —
 * going online and accepting an offer. It deliberately does not guard the trip
 * itself: a driver mid-journey with a customer in the car is never cut off over
 * money, and finishing the trip is what produces the fare the commission is
 * charged on.
 */
export async function requireDriverForNewWork(request: CallableRequest<unknown>): Promise<Caller> {
  const caller = requireVerifiedDriver(request);
  return requireDriverForNewWorkCaller(caller);
}

export async function requireDriverForNewWorkCaller(caller: Caller): Promise<Caller> {
  const profile = await db().doc(`driverProfiles/${caller.uid}`).get();
  if (!profile.exists) throw failedPrecondition('Your driver profile is missing, so no new trip can be offered.');
  if (profile.get('accountStatus') === 'suspended') {
    throw failedPrecondition('Your account is paused by DrivX support. Contact support before taking new trips.');
  }
  await assertNoOutstandingDues(caller.uid);
  return caller;
}
