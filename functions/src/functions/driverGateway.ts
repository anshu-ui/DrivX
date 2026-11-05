import { onRequest } from 'firebase-functions/v2/https';
import { HttpsError } from 'firebase-functions/v2/https';
import { authAdmin } from '../lib/admin';
import { CALLABLE_OPTIONS } from '../lib/config';
import { callerFromVerifiedToken, requireAdminCaller, requireCustomerCaller, requireDriverCaller, requireDriverForNewWorkCaller, requireVerifiedDriverCaller } from '../lib/guards';
import { acceptDutyTermsForCaller } from './duty';
import { publishCustomerLocationForCaller, publishDriverLocationForCaller, respondToAssignmentForCaller, setAvailabilityForCaller, startTripApproachForCaller } from './dispatch';
import { cancelBookingForCaller, previewCouponForCaller } from './bookings';
import { customerContactForAssignedDriverCaller, tripCodesForCustomer } from './trip';
import { rateTripForCaller } from './ratings';
import { resolvePlaceForCaller, reverseGeocodeForCaller, searchPlacesForCaller } from './places';
import { claimDriverReferralCodeForCaller, claimReferralCodeForCaller, getRewardsForCaller, manageRewardsAdminForCaller, requestDriverRewardPayoutForCaller } from './rewards';

const handlers = {
  acceptDutyTerms: async (uid: string, claims: Record<string, unknown>, data: unknown) =>
    acceptDutyTermsForCaller(callerFromVerifiedToken(uid, claims), data),
  setAvailability: async (uid: string, claims: Record<string, unknown>, data: unknown) =>
    setAvailabilityForCaller(callerFromVerifiedToken(uid, claims), data),
  publishDriverLocation: async (uid: string, claims: Record<string, unknown>, data: unknown) =>
    publishDriverLocationForCaller(callerFromVerifiedToken(uid, claims), data),
  publishCustomerLocation: async (uid: string, claims: Record<string, unknown>, data: unknown) =>
    publishCustomerLocationForCaller(requireCustomerCaller(callerFromVerifiedToken(uid, claims)), data),
  respondToAssignment: async (uid: string, claims: Record<string, unknown>, data: unknown) =>
    respondToAssignmentForCaller(await requireDriverForNewWorkCaller(requireVerifiedDriverCaller(callerFromVerifiedToken(uid, claims))), data),
  startTripApproach: async (uid: string, claims: Record<string, unknown>, data: unknown) =>
    startTripApproachForCaller(requireVerifiedDriverCaller(callerFromVerifiedToken(uid, claims)), data),
  cancelBooking: async (uid: string, claims: Record<string, unknown>, data: unknown) =>
    cancelBookingForCaller(requireCustomerCaller(callerFromVerifiedToken(uid, claims)), data),
  previewCoupon: async (uid: string, claims: Record<string, unknown>, data: unknown) =>
    previewCouponForCaller(requireCustomerCaller(callerFromVerifiedToken(uid, claims)), data),
  tripCodes: async (uid: string, _claims: Record<string, unknown>, data: unknown) =>
    tripCodesForCustomer(uid, data),
  customerContactForAssignedDriver: async (uid: string, _claims: Record<string, unknown>, data: unknown) =>
    customerContactForAssignedDriverCaller(uid, data),
  rateTrip: async (uid: string, claims: Record<string, unknown>, data: unknown) =>
    rateTripForCaller(requireCustomerCaller(callerFromVerifiedToken(uid, claims)), data),
  searchPlaces: async (uid: string, claims: Record<string, unknown>, data: unknown) =>
    searchPlacesForCaller(requireCustomerCaller(callerFromVerifiedToken(uid, claims)), data),
  resolvePlace: async (uid: string, claims: Record<string, unknown>, data: unknown) =>
    resolvePlaceForCaller(requireCustomerCaller(callerFromVerifiedToken(uid, claims)), data),
  reverseGeocode: async (uid: string, claims: Record<string, unknown>, data: unknown) =>
    reverseGeocodeForCaller(requireCustomerCaller(callerFromVerifiedToken(uid, claims)), data),
  getRewards: async (uid: string, claims: Record<string, unknown>, data: unknown) =>
    getRewardsForCaller(callerFromVerifiedToken(uid, claims), data),
  claimReferralCode: async (uid: string, claims: Record<string, unknown>, data: unknown) =>
    claimReferralCodeForCaller(callerFromVerifiedToken(uid, claims), data),
  claimDriverReferralCode: async (uid: string, claims: Record<string, unknown>, data: unknown) =>
    claimDriverReferralCodeForCaller(callerFromVerifiedToken(uid, claims), data),
  manageRewardsAdmin: async (uid: string, claims: Record<string, unknown>, data: unknown) =>
    manageRewardsAdminForCaller(requireAdminCaller(callerFromVerifiedToken(uid, claims)), data),
  requestDriverRewardPayout: async (uid: string, claims: Record<string, unknown>, data: unknown) =>
    requestDriverRewardPayoutForCaller(requireDriverCaller(callerFromVerifiedToken(uid, claims)), data),
};

const customerActions = new Set([
  'cancelBooking', 'previewCoupon', 'tripCodes', 'publishCustomerLocation', 'rateTrip',
  'searchPlaces', 'resolvePlace', 'reverseGeocode', 'claimReferralCode',
]);
const driverActions = new Set(['claimDriverReferralCode', 'requestDriverRewardPayout']);
const adminActions = new Set(['manageRewardsAdmin']);

const httpStatus: Record<string, number> = {
  'invalid-argument': 400,
  'unauthenticated': 401,
  'permission-denied': 403,
  'not-found': 404,
  'already-exists': 409,
  'failed-precondition': 412,
  'resource-exhausted': 429,
  'unimplemented': 501,
  'unavailable': 503,
  'deadline-exceeded': 504,
};

/**
 * Narrow web gateway for callable actions blocked by the private Cloud Run
 * invoker policy. This is the only public-invoker service; every request still
 * needs a valid Firebase ID token and an action-specific role.
 */
export const driverGateway = onRequest(
  {
    region: CALLABLE_OPTIONS.region,
    memory: CALLABLE_OPTIONS.memory,
    cpu: CALLABLE_OPTIONS.cpu,
    maxInstances: CALLABLE_OPTIONS.maxInstances,
    timeoutSeconds: CALLABLE_OPTIONS.timeoutSeconds,
    cors: CALLABLE_OPTIONS.cors,
    invoker: 'public',
  },
  async (request, response) => {
    if (request.method !== 'POST') {
      response.set('Allow', 'POST, OPTIONS').status(405).json({ error: { status: 'INVALID_ARGUMENT', message: 'POST required.' } });
      return;
    }

    // Hosting may expose the original callable path on different URL fields
    // depending on whether the request arrived through a rewrite or directly.
    // Find the known action in any forwarded path instead of assuming path's
    // final segment survived the proxy unchanged.
    const actionNames = Object.keys(handlers);
    const forwardedPaths = [
      request.path,
      request.originalUrl,
      request.url,
      request.get('x-forwarded-uri'),
      request.get('x-original-url'),
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);
    const pathSegments = forwardedPaths.flatMap((value) => {
      try {
        return new URL(value, 'https://drivx.in').pathname.split('/').filter(Boolean);
      } catch {
        return value.split(/[/?#]/).filter(Boolean);
      }
    });
    const functionName = pathSegments.find((segment) => actionNames.includes(decodeURIComponent(segment))) ?? '';
    const handler = handlers[functionName as keyof typeof handlers];
    if (!handler) {
      console.warn(JSON.stringify({ level: 'warning', module: 'driverGateway', outcome: 'unknown_action', paths: forwardedPaths }));
      response.status(404).json({ error: { status: 'NOT_FOUND', message: 'Unknown driver action.' } });
      return;
    }

    const authorization = request.get('authorization') ?? '';
    const tokenMatch = /^Bearer\s+(.+)$/i.exec(authorization);
    if (!tokenMatch) {
      response.status(401).json({ error: { status: 'UNAUTHENTICATED', message: 'Sign-in required.' } });
      return;
    }

    try {
      const decoded = await authAdmin().verifyIdToken(tokenMatch[1]!, true);
      const caller = callerFromVerifiedToken(decoded.uid, decoded as Record<string, unknown>);
      if (customerActions.has(functionName)) requireCustomerCaller(caller);
      else if (driverActions.has(functionName)) requireDriverCaller(caller);
      else if (adminActions.has(functionName)) requireAdminCaller(caller);
      else if (functionName !== 'getRewards') requireDriverCaller(caller);
      if (functionName === 'publishDriverLocation' || functionName === 'respondToAssignment') requireVerifiedDriverCaller(caller);

      const payload = request.body as { data?: unknown } | undefined;
      const result = await handler(decoded.uid, decoded as Record<string, unknown>, payload?.data);
      response.status(200).json({ result });
    } catch (error) {
      if (error instanceof HttpsError) {
        const status = httpStatus[error.code] ?? 500;
        response.status(status).json({
          error: {
            status: error.code.replace(/-/g, '_').toUpperCase(),
            message: error.message,
            ...(error.details === undefined ? {} : { details: error.details }),
          },
        });
        return;
      }
      // Token parsing failures are deliberately indistinguishable to callers.
      if (error instanceof Error && /token|credential|revoked|expired/i.test(error.message)) {
        response.status(401).json({ error: { status: 'UNAUTHENTICATED', message: 'Sign-in expired. Sign in again.' } });
        return;
      }
      console.error(JSON.stringify({ level: 'error', module: 'driverGateway', functionName, message: error instanceof Error ? error.message : 'Unknown error' }));
      response.status(500).json({ error: { status: 'INTERNAL', message: 'The driver request could not be completed.' } });
    }
  },
);
