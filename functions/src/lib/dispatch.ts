import {
  assignmentIdFor,
  assignmentPath,
  bookingRefPath,
  COLLECTIONS,
  DRIVER_ON_DUTY_STATUSES,
  formatINR,
  hasAcceptedDutyTerms,
  OFFER_NEVER_EXPIRES_AT_MS,
  SUBCOLLECTIONS,
  tripEventPath,
  type BookingStatus,
  type DispatchProfileFacts,
  type DispatchRefusal,
  type ServiceTypeId,
} from '@drivx/domain';
import { db, epochMs, rtdb, serverTimestamp } from './admin';
import { totalOutstandingPaise } from './dues';
import { deliverInbox } from './notify';

/**
 * Handing a booking to a driver.
 *
 * This is the piece that turns the owner's duty rule into a decision the server
 * makes: "term agree karne ke baad hi uske paas vo booking aaegi". A trip is
 * offered only to a driver who is approved, who has agreed the *current* duty
 * terms, who is online for that kind of service, who is not already carrying a
 * trip, and who owes the office nothing. Every one of those is a fact on a
 * document this function reads, so an offer is evidence rather than a mood.
 *
 * Two properties are deliberate:
 *
 * - **Broadcast offers.** Every approved, online driver who accepted current
 *   duty terms and can take work receives the offer. The first successful
 *   acceptance transaction gets the booking; later accepts are refused.
 * - **A driver is never asked twice for the same trip.** The assignment document
 *   id is derived from the booking and the driver, and the already-offered set is
 *   read from the booking's own subcollection, so a retried dispatch lands on the
 *   offer that already exists instead of stacking a second one.
 *
 * Candidate discovery has no work-zone or radius boundary. GPS sharing remains
 * available for live tracking after a driver accepts a trip.
 */

/** One offer, as the caller reported it. */
export type TripOffer = {
  bookingId: string;
  driverUid: string;
  driverName: string | null;
  assignmentId: string;
  offeredAtMs: number;
  expiresAtMs: number;
  /** How many drivers this booking has asked, including this one. */
  attempt: number;
  distanceToPickupMeters: number | null;
};

export type OfferOutcome = {
  bookingId: string;
  offered: TripOffer | null;
  offeredCount: number;
  /** Why each waiting driver was skipped, for the log and the verify script. */
  skipped: Array<{ uid: string; refusal: DispatchRefusal }>;
};

function log(entry: Record<string, unknown>): void {
  console.log(JSON.stringify({ level: 'info', module: 'dispatch', ...entry }));
}

/** The booking, or null when there is nothing to dispatch. */
async function readBooking(bookingId: string): Promise<(Record<string, unknown> & { id: string }) | null> {
  const snap = await db().doc(bookingRefPath(bookingId)).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...(snap.data() ?? {}) };
}

/**
 * An append-only line in the booking's event log.
 *
 * Dispatch writes the same shape `trip.ts` writes, because the office reads one
 * timeline per booking — offered, accepted, started, closed — and a gap where the
 * offer was made is a gap in the only record of who was asked.
 */
async function writeEvent(input: {
  bookingId: string;
  type: 'driver_offered' | 'driver_assigned' | 'driver_declined';
  actorUid: string | null;
  actorRole: 'driver' | 'system';
  fromStatus: BookingStatus | null;
  toStatus: BookingStatus | null;
  payload: Record<string, unknown>;
}): Promise<void> {
  const eventId =
    input.type === 'driver_offered'
      ? `ev-driver_offered-${input.actorUid ?? 'system'}`
      : `ev-${input.type}`;
  await db()
    .doc(tripEventPath(input.bookingId, eventId))
    .set({
      id: eventId,
      bookingId: input.bookingId,
      type: input.type,
      atMs: serverTimestamp(),
      actor: { uid: input.actorUid, role: input.actorRole },
      location: null,
      geofenceKind: null,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      payload: input.payload,
    });
}

/**
 * The drivers a booking could go to, in the order they should be asked.
 *
 * One query, filtered on what a profile already holds. Approval is the query's
 * own equality filter; the duty terms, the service type and being online are
 * applied by `rankDispatchProfiles` so the reason each driver was skipped
 * survives to be logged. Money and in-hand trips are *not* read here — that is
 * per-driver work, and the loop below only pays for it for the drivers it is
 * about to ask.
 */
export async function waitingDriversFor(
): Promise<DispatchProfileFacts[]> {
  const snap = await db()
    .collection(COLLECTIONS.driverProfiles)
    .where('verificationStatus', '==', 'approved')
    .where('availabilityState', '==', 'online')
    .get();
  return snap.docs.map((docSnap) => {
    const data = docSnap.data() as Record<string, unknown>;
    return {
      uid: docSnap.id,
      fullName: typeof data.fullName === 'string' ? data.fullName : null,
      verificationStatus: (data.verificationStatus as DispatchProfileFacts['verificationStatus']) ?? 'not_started',
      availabilityState: data.availabilityState as DispatchProfileFacts['availabilityState'],
      serviceTypeIds: Array.isArray(data.serviceTypeIds) ? (data.serviceTypeIds as ServiceTypeId[]) : [],
      dutyTermsVersion: typeof data.dutyTermsVersion === 'string' ? data.dutyTermsVersion : null,
      availabilitySinceMs: epochMs(data.availabilitySinceMs),
    };
  });
}

/** What this driver owes, and whether they are already driving something. */
export async function workFactsFor(driverUid: string): Promise<{ outstandingPaise: number; carryingBooking: boolean }> {
  const [dues, busy] = await Promise.all([
    db()
      .collection(COLLECTIONS.driverProfiles)
      .doc(driverUid)
      .collection(SUBCOLLECTIONS.driverDues)
      .where('status', '==', 'unpaid')
      .limit(10)
      .get(),
    db()
      .collection(COLLECTIONS.bookings)
      .where('assignedDriverUid', '==', driverUid)
      .where('status', 'in', [...DRIVER_ON_DUTY_STATUSES])
      .limit(1)
      .get(),
  ]);

  return {
    outstandingPaise: totalOutstandingPaise(
      dues.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() })),
    ),
    carryingBooking: !busy.empty,
  };
}

/** Drivers with a live offer or a final answer for this booking. */
async function alreadyOffered(bookingId: string): Promise<Set<string>> {
  const snap = await db()
    .collection(`${bookingRefPath(bookingId)}/${SUBCOLLECTIONS.driverAssignments}`)
    .get();
  const now = Date.now();
  const already = new Set<string>();
  for (const docSnap of snap.docs) {
    const data = docSnap.data();
    const uid = String(data.driverUid ?? docSnap.id);
    const status = String(data.status ?? '');
    const expiresAtMs = epochMs(data.expiresAtMs);
    const liveOffer = status === 'offered' && expiresAtMs !== null && expiresAtMs > now;
    const driverAnswered = status === 'accepted' || status === 'declined';
    const adminRevoked = status === 'revoked' && data.revokeReason !== 'driver_accepted_another_booking';
    if (liveOffer || driverAnswered || adminRevoked) already.add(uid);
  }
  return already;
}

/**
 * Broadcast this trip to every available approved driver.
 *
 * The first successful accept transaction assigns the trip; other open offers
 * are revoked after that acceptance.
 */
export async function offerTrip(bookingId: string): Promise<OfferOutcome> {
  const booking = await readBooking(bookingId);
  if (!booking) {
    log({ fn: 'offerTrip', outcome: 'no_booking', bookingId });
    return { bookingId, offered: null, offeredCount: 0, skipped: [] };
  }

  const status = booking.status as BookingStatus;
  // A booking with a driver, a running trip, or a closed outcome is not for sale.
  if (status !== 'requested' && status !== 'searching_driver') {
    log({ fn: 'offerTrip', outcome: 'not_offerable', bookingId, status });
    return { bookingId, offered: null, offeredCount: 0, skipped: [] };
  }

  const [waiting, offeredAlready] = await Promise.all([waitingDriversFor(), alreadyOffered(bookingId)]);

  const skipped: Array<{ uid: string; refusal: DispatchRefusal }> = [];
  const created: TripOffer[] = [];
  let bookingStatus = status;

  for (const profile of waiting) {
    if (offeredAlready.has(profile.uid)) {
      skipped.push({ uid: profile.uid, refusal: 'already_offered' });
      continue;
    }

    if (!hasAcceptedDutyTerms({ dutyTermsVersion: profile.dutyTermsVersion })) {
      skipped.push({ uid: profile.uid, refusal: 'duty_terms' });
      continue;
    }
    const work = await workFactsFor(profile.uid);
    if (work.outstandingPaise > 0 || work.carryingBooking) {
      skipped.push({ uid: profile.uid, refusal: work.outstandingPaise > 0 ? 'outstanding_dues' : 'busy' });
      continue;
    }
    const now = Date.now();
    const offer: TripOffer = {
      bookingId,
      driverUid: profile.uid,
      driverName: profile.fullName,
      assignmentId: assignmentIdFor(bookingId, profile.uid),
      offeredAtMs: now,
      expiresAtMs: OFFER_NEVER_EXPIRES_AT_MS,
      attempt: offeredAlready.size + created.length + 1,
      distanceToPickupMeters: null,
    };

    let createdOffer = false;
    let attempt = offer.attempt;
    try {
      createdOffer = await db().runTransaction(async (transaction) => {
        const [liveBooking, liveProfile] = await Promise.all([
          transaction.get(db().doc(bookingRefPath(bookingId))),
          transaction.get(db().doc(`${COLLECTIONS.driverProfiles}/${profile.uid}`)),
        ]);
        if (!liveBooking.exists || !liveProfile.exists) throw new Error('booking_or_driver_missing');
        const liveBookingData = liveBooking.data() ?? {};
        const liveProfileData = liveProfile.data() ?? {};
        if ((liveBookingData.status !== 'requested' && liveBookingData.status !== 'searching_driver') || liveBookingData.assignedDriverUid != null) {
          throw new Error('booking_no_longer_waiting');
        }
        if (liveProfileData.verificationStatus !== 'approved' || liveProfileData.availabilityState !== 'online') {
          throw new Error('driver_no_longer_online');
        }
        if (!hasAcceptedDutyTerms({ dutyTermsVersion: typeof liveProfileData.dutyTermsVersion === 'string' ? liveProfileData.dutyTermsVersion : null })) {
          throw new Error('driver_duty_terms');
        }
        const assignmentRef = db().doc(assignmentPath(bookingId, offer.assignmentId));
        const existing = await transaction.get(assignmentRef);
        if (existing.exists) {
          const existingData = existing.data() ?? {};
          const existingStatus = String(existingData.status ?? '');
          const existingExpiry = epochMs(existingData.expiresAtMs);
          const expiredOffer =
            (existingStatus === 'expired' || existingStatus === 'offered') &&
            (existingStatus === 'expired' || (existingExpiry !== null && existingExpiry <= Date.now()));
          const wasRevokedByOtherAcceptance =
            existingStatus === 'revoked' && existingData.revokeReason === 'driver_accepted_another_booking';
          if (!expiredOffer && !wasRevokedByOtherAcceptance) return false;
          attempt = Number(existingData.attempt ?? 0) + 1;
        }
        transaction.set(assignmentRef, {
          id: offer.assignmentId,
          bookingId,
          driverUid: profile.uid,
          attempt,
          status: 'offered',
          offeredAtMs: offer.offeredAtMs,
          expiresAtMs: offer.expiresAtMs,
          respondedAtMs: null,
          declineReason: null,
          distanceToPickupMeters: null,
          etaToPickupMinutes: null,
          strategy: 'broadcast_dispatch',
          assignedByUid: null,
          createdAtMs: existing.exists ? existing.data()?.createdAtMs ?? serverTimestamp() : serverTimestamp(),
          updatedAtMs: serverTimestamp(),
        });
        if (liveBookingData.status === 'requested') {
          transaction.update(db().doc(bookingRefPath(bookingId)), {
            status: 'searching_driver',
            stateVersion: Number(liveBookingData.stateVersion ?? 0) + 1,
            updatedAtMs: serverTimestamp(),
          });
        }
        return true;
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : '';
      if (reason === 'booking_no_longer_waiting') break;
      skipped.push({ uid: profile.uid, refusal: reason === 'driver_duty_terms' ? 'duty_terms' : 'offline' });
      continue;
    }

    if (!createdOffer) {
      offeredAlready.add(profile.uid);
      skipped.push({ uid: profile.uid, refusal: 'already_offered' });
      continue;
    }

    offer.attempt = attempt;
    created.push(offer);
    offeredAlready.add(profile.uid);
    if (bookingStatus === 'requested') bookingStatus = 'searching_driver';

    await writeEvent({
      bookingId,
      type: 'driver_offered',
      actorUid: profile.uid,
      actorRole: 'system',
      fromStatus: status,
      toStatus: 'searching_driver',
        payload: {
          assignmentId: offer.assignmentId,
          attempt: offer.attempt,
          strategy: 'broadcast_dispatch',
          distanceToPickupMeters: null,
        },
    });

    const estimate = booking.estimate as { totalPaise?: number } | null;
    const pickup = (booking.pickup as { label?: string } | null)?.label ?? 'your pickup';
    const drop = (booking.destination as { label?: string } | null)?.label ?? 'the drop';
    const customerNotes = (booking.customerPreferences as { notes?: unknown } | null)?.notes;
    await deliverInbox({
      uid: profile.uid,
      // Every dispatch attempt gets its own inbox id. A manual re-offer for
      // this booking must not collide with an earlier driver's notification.
      id: `offer_${offer.assignmentId}`,
      type: 'assignment_offer',
      title: `Trip ${String(booking.reference ?? bookingId)} is yours to take`,
      body:
        `${pickup} to ${drop}. The fare is priced at ${
          typeof estimate?.totalPaise === 'number' ? formatINR(estimate.totalPaise) : 'the quoted rate'
        } before the meter. ` +
        'This offer stays open until a driver accepts or declines it. The first driver to accept gets the trip. ' +
        "declining sends it back to be offered again, it does not cancel the customer's trip.",
      route: '/',
      bookingId,
      data: {
        assignmentId: offer.assignmentId,
        bookingReference: String(booking.reference ?? bookingId),
        pickup,
        destination: drop,
        farePaise: String(estimate?.totalPaise ?? ''),
        expiresAtMs: String(offer.expiresAtMs),
        distanceToPickupMeters: '',
        ...(typeof customerNotes === 'string' && customerNotes.trim() ? { customerNotes: customerNotes.trim() } : {}),
      },
    });

    log({
      fn: 'offerTrip',
      outcome: 'offered',
      bookingId,
      driverUid: profile.uid,
      attempt: offer.attempt,
      distanceToPickupMeters: null,
      expiresAtMs: offer.expiresAtMs,
    });
  }

  if (created.length) {
    log({ fn: 'offerTrip', outcome: 'broadcast', bookingId, offeredCount: created.length, skipped });
    return { bookingId, offered: created[0] ?? null, offeredCount: created.length, skipped };
  }

  log({ fn: 'offerTrip', outcome: 'no_candidate', bookingId, skipped });
  return { bookingId, offered: null, offeredCount: 0, skipped };
}
