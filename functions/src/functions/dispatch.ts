import { onCall } from 'firebase-functions/v2/https';
import { z } from 'zod';
import {
  assignmentIdFor,
  assignmentPath,
  bookingRefPath,
  COLLECTIONS,
  DRIVER_ON_DUTY_STATUSES,
  DUTY_TERMS,
  hasAcceptedDutyTerms,
  RTDB_PATHS,
  RTDB_RETENTION,
  SUBCOLLECTIONS,
  OFFER_NEVER_EXPIRES_AT_MS,
  type BookingStatus,
  type AssignedDriverCard,
} from '@drivx/domain';
import { db, epochMs, rtdb, serverTimestamp } from '../lib/admin';
import { CALLABLE_OPTIONS } from '../lib/config';
import { offerTrip, workFactsFor } from '../lib/dispatch';
import { deliverInbox } from '../lib/notify';
import { failedPrecondition, notFound, parseInput, permissionDenied } from '../lib/errors';
import {
  requireAdmin,
  requireDriver,
  requireDriverCaller,
  requireDriverForNewWork,
  requireDriverForNewWorkCaller,
  requireVerifiedDriver,
  requireVerifiedDriverCaller,
  type Caller,
} from '../lib/guards';

const respondInput = z.object({
  bookingId: z.string().min(8).max(64),
  decision: z.enum(['accept', 'decline']),
  reason: z.string().trim().max(200).optional(),
});

const AVAILABILITY_STATES = ['online', 'offline', 'break'] as const;

function log(entry: Record<string, unknown>): void {
  console.log(JSON.stringify({ level: 'info', module: 'dispatch', ...entry }));
}

async function readBooking(bookingId: string): Promise<Record<string, unknown> & { id: string }> {
  const snap = await db().doc(bookingRefPath(bookingId)).get();
  if (!snap.exists) throw notFound('No booking with that id.');
  return { id: snap.id, ...(snap.data() ?? {}) };
}

/** The driver's own profile, which is where the duty terms are agreed. */
async function readProfile(uid: string): Promise<Record<string, unknown>> {
  const snap = await db().doc(`${COLLECTIONS.driverProfiles}/${uid}`).get();
  if (!snap.exists) throw failedPrecondition('Your driver profile is missing, so no trip can be handed to you.');
  return snap.data() ?? {};
}

/**
 * One line in the booking's event log, written by dispatch rather than the trip.
 *
 * The offer, the accept and the decline belong on the same timeline the rest of
 * the trip is recorded on, so the office reading a booking can see who was asked
 * and what they said — which is the only audit that distinguishes "this driver
 * declined three times" from "nobody was ever asked".
 */
async function writeEvent(input: {
  bookingId: string;
  type: 'driver_assigned' | 'driver_declined' | 'driver_en_route';
  actorUid: string;
  fromStatus: BookingStatus;
  toStatus: BookingStatus;
  payload: Record<string, unknown>;
}): Promise<void> {
  const eventId =
    input.type === 'driver_declined' ? `ev-driver_declined-${input.actorUid}` : `ev-${input.type}`;
  await db()
    .doc(`${bookingRefPath(input.bookingId)}/events/${eventId}`)
    .set({
      id: eventId,
      bookingId: input.bookingId,
      type: input.type,
      atMs: serverTimestamp(),
      actor: { uid: input.actorUid, role: 'driver' },
      location: null,
      geofenceKind: null,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      payload: input.payload,
    });
}

const enRouteInput = z.object({ bookingId: z.string().min(8).max(64) });

/** Assigned driver explicitly starts toward pickup; customer gets a state event. */
export async function startTripApproachForCaller(caller: Caller, raw: unknown) {
  const { bookingId } = parseInput(enRouteInput, raw);
  const bookingRef = db().doc(bookingRefPath(bookingId));
  const now = Date.now();
  let changed = false;
  await db().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(bookingRef);
    if (!snapshot.exists) throw notFound('No booking with that id.');
    const booking = snapshot.data() ?? {};
    if (booking.assignedDriverUid !== caller.uid) throw permissionDenied('This trip is not assigned to you.');
    const status = String(booking.status ?? '') as BookingStatus;
    if (status === 'driver_en_route') return;
    if (status !== 'assigned') throw failedPrecondition('You can only start toward pickup after accepting an assigned trip.');
    changed = true;
    transaction.update(bookingRef, {
      status: 'driver_en_route',
      stateVersion: Number(booking.stateVersion ?? 0) + 1,
      driverEnRouteAtMs: now,
      updatedAtMs: serverTimestamp(),
    });
  });
  if (changed) {
    await Promise.all([
      rtdb().ref(`activeBookings/${bookingId}`).update({ status: 'driver_en_route', updatedAtMs: now }),
      writeEvent({ bookingId, type: 'driver_en_route', actorUid: caller.uid, fromStatus: 'assigned', toStatus: 'driver_en_route', payload: {} }),
    ]);
  }
  return { bookingId, status: 'driver_en_route' as const };
}

/**
 * Driver: take the trip or hand it back.
 *
 * The owner's flow, in his words: "term agree karne ke baad hi uske paas vo
 * booking aaegi… accept/reject… uske baad start karna hai". So this is the door
 * between an offer and a job, and it is deliberately narrow:
 *
 * - **Only the driver the offer was written for can answer it.** The assignment
 *   id is derived from the booking *and* the caller's uid, so there is no id to
 *   guess and no way to answer somebody else's offer.
 * - **An offer stays open.** It remains available until a driver accepts or
 *   declines; accepting still uses the first-accept-wins transaction guard.
 * - **Declining is not cancelling.** The booking goes back to be offered again.
 *   Only the customer can end a trip, which is why there is no cancel path here.
 * - **The money and the terms are re-checked at the door.** `requireDriverForNewWork`
 *   already refuses an unpaid driver, and the duty-terms version is read from the
 *   profile rather than trusted from the offer, so an office that changes the
 *   terms stops every offer in flight until the driver agrees again.
 *
 * Accepting writes `assignedDriverUid`, which is what the driver-card trigger
 * watches: the customer gets the driver's name, number, photo, car and rating
 * without this function touching any of those fields.
 */
export const respondToAssignment = onCall(CALLABLE_OPTIONS, async (request) => {
  const caller = await requireDriverForNewWork(request);
  return respondToAssignmentForCaller(caller, request.data);
});

/** Shared implementation for the callable and authenticated Hosting gateway. */
export async function respondToAssignmentForCaller(caller: Caller, raw: unknown) {
  const input = parseInput(respondInput, raw);

  const assignmentId = assignmentIdFor(input.bookingId, caller.uid);
  const assignmentRef = db().doc(assignmentPath(input.bookingId, assignmentId));
  const assignmentSnap = await assignmentRef.get();
  if (!assignmentSnap.exists) {
    throw notFound('No open offer for that trip is on your account.');
  }
  const offer = assignmentSnap.data() as Record<string, unknown>;
  const offerStatus = String(offer.status ?? '');
  if (offerStatus !== 'offered') {
    throw failedPrecondition(
      `That offer is already "${offerStatus}", so nothing was changed. Your trips are on the Duty screen.`,
    );
  }

  const booking = await readBooking(input.bookingId);
  const status = booking.status as BookingStatus;
  const now = Date.now();
  if (input.decision === 'accept') {
    const work = await workFactsFor(caller.uid);
    if (work.carryingBooking) {
      throw failedPrecondition('You are already carrying a trip. Finish it before taking another.');
    }
    const bookingRef = db().doc(bookingRefPath(input.bookingId));
    const profileRef = db().doc(`${COLLECTIONS.driverProfiles}/${caller.uid}`);
    const accepted = await db().runTransaction(async (transaction) => {
      const [liveOffer, liveBooking, liveProfile] = await Promise.all([
        transaction.get(assignmentRef),
        transaction.get(bookingRef),
        transaction.get(profileRef),
      ]);
      if (!liveOffer.exists || !liveBooking.exists || !liveProfile.exists) {
        throw notFound('That offer or its trip no longer exists.');
      }
      const currentOffer = liveOffer.data() ?? {};
      const currentBooking = liveBooking.data() ?? {};
      const currentProfile = liveProfile.data() ?? {};
      const customerUid = typeof currentBooking.customerUid === 'string' ? currentBooking.customerUid : null;
      const [customerProfile, customerUser] = customerUid
        ? await Promise.all([
            transaction.get(db().doc(`${COLLECTIONS.customerProfiles}/${customerUid}`)),
            transaction.get(db().doc(`${COLLECTIONS.users}/${customerUid}`)),
          ])
        : [null, null];
      if (currentOffer.status !== 'offered') {
        throw failedPrecondition('Another action already closed this offer. Refresh Duty for the latest trips.');
      }
      if (currentProfile.accountStatus === 'suspended') {
        throw failedPrecondition('Your account is paused by DrivX support. Contact support before accepting trips.');
      }
      if (!hasAcceptedDutyTerms({ dutyTermsVersion: typeof currentProfile.dutyTermsVersion === 'string' ? currentProfile.dutyTermsVersion : null })) {
        throw failedPrecondition(
          `The terms of duty changed on ${DUTY_TERMS.version}. Agree to them on the Duty screen before you take a trip.`,
        );
      }
      if (currentProfile.availabilityState !== 'online') {
        throw failedPrecondition('Go online again before accepting this trip.');
      }
      if (currentBooking.assignedDriverUid != null) {
        throw failedPrecondition('Another driver has already taken this trip, so it is no longer yours to accept.');
      }
      transaction.update(assignmentRef, { status: 'accepted', respondedAtMs: now, updatedAtMs: serverTimestamp() });
      transaction.update(bookingRef, {
        assignedDriverUid: caller.uid,
        // Publish the customer-safe driver card atomically with assignment so
        // the customer need not wait for the asynchronous Firestore trigger.
        driver: assignedDriverCard(currentProfile, caller.uid, now),
        customerContact: customerUid
          ? assignedCustomerContact(customerProfile?.data() ?? {}, customerUser?.data() ?? {}, customerUid)
          : null,
        status: 'assigned' as BookingStatus,
        stateVersion: Number(currentBooking.stateVersion ?? 0) + 1,
        updatedAtMs: serverTimestamp(),
      });
      transaction.update(profileRef, {
        availabilityState: 'on_assignment',
        availabilitySinceMs: null,
        updatedAtMs: serverTimestamp(),
      });
      return { booking: currentBooking, profile: currentProfile };
    });

    // Closing this booking must not depend on a collection-group index for the
    // driver's unrelated offers. The booking/profile transaction above is the
    // authoritative first-accept-wins gate; revoke other cards afterwards as
    // best-effort cleanup. If the cleanup query is unavailable, the driver is
    // still assigned and the other cards cannot be accepted while on duty.
    try {
      const otherDriverOffers = await db()
        .collectionGroup(SUBCOLLECTIONS.driverAssignments)
        .where('driverUid', '==', caller.uid)
        .where('status', '==', 'offered')
        .limit(100)
        .get();
      const batch = db().batch();
      let revokedCount = 0;
      for (const otherOffer of otherDriverOffers.docs) {
        if (otherOffer.ref.path === assignmentRef.path) continue;
        batch.update(otherOffer.ref, {
          status: 'revoked',
          respondedAtMs: now,
          updatedAtMs: serverTimestamp(),
          revokeReason: 'driver_accepted_another_booking',
        });
        revokedCount += 1;
      }
      if (revokedCount > 0) await batch.commit();
    } catch (error) {
      log({
        fn: 'respondToAssignment',
        outcome: 'accepted_offer_cleanup_failed',
        actorUid: caller.uid,
        bookingId: input.bookingId,
        message: error instanceof Error ? error.message : 'Unknown cleanup error',
      });
    }

    const acceptedBooking: Record<string, unknown> & { id: string } = {
      ...booking,
      ...accepted.booking,
      id: input.bookingId,
      assignedDriverUid: caller.uid,
    };
    const acceptedProfile = accepted.profile;
    const zoneId = typeof acceptedProfile.zoneId === 'string' ? acceptedProfile.zoneId : null;
    const customerUid = typeof acceptedBooking.customerUid === 'string' ? acceptedBooking.customerUid : '';
    const tracking = {
      bookingId: input.bookingId,
      driverUid: caller.uid,
      customerUid,
      trackingEnabled: true,
      sharedWith: {
        [caller.uid]: true,
        ...(customerUid ? { [customerUid]: true } : {}),
      },
      startedAtMs: now,
    };
    await Promise.all([
      rtdb().ref(`authz/${input.bookingId}`).set(tracking),
      rtdb().ref(`activeBookings/${input.bookingId}`).set({
        bookingId: input.bookingId,
        driverUid: caller.uid,
        customerUid: tracking.customerUid,
        status: 'assigned',
        location: null,
        etaMinutes: null,
        etaCalculatedAtMs: null,
        routeGeometryRef: typeof acceptedBooking.routeGeometryRef === 'string' ? acceptedBooking.routeGeometryRef : null,
        updatedAtMs: now,
        expiresAtMs: now + RTDB_RETENTION.activeBookingTtlMs,
      }),
      rtdb().ref(RTDB_PATHS.presence(caller.uid)).update({
        state: 'on_assignment',
        updatedAtMs: now,
      }),
      ...(zoneId ? [rtdb().ref(RTDB_PATHS.dispatchGrid(zoneId, caller.uid)).remove()] : []),
      writeEvent({
        bookingId: input.bookingId,
        type: 'driver_assigned',
        actorUid: caller.uid,
        fromStatus: status,
        toStatus: 'assigned',
        payload: { assignmentId, attempt: Number(offer.attempt ?? 1), via: 'offer_accepted' },
      }),
    ]);

    log({ fn: 'respondToAssignment', outcome: 'accepted', actorUid: caller.uid, bookingId: input.bookingId });
    return {
      bookingId: input.bookingId,
      decision: 'accept' as const,
      status: 'assigned',
      reference: typeof acceptedBooking.reference === 'string' ? acceptedBooking.reference : null,
    };
  }

  await db().runTransaction(async (transaction) => {
    const liveOffer = await transaction.get(assignmentRef);
    if (!liveOffer.exists || liveOffer.data()?.status !== 'offered') {
      throw failedPrecondition('Another action already closed this offer. Refresh Duty for the latest trips.');
    }
    transaction.update(assignmentRef, {
      status: 'declined',
      respondedAtMs: now,
      declineReason: input.reason ?? null,
      updatedAtMs: serverTimestamp(),
    });
  });
  await writeEvent({
    bookingId: input.bookingId,
    type: 'driver_declined',
    actorUid: caller.uid,
    fromStatus: status,
    toStatus: status,
    payload: { assignmentId, reason: input.reason ?? null },
  });

  // Hand it straight to the next driver in the waiting order. Whether anybody else
  // is left is the office's problem, not a reason to leave the customer staring
  // at a trip nobody was asked for.
  const reoffer = await offerTrip(input.bookingId);

  log({
    fn: 'respondToAssignment',
    outcome: 'declined',
    actorUid: caller.uid,
    bookingId: input.bookingId,
    reoffered: reoffer.offered !== null,
  });
  return {
    bookingId: input.bookingId,
    decision: 'decline' as const,
    status,
    reoffered: reoffer.offered !== null,
  };
}

const locationFields = {
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyMeters: z.number().min(0).max(100),
  fixTimeMs: z.number().int().positive(),
  headingDegrees: z.number().min(0).max(360).nullish(),
  speedMps: z.number().min(0).max(200).nullish(),
};

const availabilityInput = z.discriminatedUnion('state', [
  z.object({ state: z.literal('online'), ...locationFields }),
  z.object({ state: z.enum(['offline', 'break']) }),
]);

function assertFreshLocation(fixTimeMs: number): void {
  const ageMs = Date.now() - fixTimeMs;
  if (ageMs < -10_000 || ageMs > 30_000) {
    throw failedPrecondition('Location is stale. Refresh your GPS fix and try again.');
  }
}

function dispatchCell(lat: number, lng: number): string {
  // A coarse cell label; exact coordinates stay server-readable only.
  return `${Math.round(lat * 100)}:${Math.round(lng * 100)}`;
}

function assignedDriverCard(profile: Record<string, unknown>, uid: string, publishedAtMs: number): AssignedDriverCard {
  const value = (key: string): string | null => {
    const field = profile[key];
    return typeof field === 'string' && field.trim() ? field.trim() : null;
  };
  const count = (key: string): number => {
    const field = profile[key];
    return typeof field === 'number' && Number.isFinite(field) ? field : 0;
  };
  return {
    uid,
    driverId: value('driverId'),
    fullName: value('fullName') ?? 'DrivX driver',
    phoneE164: value('phoneE164') ?? '',
    photoPath: value('photoUrl'),
    ratingAverage: count('ratingAverage'),
    ratingCount: count('ratingCount'),
    lifetimeTrips: count('lifetimeTrips'),
    onTimeArrivalRate: typeof profile.onTimeArrivalRate === 'number' ? profile.onTimeArrivalRate : null,
    onTimeArrivalCount: count('onTimeArrivalCount'),
    lateArrivalCount: count('lateArrivalCount'),
    languages: Array.isArray(profile.languages)
      ? profile.languages.filter((language): language is string => typeof language === 'string')
      : [],
    vehicle: {
      make: value('vehicleMake'),
      model: value('vehicleModel'),
      plate: value('vehiclePlate'),
    },
    publishedAtMs,
  };
}

function assignedCustomerContact(
  profile: Record<string, unknown>,
  user: Record<string, unknown>,
  uid: string,
): { uid: string; fullName: string; phoneE164: string } {
  const name = [profile.fullName, user.displayName].find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
  const phone = [profile.contactPhoneE164, user.phoneNumberE164].find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
  return {
    uid,
    fullName: name?.trim() ?? 'DrivX customer',
    phoneE164: phone?.trim() ?? '',
  };
}

/**
 * Driver: stand in the queue or step out of it.
 *
 * Going online is what puts a driver in front of dispatch, so it carries the same
 * three gates as accepting a trip: approved documents, the current duty terms, and
 * nothing unpaid. Stepping away never does — a driver who owes the office money
 * must always be able to stop taking work, and refusing that would hold a person
 * in a job they are trying to leave.
 *
 * The state lives on `driverProfiles/{uid}`; going online also requires a fresh
 * GPS fix and writes a private dispatch-grid location for radius matching.
 */
export async function setAvailabilityForCaller(caller: Caller, raw: unknown) {
  requireDriverCaller(caller);
  const input = parseInput(availabilityInput, raw);
  const profile = await readProfile(caller.uid);
  const zoneId = typeof profile.zoneId === 'string' ? profile.zoneId : null;

  if (input.state === 'online') {
    if (profile.accountStatus === 'suspended') {
      throw failedPrecondition('Your account is paused by DrivX support. Contact support before going online.');
    }
    assertFreshLocation(input.fixTimeMs);
    if (!caller.claims.driverVerified) {
      throw permissionDenied('Your documents must be approved before you can go online.');
    }
    const dutyTermsVersion = typeof profile.dutyTermsVersion === 'string' ? profile.dutyTermsVersion : null;
    if (!hasAcceptedDutyTerms({ dutyTermsVersion })) {
      throw failedPrecondition('Agree to the duty terms on the Duty screen before going online.');
    }
    const work = await workFactsFor(caller.uid);
    if (work.outstandingPaise > 0) {
      throw failedPrecondition(
        'You have commission outstanding, so new trips are held until the office records the payment.',
      );
    }
    if (work.carryingBooking) {
      throw failedPrecondition('You are already carrying a trip. Close it before going online again.');
    }
  }

  const now = Date.now();
  const writes: Promise<unknown>[] = [
    db().doc(`${COLLECTIONS.driverProfiles}/${caller.uid}`).update({
      availabilityState: input.state,
      // Only an online driver has a waiting time; the field is the queue order,
      // so it has to be empty for anybody who is not standing in it.
      availabilitySinceMs: input.state === 'online' ? now : null,
      updatedAtMs: serverTimestamp(),
    }),
  ];

  if (input.state === 'online') {
    const point = { lat: input.lat, lng: input.lng };
    if (zoneId) {
      writes.push(rtdb().ref(RTDB_PATHS.dispatchGrid(zoneId, caller.uid)).set({
        driverUid: caller.uid,
        cell: dispatchCell(input.lat, input.lng),
        ...point,
        accuracyMeters: input.accuracyMeters,
        updatedAtMs: now,
      }));
    }
    writes.push(rtdb().ref(RTDB_PATHS.presence(caller.uid)).set({
        driverUid: caller.uid,
        state: 'online',
        zoneId,
        location: point,
        updatedAtMs: now,
        clientId: null,
      }));
  } else {
    if (zoneId) writes.push(rtdb().ref(RTDB_PATHS.dispatchGrid(zoneId, caller.uid)).remove());
    writes.push(
      rtdb().ref(RTDB_PATHS.presence(caller.uid)).set({
        driverUid: caller.uid,
        state: input.state,
        zoneId,
        location: null,
        updatedAtMs: now,
        clientId: null,
      }),
    );
  }

  await Promise.all(writes);

  if (input.state === 'online') {
    const pending = await db()
      .collection(COLLECTIONS.bookings)
      .where('status', 'in', ['requested', 'searching_driver'])
      .limit(100)
      .get();
    for (const booking of pending.docs) {
      await offerTrip(booking.id);
    }
  }

  log({ fn: 'setAvailability', outcome: 'set', actorUid: caller.uid, state: input.state });
  return { state: input.state, sinceMs: input.state === 'online' ? now : null };
}

export const setAvailability = onCall(CALLABLE_OPTIONS, async (request) =>
  setAvailabilityForCaller(requireDriver(request), request.data),
);

const locationInput = z.object({
  bookingId: z.string().min(8).max(64).nullish(),
  ...locationFields,
});

/**
 * Server-side gate in front of the Realtime Database location node.
 *
 * With no booking id, the function refreshes an online driver's dispatch pin.
 * With a booking id, it verifies the active assignment and streams the fix to
 * the customer-visible tracking node. Stale or inaccurate fixes are refused.
 */
export async function publishDriverLocationForCaller(caller: Caller, raw: unknown) {
  requireVerifiedDriverCaller(caller);
  const input = parseInput(locationInput, raw);
  assertFreshLocation(input.fixTimeMs);
  const profile = await readProfile(caller.uid);
  const now = Date.now();
  const location = {
    bookingId: input.bookingId ?? null,
    lat: input.lat,
    lng: input.lng,
    accuracyMeters: input.accuracyMeters,
    headingDegrees: input.headingDegrees ?? null,
    speedMps: input.speedMps ?? null,
    fixTimeMs: input.fixTimeMs,
    receivedAtMs: now,
    degraded: false,
  };

  if (!input.bookingId) {
    if (profile.availabilityState !== 'online') {
      throw failedPrecondition('Go online before publishing a dispatch location.');
    }
    const zoneId = typeof profile.zoneId === 'string' ? profile.zoneId : null;
    const dispatchWrites: Promise<unknown>[] = [rtdb().ref(RTDB_PATHS.presence(caller.uid)).update({
      location: { lat: input.lat, lng: input.lng },
      updatedAtMs: now,
    })];
    if (zoneId) dispatchWrites.push(rtdb().ref(RTDB_PATHS.dispatchGrid(zoneId, caller.uid)).set({
        driverUid: caller.uid,
        cell: dispatchCell(input.lat, input.lng),
        lat: input.lat,
        lng: input.lng,
        accuracyMeters: input.accuracyMeters,
        updatedAtMs: now,
      }));
    await Promise.all(dispatchWrites);
    return { published: true, tracking: 'dispatch', receivedAtMs: now };
  }

  const booking = await readBooking(input.bookingId);
  if (booking.assignedDriverUid !== caller.uid) {
    throw permissionDenied('This booking is not assigned to your driver account.');
  }
  const trackable = new Set<BookingStatus>([
    'assigned',
    'driver_en_route',
    'driver_arrived',
    'trip_started',
    'in_progress',
    'destination_reached',
  ]);
  if (!trackable.has(booking.status as BookingStatus)) {
    throw failedPrecondition('Location sharing is only available while this trip is active.');
  }
  const activePath = `activeBookings/${input.bookingId}`;
  await Promise.all([
    rtdb().ref(RTDB_PATHS.driverLocation(caller.uid)).set(location),
    rtdb().ref(`${activePath}/location`).set(location),
    rtdb().ref(activePath).update({ updatedAtMs: now, status: booking.status }),
  ]);
  return { published: true, tracking: 'trip', receivedAtMs: now };
}

/** Customer shares their live position with the assigned driver only while the trip is running. */
export async function publishCustomerLocationForCaller(caller: Caller, raw: unknown) {
  const input = parseInput(locationInput.omit({ bookingId: true }).extend({ bookingId: z.string().min(8).max(64) }), raw);
  const booking = await readBooking(input.bookingId);
  if (booking.customerUid !== caller.uid || !booking.assignedDriverUid) {
    throw permissionDenied('This booking is not assigned to your customer account.');
  }
  if (!['trip_started', 'in_progress', 'destination_reached'].includes(String(booking.status))) {
    throw failedPrecondition('Customer location is shared only after the trip starts.');
  }
  assertFreshLocation(input.fixTimeMs);
  const now = Date.now();
  const location = {
    lat: input.lat,
    lng: input.lng,
    accuracyMeters: input.accuracyMeters,
    headingDegrees: input.headingDegrees ?? null,
    speedMps: input.speedMps ?? null,
    fixTimeMs: input.fixTimeMs,
    receivedAtMs: now,
    degraded: false,
  };
  await rtdb().ref(`activeBookings/${input.bookingId}/customerLocation`).set(location);
  return { published: true, tracking: 'trip', receivedAtMs: now };
}

export const publishDriverLocation = onCall(CALLABLE_OPTIONS, async (request) =>
  publishDriverLocationForCaller(requireVerifiedDriver(request), request.data),
);

/** Staff sends a guarded, auditable offer to one selected driver. */
export const manualAssign = onCall(CALLABLE_OPTIONS, async (request) => {
  const caller = requireAdmin(request);
  const input = parseInput(
    z.object({
      bookingId: z.string().min(8).max(64),
      driverUid: z.string().min(28).max(128),
      // The Admin console historically required a hand-typed note, which
      // made a visible eligible driver impossible to dispatch from a quick
      // assignment. Preserve an auditable reason without blocking the action.
      reason: z.string().trim().max(400)
        .transform((value) => value || 'Admin selected an eligible online driver for this booking.'),
    }),
    request.data,
  );
  const bookingRef = db().doc(bookingRefPath(input.bookingId));
  const profileRef = db().doc(`${COLLECTIONS.driverProfiles}/${input.driverUid}`);
  const [bookingSnap, profileSnap] = await Promise.all([bookingRef.get(), profileRef.get()]);
  if (!bookingSnap.exists) throw notFound('No booking with that id.');
  if (!profileSnap.exists) throw notFound('No driver profile with that id.');
  const booking = bookingSnap.data() ?? {};
  const profile = profileSnap.data() ?? {};
  if (booking.status !== 'requested' && booking.status !== 'searching_driver') {
    throw failedPrecondition('Only bookings waiting for a driver can be assigned.');
  }
  if (booking.assignedDriverUid != null) throw failedPrecondition('This booking already has a driver.');
  if (profile.accountStatus === 'suspended' || profile.verificationStatus !== 'approved' || profile.availabilityState !== 'online') {
    throw failedPrecondition('Choose an approved driver who is currently online.');
  }
  if (!hasAcceptedDutyTerms({ dutyTermsVersion: typeof profile.dutyTermsVersion === 'string' ? profile.dutyTermsVersion : null })) {
    throw failedPrecondition('This driver must accept the current duty terms before receiving work.');
  }
  const work = await workFactsFor(input.driverUid);
  if (work.carryingBooking) throw failedPrecondition('This driver is already carrying a trip.');
  if (work.outstandingPaise > 0) throw failedPrecondition('Clear this driver’s outstanding dues before assigning new work.');
  const assignmentId = assignmentIdFor(input.bookingId, input.driverUid);
  const assignmentRef = db().doc(assignmentPath(input.bookingId, assignmentId));
  const offersQuery = db().collection(`${bookingRefPath(input.bookingId)}/${SUBCOLLECTIONS.driverAssignments}`)
    .where('status', '==', 'offered').limit(10);
  const unpaidDuesQuery = db().collection(`${COLLECTIONS.driverProfiles}/${input.driverUid}/${SUBCOLLECTIONS.driverDues}`)
    .where('status', '==', 'unpaid').limit(10);
  const busyBookingsQuery = db().collection(COLLECTIONS.bookings)
    .where('assignedDriverUid', '==', input.driverUid).where('status', 'in', [...DRIVER_ON_DUTY_STATUSES]).limit(1);
  const [existingOffer, otherOffer] = await Promise.all([assignmentRef.get(), offersQuery.get()]);
  if (existingOffer.exists && existingOffer.data()?.status === 'offered') {
    const expiry = epochMs(existingOffer.data()?.expiresAtMs) ?? 0;
    if (expiry > Date.now()) return { offered: true, assignmentId, expiresAtMs: expiry };
  }
  const now = Date.now();
  const expiresAtMs = OFFER_NEVER_EXPIRES_AT_MS;
  await db().runTransaction(async (transaction) => {
    const [liveBooking, liveProfile, liveOffers, liveDues, liveBusyBookings] = await Promise.all([
      transaction.get(bookingRef), transaction.get(profileRef), transaction.get(offersQuery),
      transaction.get(unpaidDuesQuery), transaction.get(busyBookingsQuery),
    ]);
    if (!liveBooking.exists || !liveProfile.exists) throw notFound('The booking or driver profile no longer exists.');
    const currentBooking = liveBooking.data() ?? {};
    const currentProfile = liveProfile.data() ?? {};
    const customerUid = typeof currentBooking.customerUid === 'string' ? currentBooking.customerUid : null;
    const [customerProfile, customerUser] = customerUid
      ? await Promise.all([
          transaction.get(db().doc(`${COLLECTIONS.customerProfiles}/${customerUid}`)),
          transaction.get(db().doc(`${COLLECTIONS.users}/${customerUid}`)),
        ])
      : [null, null];
    if ((currentBooking.status !== 'requested' && currentBooking.status !== 'searching_driver') || currentBooking.assignedDriverUid != null) {
      throw failedPrecondition('This booking was changed by another dispatch action. Refresh and try again.');
    }
    if (currentProfile.accountStatus === 'suspended' || currentProfile.verificationStatus !== 'approved' || currentProfile.availabilityState !== 'online') {
      throw failedPrecondition('This driver is no longer approved and online. Refresh the driver list.');
    }
    if (!hasAcceptedDutyTerms({ dutyTermsVersion: typeof currentProfile.dutyTermsVersion === 'string' ? currentProfile.dutyTermsVersion : null })) {
      throw failedPrecondition('This driver must accept the current duty terms before receiving work.');
    }
    if (!liveDues.empty) throw failedPrecondition('This driver now has outstanding dues; clear them before assignment.');
    if (!liveBusyBookings.empty) throw failedPrecondition('This driver has started another trip.');
    // Admin dispatch is the recovery path when automatic matching has already
    // placed an offer that the driver cannot take. Revoke those offers in the
    // same transaction before creating the selected driver's new offer.
    for (const liveOffer of liveOffers.docs) {
      if (liveOffer.ref.path !== assignmentRef.path && (epochMs(liveOffer.data().expiresAtMs) ?? 0) > now) {
        transaction.update(liveOffer.ref, {
          status: 'revoked', respondedAtMs: now, updatedAtMs: serverTimestamp(),
          revokeReason: 'admin_manual_dispatch',
        });
      }
    }
    const priorStatus = currentBooking.status as BookingStatus;
    transaction.set(assignmentRef, {
      id: assignmentId, bookingId: input.bookingId, driverUid: input.driverUid,
      attempt: otherOffer.size + 1, status: 'offered', offeredAtMs: now, expiresAtMs,
      respondedAtMs: null, declineReason: null, distanceToPickupMeters: null,
      etaToPickupMinutes: null, strategy: 'manual_dispatch', assignedByUid: caller.uid,
      reason: input.reason, createdAtMs: serverTimestamp(), updatedAtMs: serverTimestamp(),
    });
    transaction.update(bookingRef, {
      customerContact: customerUid
        ? assignedCustomerContact(customerProfile?.data() ?? {}, customerUser?.data() ?? {}, customerUid)
        : null,
    });
    if (priorStatus === 'requested') transaction.update(bookingRef, {
      status: 'searching_driver', stateVersion: Number(currentBooking.stateVersion ?? 0) + 1, updatedAtMs: serverTimestamp(),
    });
    const eventId = `ev-manual-offer-${assignmentId}`;
    transaction.set(db().doc(`${bookingRefPath(input.bookingId)}/events/${eventId}`), {
      id: eventId, bookingId: input.bookingId, type: 'driver_offered', atMs: serverTimestamp(),
      actor: { uid: caller.uid, role: 'admin' }, location: null, geofenceKind: null,
      fromStatus: priorStatus, toStatus: 'searching_driver',
      payload: { assignmentId, strategy: 'manual_dispatch', reason: input.reason, driverUid: input.driverUid },
    });
  });
  const pickup = (booking.pickup as { label?: string } | null)?.label ?? 'your pickup';
  const destination = (booking.destination as { label?: string } | null)?.label ?? 'the drop';
  const customerNotes = (booking.customerPreferences as { notes?: unknown } | null)?.notes;
  await deliverInbox({
    uid: input.driverUid, id: `offer_${assignmentId}`, type: 'assignment_offer',
    title: `Trip ${String(booking.reference ?? input.bookingId)} is ready for you`,
    body: `${pickup} to ${destination}. This offer stays open until a driver accepts or declines it.`,
    route: '/', bookingId: input.bookingId,
    data: {
      assignmentId, bookingReference: String(booking.reference ?? input.bookingId), pickup, destination,
      expiresAtMs: String(expiresAtMs),
      ...(typeof customerNotes === 'string' && customerNotes.trim() ? { customerNotes: customerNotes.trim() } : {}),
    },
  });
  log({ fn: 'manualAssign', outcome: 'offered', actorUid: caller.uid, driverUid: input.driverUid, bookingId: input.bookingId, expiresAtMs });
  return { offered: true, assignmentId, expiresAtMs };
});
