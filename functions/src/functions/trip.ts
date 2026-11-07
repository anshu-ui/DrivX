import { onCall } from 'firebase-functions/v2/https';
import { z } from 'zod';
import {
  bookingRefPath,
  canTransition,
  COLLECTIONS,
  tripEventPath,
  type AssignedDriverCard,
  type BookingStatus,
  type FareBreakdown,
  type TripEventType,
} from '@drivx/domain';
import { authAdmin, db, epochMs, rtdb, serverTimestamp } from '../lib/admin';
import { CALLABLE_OPTIONS } from '../lib/config';
import { failedPrecondition, notFound, notImplemented, parseInput, permissionDenied } from '../lib/errors';
import { requireCustomer, requireDriver } from '../lib/guards';
import { deliverInbox } from '../lib/notify';
import { consumeTripOtp, ensureTripOtp, type TripOtpPurpose } from '../lib/otp';
import { asRule, meteredTrip } from '../lib/pricing';
import { billableCompletion, configuredCommissionTerms } from '../lib/dues';

/**
 * The trip itself, from the code at pickup to the bill at the drop.
 *
 * Four calls, in the order a driver and a customer actually use them:
 *
 * 1. `tripCodes` — the customer's app reads the two codes minted once for this
 *    booking. There is no call that produces a new one.
 * 2. `verifyTripOtp` — the driver types the start code and the opening odometer
 *    reading, and the trip begins.
 * 3. `recordOdometer` — the driver posts the reading as it runs, so the fare the
 *    customer watches climbing is the fare they will be billed.
 * 4. `confirmCompletion` — the driver types the end code and the closing reading,
 *    and the bill is priced off what the car actually ran.
 *
 * Three rules run through all four, and they are the reason this file is
 * server-side:
 *
 * - **A code proves a person was there.** The digits go to the customer only; a
 *   driver who could read them would not need the customer at all.
 * - **The dial, not the map, sets the price.** The quote is what the route was
 *   expected to cost. `finalFare` is what the trip cost, from the two readings,
 *   through the same engine and the same rule.
 * - **Nobody writes their own status.** Every one of these calls refuses a caller
 *   who is not the assigned driver or the booking's own customer, and each write
 *   is checked against the state table in `@drivx/domain`.
 */

const bookingRef = z.object({ bookingId: z.string().min(8).max(64) });

/** A dial reading: whole kilometres, and no car has ever had two million. */
const odometerSchema = z.number().int().min(0).max(2_000_000);
const codeSchema = z.string().regex(/^\d{4,6}$/, 'Enter the digits the customer read you.');

const verifyOtpRef = bookingRef.extend({
  code: codeSchema,
  odometerKm: odometerSchema,
});

const recordMeterRef = bookingRef.extend({
  odometerKm: odometerSchema,
});

const completeRef = bookingRef.extend({
  code: codeSchema,
  odometerKm: odometerSchema,
});

/** The statuses a start code is handed out in, and an end code in. */
const STARTABLE: BookingStatus[] = ['assigned', 'driver_en_route', 'driver_arrived'];
const RUNNING: BookingStatus[] = ['trip_started', 'in_progress', 'destination_reached'];

function log(entry: Record<string, unknown>): void {
  console.log(JSON.stringify({ level: 'info', module: 'trip', ...entry }));
}

/** The booking, as the server wrote it, with its id attached. */
async function readBooking(bookingId: string): Promise<Record<string, unknown> & { id: string }> {
  const snap = await db().doc(bookingRefPath(bookingId)).get();
  if (!snap.exists) throw notFound('No booking with that id.');
  return { id: snap.id, ...(snap.data() ?? {}) };
}

/**
 * An append-only line in the booking's own event log.
 *
 * Codes are recorded as *that* one was verified or refused, never as the digits,
 * so a support agent can read what happened at the car without the log becoming
 * a list of live codes.
 */
async function writeEvent(input: {
  bookingId: string;
  type: TripEventType;
  actorUid: string;
  actorRole: 'customer' | 'driver' | 'system';
  fromStatus: BookingStatus | null;
  toStatus: BookingStatus | null;
  payload: Record<string, unknown>;
  /** Repeatable events (a failed guess, a meter posting) need a distinct id. */
  unique?: boolean;
}): Promise<void> {
  const eventId = `ev-${input.type}${input.unique ? `-${Date.now()}` : ''}`;
  await db().doc(tripEventPath(input.bookingId, eventId)).set({
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
 * The customer's inbox message carrying the same digits their screen shows.
 *
 * One row per booking, written the first time the codes are minted: the id is
 * `codes_{bookingId}` and the write is a create, so a retried call cannot stack
 * a second copy of the same message in front of the customer. The digits are in
 * the body because that is what a support agent reads back, and because the
 * inbox is the customer's own document — nobody else's rule lets them list it.
 */
async function notifyCodes(input: {
  uid: string;
  bookingId: string;
  reference: string | null;
  start: string;
  end: string;
}): Promise<void> {
  const trip = input.reference ?? input.bookingId;
  await deliverInbox({
    uid: input.uid,
    id: `codes_${input.bookingId}`,
    type: 'trip_codes',
    title: `Your codes for trip ${trip}`,
    body:
      `Start code ${input.start} — read it to the driver at the car, with the opening odometer reading. ` +
      `End code ${input.end} — read it at the drop, when the trip is being closed. ` +
      'Neither code expires, and each one works once.',
    route: `/trips/${input.bookingId}`,
    bookingId: input.bookingId,
  });
}

/** The caller must be the driver this booking was handed to. */
function assertAssignedDriver(booking: Record<string, unknown>, uid: string): void {
  if (booking.assignedDriverUid !== uid) {
    throw permissionDenied('This booking is not assigned to you, so you cannot drive it.');
  }
}

/** The estimate the customer confirmed, which is what the metered bill is priced against. */
function readQuote(booking: Record<string, unknown>): FareBreakdown {
  const estimate = booking.estimate;
  if (typeof estimate !== 'object' || estimate === null) {
    throw failedPrecondition('This booking has no priced estimate on it, so there is no fare to meter against.');
  }
  return estimate as FareBreakdown;
}

/**
 * The distance the booking was quoted on, as `createBooking` stored it.
 *
 * It decides which chart row a metered bill is priced at: running long adds
 * kilometres at the per-kilometre rate instead of moving the trip onto a higher
 * row than the price the customer confirmed. Null only for a record written
 * before the field existed.
 */
function quotedDistance(booking: Record<string, unknown>): number | null {
  const metres = booking.estimatedDistanceMeters;
  return typeof metres === 'number' && metres > 0 ? metres : null;
}

/**
 * The rule the booking was quoted on, read back by its stored id.
 *
 * The quote keeps `pricingRuleId` precisely so a completion cannot be priced on
 * whatever rule the office happens to have active that afternoon.
 */
async function ruleForQuote(booking: Record<string, unknown>, quote: FareBreakdown) {
  if (typeof quote.pricingRuleId !== 'string' || quote.pricingRuleId.length === 0) {
    throw failedPrecondition('The quote on this booking does not say which rule priced it.');
  }
  const storedRule = booking.pricingRuleSnapshot;
  if (typeof storedRule === 'object' && storedRule !== null) {
    const snapshot = storedRule as Record<string, unknown>;
    if (snapshot.id === quote.pricingRuleId) return asRule(quote.pricingRuleId, snapshot);
  }
  // Legacy bookings predate full rule snapshots. Keep the previous fallback for
  // them; new bookings always carry the accepted rule above.
  const snap = await db().doc(`${COLLECTIONS.pricingRules}/${quote.pricingRuleId}`).get();
  if (!snap.exists) {
    throw failedPrecondition(`Pricing rule ${quote.pricingRuleId} is gone, so this trip cannot be metered against it.`);
  }
  return asRule(quote.pricingRuleId, snap.data() as Record<string, unknown>);
}

/**
 * Customer: the codes for this booking.
 *
 * Both digits, minted once by the system against the booking id, and the same
 * text lands in the customer's inbox. The owner's rule of 2026-10-27 removed
 * re-issue — "hum bar bar new code generate ni kar sakte" — so this call cannot
 * produce a second code for a stage that already has one: repeated reads return
 * the digits that were minted first, which is why the screen no longer has a
 * button and the app can lose its state and still show the same pair.
 *
 * Revealing the end code at pickup is the owner's instruction, not a
 * convenience: it means a driver who photographs the customer's screen holds the
 * digits that prove the customer was standing at the drop. The bill is still
 * metered from the closing dial reading, and a trip that never started refuses
 * the end code, so the exposure is an early close rather than a fake trip — but
 * it is a real weakening of the end code, and reversing it is a one-line change
 * back to stage-by-stage display if the office ever sees it abused.
 *
 * The message is written into `users/{uid}/notifications` and no further. SMS
 * and WhatsApp are not wired on this project — no sender is configured and the
 * India SMS region is still off — so nothing here pretends a text was sent.
 */
export const tripCodes = onCall(CALLABLE_OPTIONS, async (request) => {
  const caller = requireCustomer(request);
  return tripCodesForCustomer(caller.uid, request.data);
});

/** Assigned driver: get only the customer contact for the trip they carry. */
export const customerContactForAssignedDriver = onCall(CALLABLE_OPTIONS, async (request) => {
  const caller = requireDriver(request);
  return customerContactForAssignedDriverCaller(caller.uid, request.data);
});

export async function customerContactForAssignedDriverCaller(driverUid: string, raw: unknown) {
  const input = parseInput(bookingRef, raw);
  const booking = await readBooking(input.bookingId);
  if (booking.assignedDriverUid !== driverUid) {
    throw permissionDenied('This trip is not assigned to your driver account.');
  }
  const customerUid = typeof booking.customerUid === 'string' ? booking.customerUid : null;
  if (!customerUid) throw failedPrecondition('This booking has no customer account linked to it.');
  const [profile, user] = await Promise.all([
    db().doc(`${COLLECTIONS.customerProfiles}/${customerUid}`).get(),
    db().doc(`${COLLECTIONS.users}/${customerUid}`).get(),
  ]);
  let authUser: { displayName?: string | null; phoneNumber?: string | null } | null = null;
  try {
    authUser = await authAdmin().getUser(customerUid);
  } catch {
    // The Firestore profile remains the source of truth if Auth was deleted.
  }
  const profileData = profile.data() ?? {};
  const userData = user.data() ?? {};
  const firstText = (...values: unknown[]): string | null => {
    const value = values.find((candidate) => typeof candidate === 'string' && candidate.trim());
    return typeof value === 'string' ? value.trim() : null;
  };
  const contact = {
    uid: customerUid,
    fullName: firstText(profileData.fullName, userData.displayName, authUser?.displayName) ?? 'DrivX customer',
    phoneE164: firstText(profileData.contactPhoneE164, userData.phoneNumberE164, authUser?.phoneNumber) ?? '',
  };
  await db().doc(bookingRefPath(input.bookingId)).set({ customerContact: contact }, { merge: true });
  return contact;
}

/** Shared customer-authorized implementation for callable and Hosting gateway. */
export async function tripCodesForCustomer(callerUid: string, raw: unknown) {
  const input = parseInput(bookingRef, raw);
  const booking = await readBooking(input.bookingId);

  if (booking.customerUid !== callerUid) {
    throw permissionDenied('This booking is not yours.');
  }

  // Repair legacy assignments that were accepted before the driver card was
  // written atomically. The customer only receives the public card fields.
  const assignedUid = typeof booking.assignedDriverUid === 'string' ? booking.assignedDriverUid : null;
  const existingCard = booking.driver as { uid?: unknown } | undefined;
  const existingCustomerContact = booking.customerContact as { uid?: unknown } | undefined;
  const bookingPatch: Record<string, unknown> = {};
  if (assignedUid && existingCard?.uid !== assignedUid) {
    const profile = await db().doc(`${COLLECTIONS.driverProfiles}/${assignedUid}`).get();
    if (profile.exists) {
      const values = profile.data() ?? {};
      const value = (key: string): string | null => {
        const field = values[key];
        return typeof field === 'string' && field.trim() ? field.trim() : null;
      };
      const count = (key: string): number => {
        const field = values[key];
        return typeof field === 'number' && Number.isFinite(field) ? field : 0;
      };
      const driver: AssignedDriverCard = {
        uid: assignedUid,
        driverId: value('driverId'),
        fullName: value('fullName') ?? 'DrivX driver',
        phoneE164: value('phoneE164') ?? '',
        photoPath: value('photoUrl'),
        ratingAverage: count('ratingAverage'),
        ratingCount: count('ratingCount'),
        lifetimeTrips: count('lifetimeTrips'),
        languages: Array.isArray(values.languages)
          ? values.languages.filter((language): language is string => typeof language === 'string')
          : [],
        vehicle: {
          make: value('vehicleMake'),
          model: value('vehicleModel'),
          plate: value('vehiclePlate'),
        },
        publishedAtMs: Date.now(),
      };
      bookingPatch.driver = driver;
    }
  }

  // Older accepted trips may predate the contact snapshot. Publish only the
  // customer's name and phone on the booking so the assigned driver can call;
  // never expose the customer's full profile or identity documents.
  const customerUid = typeof booking.customerUid === 'string' ? booking.customerUid : null;
  const existingContact = booking.customerContact as { uid?: unknown; fullName?: unknown; phoneE164?: unknown } | undefined;
  if (
    assignedUid && customerUid &&
    (existingCustomerContact?.uid !== customerUid || !existingContact?.phoneE164 || !existingContact?.fullName)
  ) {
    const [profile, user] = await Promise.all([
      db().doc(`${COLLECTIONS.customerProfiles}/${customerUid}`).get(),
      db().doc(`${COLLECTIONS.users}/${customerUid}`).get(),
    ]);
    let authUser: { displayName?: string | null; phoneNumber?: string | null } | null = null;
    try {
      authUser = await authAdmin().getUser(customerUid);
    } catch {
      // Use available provisioned profile data if the Auth account no longer exists.
    }
    const profileData = profile.data() ?? {};
    const userData = user.data() ?? {};
    const firstText = (...values: unknown[]): string | null => {
      const value = values.find((candidate) => typeof candidate === 'string' && candidate.trim());
      return typeof value === 'string' ? value.trim() : null;
    };
    bookingPatch.customerContact = {
      uid: customerUid,
      fullName: firstText(profileData.fullName, userData.displayName, authUser?.displayName) ?? 'DrivX customer',
      phoneE164: firstText(profileData.contactPhoneE164, userData.phoneNumberE164, authUser?.phoneNumber) ?? '',
    };
  }
  if (Object.keys(bookingPatch).length > 0) {
    await db().doc(bookingRefPath(input.bookingId)).set(bookingPatch, { merge: true });
  }

  const status = booking.status as BookingStatus;
  if (!STARTABLE.includes(status) && !RUNNING.includes(status)) {
    throw failedPrecondition(
      status === 'completed' || status === 'cancelled'
        ? 'This trip is closed, so there is nothing left to open with a code.'
        : 'The codes appear once a driver is on the job.',
    );
  }

  const start = await ensureTripOtp({ bookingId: input.bookingId, purpose: 'trip_start', actorUid: callerUid });
  const end = await ensureTripOtp({ bookingId: input.bookingId, purpose: 'trip_end', actorUid: callerUid });

  const reference = typeof booking.reference === 'string' ? booking.reference : null;

  for (const issued of [
    { purpose: 'trip_start' as TripOtpPurpose, ...start },
    { purpose: 'trip_end' as TripOtpPurpose, ...end },
  ]) {
    if (!issued.minted) continue;
    await writeEvent({
      bookingId: input.bookingId,
      type: 'otp_sent',
      actorUid: callerUid,
      actorRole: 'customer',
      fromStatus: status,
      toStatus: status,
      payload: { purpose: issued.purpose, mintedOnce: true },
      unique: true,
    });
  }

  if (start.minted) {
    await notifyCodes({
      uid: callerUid,
      bookingId: input.bookingId,
      reference,
      start: start.code,
      end: end.code,
    });
  }

  log({
    fn: 'tripCodes',
    outcome: 'returned',
    actorUid: callerUid,
    bookingId: input.bookingId,
    mintedNow: start.minted || end.minted,
  });
  return {
    bookingId: input.bookingId,
    reference,
    start: start.code,
    end: end.code,
  };
}

/**
 * Driver: the start code and the opening reading.
 *
 * The reading is taken here rather than at booking time because it is the
 * customer's protection: the trip is metered from the dial the driver reports
 * standing at the car, and the code is what proves they were.
 *
 * A driver who has not confirmed arrival by geofence is not blocked — entering
 * the customer's code *is* the arrival proof we trust — but the log records the
 * arrival as manually confirmed, so the office can see which trips never had a
 * settled GPS fix.
 */
export const verifyTripOtp = onCall(CALLABLE_OPTIONS, async (request) => {
  const caller = requireDriver(request);
  const input = parseInput(verifyOtpRef, request.data);
  const booking = await readBooking(input.bookingId);
  assertAssignedDriver(booking, caller.uid);

  const status = booking.status as BookingStatus;
  if (status === 'trip_started' || status === 'in_progress') {
    throw failedPrecondition('This trip is already running. Post the meter reading instead.');
  }
  if (!STARTABLE.includes(status)) {
    throw failedPrecondition(`A trip cannot be started from "${status}".`);
  }

  await consumeTripOtp({ bookingId: input.bookingId, purpose: 'trip_start', code: input.code, actorUid: caller.uid });

  const arrived = status === 'driver_arrived';
  const now = Date.now();
  const scheduledForMs = epochMs(booking.scheduledForMs);
  const policySnap = await db().doc(`${COLLECTIONS.appConfig}/driverPerformance`).get();
  const policy = policySnap.data() ?? {};
  const graceMinutes = Number.isInteger(policy.arrivalGraceMinutes) && Number(policy.arrivalGraceMinutes) >= 0
    ? Math.min(180, Number(policy.arrivalGraceMinutes))
    : 10;
  // Prefer the recorded arrival event, so time spent at pickup after arriving
  // does not turn an on-time driver into a late one. If no arrival event exists,
  // the start-OTP verification itself is the arrival proof.
  const arrivalProofMs = arrived ? (epochMs(booking.arrivalConfirmedAtMs) ?? now) : now;
  const arrivalLateSeconds = scheduledForMs === null
    ? null
    : Math.max(0, Math.floor((arrivalProofMs - scheduledForMs - graceMinutes * 60_000) / 1000));
  const countedArrival = scheduledForMs !== null && booking.arrivalPerformanceCounted !== true;
  const onTime = arrivalLateSeconds !== null && arrivalLateSeconds === 0;
  const driverRef = db().doc(`driverProfiles/${caller.uid}`);
  const bookingRefDoc = db().doc(bookingRefPath(input.bookingId));
  await db().runTransaction(async (tx) => {
    const [freshBooking, freshDriver] = await Promise.all([tx.get(bookingRefDoc), tx.get(driverRef)]);
    if (!freshBooking.exists || freshBooking.get('assignedDriverUid') !== caller.uid) {
      throw permissionDenied('This booking is no longer assigned to your driver account.');
    }
    const freshStatus = String(freshBooking.get('status') ?? '');
    if (!STARTABLE.includes(freshStatus as BookingStatus)) {
      throw failedPrecondition(`A trip cannot be started from "${freshStatus}".`);
    }
    tx.update(bookingRefDoc, {
    status: 'trip_started',
    tripStartedAtMs: now,
    startOdometerKm: input.odometerKm,
    currentOdometerKm: input.odometerKm,
    arrivalConfirmedAtMs: arrived ? (booking.arrivalConfirmedAtMs ?? now) : now,
    arrivalConfirmedManually: arrived ? Boolean(booking.arrivalConfirmedManually) : true,
    arrivalLateSeconds,
    arrivalOnTime: arrivalLateSeconds === null ? null : onTime,
    arrivalPerformanceCounted: countedArrival,
    stateVersion: Number(booking.stateVersion ?? 0) + 1,
    updatedAtMs: serverTimestamp(),
    });
    if (countedArrival && freshDriver.exists) {
      const profile = freshDriver.data() ?? {};
      const onTimeCount = Number(profile.onTimeArrivalCount ?? 0) + (onTime ? 1 : 0);
      const lateCount = Number(profile.lateArrivalCount ?? 0) + (onTime ? 0 : 1);
      const total = onTimeCount + lateCount;
      tx.update(driverRef, {
        onTimeArrivalCount: onTimeCount,
        lateArrivalCount: lateCount,
        onTimeArrivalRate: total > 0 ? onTimeCount / total : null,
        updatedAtMs: serverTimestamp(),
      });
    }
  });

  // The customer's live map is only reachable while this node says tracking is
  // authorised on the booking — `database.rules.json` reads it on every write.
  await rtdb()
    .ref(`authz/${input.bookingId}`)
    .set({
      bookingId: input.bookingId,
      driverUid: caller.uid,
      customerUid: booking.customerUid ?? null,
      trackingEnabled: true,
      startedAtMs: now,
      sharedWith: { [caller.uid]: true, [String(booking.customerUid ?? '')]: true },
    });

  await writeEvent({
    bookingId: input.bookingId,
    type: 'otp_verified',
    actorUid: caller.uid,
    actorRole: 'driver',
    fromStatus: status,
    toStatus: 'trip_started',
    payload: { purpose: 'trip_start', startOdometerKm: input.odometerKm },
  });
  await writeEvent({
    bookingId: input.bookingId,
    type: 'trip_started',
    actorUid: caller.uid,
    actorRole: 'driver',
    fromStatus: status,
    toStatus: 'trip_started',
    payload: { startOdometerKm: input.odometerKm, arrivalWasManual: !arrived },
  });

  log({ fn: 'verifyTripOtp', outcome: 'started', actorUid: caller.uid, bookingId: input.bookingId, startOdometerKm: input.odometerKm });
  return { bookingId: input.bookingId, status: 'trip_started', startOdometerKm: input.odometerKm, tripStartedAtMs: now };
});

/**
 * Driver: the reading as it stands, and the running fare with it.
 *
 * The response is the point. Both apps render what the server returns here —
 * never their own arithmetic — so the number a customer watches climb is
 * produced by the same call that will price the bill, off the same rule.
 */
export const recordOdometer = onCall(CALLABLE_OPTIONS, async (request) => {
  const caller = requireDriver(request);
  const input = parseInput(recordMeterRef, request.data);
  const booking = await readBooking(input.bookingId);
  assertAssignedDriver(booking, caller.uid);

  const status = booking.status as BookingStatus;
  if (status !== 'trip_started' && status !== 'in_progress') {
    throw failedPrecondition(`There is no running trip to post a meter reading to ("${status}").`);
  }

  const start = booking.startOdometerKm;
  if (typeof start !== 'number') {
    throw failedPrecondition('This trip was opened without an odometer reading, so nothing can be metered against it.');
  }
  if (input.odometerKm < start) {
    throw failedPrecondition(`The reading you entered (${input.odometerKm} km) is below the ${start} km captured at pickup.`);
  }

  const now = Date.now();
  const tripStartMs = epochMs(booking.tripStartedAtMs) ?? now;
  const quote = readQuote(booking);
  const rule = await ruleForQuote(booking, quote);

  const runningFare = meteredTrip({
    rule,
    quote,
    quotedDistanceMeters: quotedDistance(booking),
    startOdometerKm: start,
    odometerKm: input.odometerKm,
    tripStartMs,
    scheduledForMs: epochMs(booking.scheduledForMs),
    kind: 'estimate',
    nowMs: now,
  });

  await db()
    .doc(bookingRefPath(input.bookingId))
    .update({
      currentOdometerKm: input.odometerKm,
      // The server's own running bill, kept on the booking so the customer's app
      // can show it. It cannot call this function — the reading is the driver's
      // to report — and it must never price a fare itself.
      runningFare,
      // The first posted reading is the trip actually moving.
      ...(status === 'trip_started' ? { status: 'in_progress' as BookingStatus } : {}),
      stateVersion: Number(booking.stateVersion ?? 0) + 1,
      updatedAtMs: serverTimestamp(),
    });

  await writeEvent({
    bookingId: input.bookingId,
    type: 'odometer_recorded',
    actorUid: caller.uid,
    actorRole: 'driver',
    fromStatus: status,
    toStatus: status === 'trip_started' ? 'in_progress' : status,
    payload: {
      odometerKm: input.odometerKm,
      runMetres: (input.odometerKm - start) * 1000,
      runningTotalPaise: runningFare.totalPaise,
    },
    unique: true,
  });

  log({ fn: 'recordOdometer', outcome: 'posted', actorUid: caller.uid, bookingId: input.bookingId, odometerKm: input.odometerKm });
  return {
    bookingId: input.bookingId,
    status: status === 'trip_started' ? 'in_progress' : status,
    startOdometerKm: start,
    currentOdometerKm: input.odometerKm,
    runMetres: (input.odometerKm - start) * 1000,
    runningFare,
  };
});

/**
 * Driver: the end code, the closing reading, and the bill.
 *
 * Order matters. The code is consumed before anything is written, so a refused
 * guess leaves the trip running; the fare is priced from the two readings on the
 * quote's own rule; and the booking, its summary and its events land in one
 * transaction so a receipt can never exist without the status that produced it.
 *
 * Setting `status: completed` is what bills the platform's share — the
 * commission trigger watches that field. The due the driver now owes is derived
 * once, through the ledger's own function, and written onto the booking with the
 * receipt: the rate stays the one the quote pinned, but the base follows the
 * fare the customer actually pays, so the ledger, the duty row and the driver's
 * Earnings all read the same number.
 */
export const confirmCompletion = onCall(CALLABLE_OPTIONS, async (request) => {
  const caller = requireDriver(request);
  const input = parseInput(completeRef, request.data);
  const booking = await readBooking(input.bookingId);
  assertAssignedDriver(booking, caller.uid);

  const status = booking.status as BookingStatus;
  if (status === 'completed') {
    throw failedPrecondition('This trip is already closed.');
  }
  if (!RUNNING.includes(status)) {
    throw failedPrecondition(`A trip cannot be closed from "${status}".`);
  }

  const start = booking.startOdometerKm;
  if (typeof start !== 'number') {
    throw failedPrecondition('This trip was never opened with an odometer reading, so there is nothing to close.');
  }
  if (input.odometerKm < start) {
    throw failedPrecondition(
      `The closing reading (${input.odometerKm} km) is below the opening ${start} km. The meter does not run backwards.`,
    );
  }
  if (!canTransition('in_progress', 'completed', 'driver')) {
    // Not a runtime branch so much as a tripwire: the state table is the contract
    // this file is written against, and a silent edit to it should fail loudly.
    throw failedPrecondition('The booking state machine no longer allows a driver to complete a running trip.');
  }

  await consumeTripOtp({ bookingId: input.bookingId, purpose: 'trip_end', code: input.code, actorUid: caller.uid });

  const now = Date.now();
  const tripStartMs = epochMs(booking.tripStartedAtMs) ?? now;
  const quote = readQuote(booking);
  const rule = await ruleForQuote(booking, quote);

  const finalFare = meteredTrip({
    rule,
    quote,
    quotedDistanceMeters: quotedDistance(booking),
    startOdometerKm: start,
    odometerKm: input.odometerKm,
    tripStartMs,
    scheduledForMs: epochMs(booking.scheduledForMs),
    kind: 'final',
    nowMs: now,
  });

  const runMetres = (input.odometerKm - start) * 1000;
  const durationSeconds = Math.max(0, Math.floor((now - tripStartMs) / 1000));

  // The commission this receipt raises, read through the ledger's own derivation
  // rather than a second calculation here, so the amount on the dues row and the
  // amount on screen cannot drift.
  const commissionTerms = await configuredCommissionTerms();
  const billable = billableCompletion(
    { ...booking, status: 'completed', id: input.bookingId, finalFare },
    commissionTerms.rate,
    commissionTerms.gstRate,
  );
  if (!billable) {
    // Tripwire, like the state-machine check above: a booking this far through
    // the loop has a driver and a priced fare, so the ledger refusing to bill it
    // means the two derivations have split apart and a silent fallback would
    // hand the platform an unpaid due nobody can explain.
    throw failedPrecondition(
      'The closed fare produced no commission to bill, so this trip cannot be recorded as complete.',
    );
  }

  const bookingDoc = db().doc(bookingRefPath(input.bookingId));
  const summaryDoc = db().doc(`${COLLECTIONS.tripSummaries}/${input.bookingId}`);

  await db().runTransaction(async (tx) => {
    tx.set(
      bookingDoc,
      {
        status: 'completed',
        // Closing with the customer's end code records the cash the driver
        // collected directly. DrivX never settles the customer's trip fare.
        paymentStatus: 'cash_collected',
        paymentMethod: 'cash',
        cashPaymentCollectedAtMs: now,
        endOdometerKm: input.odometerKm,
        currentOdometerKm: input.odometerKm,
        completedAtMs: now,
        finalFare,
        actualDistanceMeters: runMetres,
        actualDurationSeconds: durationSeconds,
        arrivedLateSeconds: typeof booking.arrivalLateSeconds === 'number' ? booking.arrivalLateSeconds : null,
        // Re-pinned from the metered receipt. At booking time this block priced
        // the trip the map promised; if it stayed there, the driver's Earnings
        // would show the commission on the quote while Duty demanded the one on
        // the trip actually driven — two numbers for the same booking.
        commission: billable.terms,
        stateVersion: Number(booking.stateVersion ?? 0) + 1,
        updatedAtMs: serverTimestamp(),
      },
      { merge: true },
    );

    // The anonymised accounting row, keyed by the booking so one trip is one row.
    tx.set(
      summaryDoc,
      {
        bookingId: input.bookingId,
        reference: booking.reference ?? null,
        serviceTypeId: booking.serviceTypeId ?? null,
        zoneId: booking.zoneId ?? null,
        driverUid: booking.assignedDriverUid ?? null,
        startedAtMs: tripStartMs,
        completedAtMs: now,
        quotedDistanceMeters: booking.estimatedDistanceMeters ?? null,
        actualDistanceMeters: runMetres,
        durationSeconds,
        startOdometerKm: start,
        endOdometerKm: input.odometerKm,
        currency: finalFare.currency,
        subtotalPaise: finalFare.subtotalPaise,
        taxPaise: finalFare.taxPaise,
        totalPaise: finalFare.totalPaise,
        pricingRuleId: finalFare.pricingRuleId,
        pricedFromOdometer: true,
        createdAtMs: serverTimestamp(),
      },
      { merge: true },
    );
  });

  // OTR is assessed at arrival, but collected only after the trip is closed.
  // A stable due id prevents duplicate penalties on function retries. Admin can
  // set the amount to zero to turn the policy off; absent config uses ₹50.
  const lateSeconds = typeof booking.arrivalLateSeconds === 'number' ? booking.arrivalLateSeconds : 0;
  const performancePolicy = (await db().doc(`${COLLECTIONS.appConfig}/driverPerformance`).get()).data() ?? {};
  const penaltyPaise = performancePolicy.lateArrivalPenaltyPaise === undefined || performancePolicy.lateArrivalPenaltyPaise === null
    ? 5_000
    : Number.isSafeInteger(performancePolicy.lateArrivalPenaltyPaise) && Number(performancePolicy.lateArrivalPenaltyPaise) > 0
      ? Number(performancePolicy.lateArrivalPenaltyPaise)
      : 0;
  if (lateSeconds > 0 && penaltyPaise > 0) {
    const dueId = `late_arrival_${input.bookingId}`;
    const gstRate = Number.isFinite(Number(performancePolicy.lateArrivalPenaltyGstRate))
      ? Math.max(0, Math.min(1, Number(performancePolicy.lateArrivalPenaltyGstRate)))
      : 0;
    const gstPaise = Math.round(penaltyPaise * gstRate);
    try {
      await db().doc(`driverProfiles/${caller.uid}/dues/${dueId}`).create({
        id: dueId, driverUid: caller.uid, kind: 'late_arrival_penalty', title: 'Late arrival penalty',
        bookingId: input.bookingId, currency: 'INR', basePaise: penaltyPaise, rate: null,
        commissionablePaise: null, gstRate, gstPaise, totalPaise: penaltyPaise + gstPaise,
        status: 'unpaid', method: null, reference: null, recordedByUid: null, recordedAtMs: null,
        createdAtMs: serverTimestamp(), updatedAtMs: serverTimestamp(),
      });
    } catch (error) {
      const code = (error as { code?: number } | undefined)?.code;
      if (code !== 6 && !/already exists/i.test(String(error))) throw error;
    }
  }

  await rtdb().ref(`authz/${input.bookingId}/trackingEnabled`).set(false);
  await Promise.all([
    rtdb().ref(`activeBookings/${input.bookingId}`).remove(),
    rtdb().ref(`driverLocations/${caller.uid}`).remove(),
  ]);

  await writeEvent({
    bookingId: input.bookingId,
    type: 'otp_verified',
    actorUid: caller.uid,
    actorRole: 'driver',
    fromStatus: status,
    toStatus: 'completed',
    payload: { purpose: 'trip_end', endOdometerKm: input.odometerKm },
  });
  await writeEvent({
    bookingId: input.bookingId,
    type: 'destination_detected',
    actorUid: caller.uid,
    actorRole: 'driver',
    fromStatus: status,
    toStatus: 'completed',
    payload: { endOdometerKm: input.odometerKm, startOdometerKm: start, runMetres },
  });
  await writeEvent({
    bookingId: input.bookingId,
    type: 'fare_finalised',
    actorUid: caller.uid,
    actorRole: 'system',
    fromStatus: status,
    toStatus: 'completed',
    payload: {
      quotedTotalPaise: quote.totalPaise,
      finalTotalPaise: finalFare.totalPaise,
      distanceSource: 'odometer',
    },
  });
  await writeEvent({
    bookingId: input.bookingId,
    type: 'trip_completed',
    actorUid: caller.uid,
    actorRole: 'driver',
    fromStatus: status,
    toStatus: 'completed',
    payload: { runMetres, durationSeconds },
  });

  // The commission the ledger raises a moment after this response returns, from
  // the same terms just written onto the booking.
  log({
    fn: 'confirmCompletion',
    outcome: 'completed',
    actorUid: caller.uid,
    bookingId: input.bookingId,
    runMetres,
    finalTotalPaise: finalFare.totalPaise,
  });
  return {
    bookingId: input.bookingId,
    reference: booking.reference ?? null,
    status: 'completed',
    startOdometerKm: start,
    endOdometerKm: input.odometerKm,
    actualDistanceMeters: runMetres,
    durationSeconds,
    quotedTotalPaise: quote.totalPaise,
    finalFare,
    commissionPaise: billable?.due.totalPaise ?? null,
  };
});

/**
 * Manual arrival confirmation for when GPS has failed.
 *
 * Still unbuilt on purpose: with the trip-start OTP in place, a driver entering
 * the customer's code already has the stronger proof of arrival, so this call
 * would be a second door with nothing behind it until geofenced arrival exists.
 */
export const confirmArrival = onCall(CALLABLE_OPTIONS, async (request) => {
  const caller = requireDriver(request);
  const input = parseInput(bookingRef.extend({ reason: z.string().trim().min(6).max(240) }), request.data);
  log({ fn: 'confirmArrival', outcome: 'not_implemented', actorUid: caller.uid, bookingId: input.bookingId });
  throw notImplemented('Phase 4', 'confirmArrival');
});
