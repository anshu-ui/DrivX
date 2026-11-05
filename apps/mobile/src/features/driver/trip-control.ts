import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import {
  collection,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
  doc,
} from 'firebase/firestore';
import {
  COLLECTIONS,
  readCommissionSnapshot,
  type BookingStatus,
  type CommissionSnapshot,
  type FareBreakdown,
  type Place,
  type TripDirection,
} from '@drivx/domain';
import { FunctionCallError, callFunction, toEpochMs } from '@drivx/firebase-client';
import { useSession } from '../auth/AuthProvider';
import { firebase } from '../../lib/firebase';
import { fareOf, placeOf } from '../customer/queries';

/**
 * The trip a driver is carrying, and the three calls that move it.
 *
 * Nothing here decides anything. The code is checked by the server, the bill is
 * priced by the server off the two dial readings, and the status only changes
 * because a function wrote it — after every call the booking is read again rather
 * than assumed. The one figure the driver types that changes money is the
 * odometer, and that is a *reading*: the server refuses one that runs backwards
 * and prices the trip from its own rule.
 */

/** The statuses a driver can be working in, in the order the trip passes them. */
const ON_DUTY: BookingStatus[] = [
  'assigned',
  'driver_en_route',
  'driver_arrived',
  'trip_started',
  'in_progress',
  'destination_reached',
];

export type DriverTripView = {
  id: string;
  reference: string;
  status: BookingStatus;
  pickup: Place | null;
  destination: Place | null;
  routePolyline: string | null;
  tripDirection: TripDirection | null;
  scheduledForMs: number | null;
  /** What the map quoted, what the dial has produced so far, and the receipt. */
  estimate: FareBreakdown | null;
  runningFare: FareBreakdown | null;
  finalFare: FareBreakdown | null;
  startOdometerKm: number | null;
  currentOdometerKm: number | null;
  endOdometerKm: number | null;
  tripStartedAtMs: number | null;
  completedAtMs: number | null;
  /** The office's terms, as the booking itself recorded them at pricing. */
  commission: CommissionSnapshot | null;
  customerContact: { fullName: string; phoneE164: string } | null;
};

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function tripView(id: string, data: Record<string, unknown>): DriverTripView {
  const contact = data.customerContact as { fullName?: unknown; phoneE164?: unknown } | null | undefined;
  return {
    id,
    reference: typeof data.reference === 'string' ? data.reference : id,
    status: (typeof data.status === 'string' ? data.status : 'unknown') as BookingStatus,
    pickup: placeOf(data.pickup),
    destination: placeOf(data.destination),
    routePolyline: typeof data.routePolyline === 'string' ? data.routePolyline : null,
    tripDirection:
      data.tripDirection === 'round_trip' || data.tripDirection === 'one_way'
        ? data.tripDirection
        : null,
    scheduledForMs: toEpochMs(data.scheduledForMs),
    estimate: fareOf(data.estimate),
    runningFare: fareOf(data.runningFare),
    finalFare: fareOf(data.finalFare),
    startOdometerKm: numberOrNull(data.startOdometerKm),
    currentOdometerKm: numberOrNull(data.currentOdometerKm),
    endOdometerKm: numberOrNull(data.endOdometerKm),
    tripStartedAtMs: toEpochMs(data.tripStartedAtMs),
    completedAtMs: toEpochMs(data.completedAtMs),
    commission: readCommissionSnapshot(data.commission),
    customerContact:
      contact && typeof contact === 'object'
        ? {
            fullName: typeof contact.fullName === 'string' ? contact.fullName : 'DrivX customer',
            phoneE164: typeof contact.phoneE164 === 'string' ? contact.phoneE164 : '',
          }
        : null,
  };
}

const onDutyQuery = (uid: string) =>
  query(
    collection(firebase().firestore, COLLECTIONS.bookings),
    where('assignedDriverUid', '==', uid),
    where('status', 'in', ON_DUTY),
    orderBy('createdAtMs', 'desc'),
    limit(10),
  );

/**
 * The booking to work on, with the numbers the server put on it.
 *
 * The list rule a driver satisfies is the same one the earnings screen already
 * uses — own uid in `assignedDriverUid`, limit well under 50 — and the composite
 * index covers the status filter, so this is one indexed read. The id is then
 * re-read as a document, because the list rule and the get rule are different
 * checks and the fare block is only guaranteed on a direct read.
 *
 * A listener sits on the same query so the screen moves with the meter: the fare
 * only means anything if it climbs while the car is climbing.
 */
export function useDriverTrip() {
  const { user } = useSession();
  const queryKey = useMemo(() => ['driverTrip', user?.uid ?? 'anon'], [user?.uid]);
  const client = useQueryClient();

  useEffect(() => {
    if (!user) return undefined;
    const changed = () => void client.invalidateQueries({ queryKey });
    return onSnapshot(onDutyQuery(user.uid), changed, changed);
  }, [user, client, queryKey]);

  return useQuery({
    queryKey,
    enabled: Boolean(user),
    queryFn: async () => {
      const list = await getDocs(onDutyQuery(user!.uid));
      if (list.empty) return null;
      const bookingId = list.docs[0]!.id;
      let detail = await getDoc(doc(firebase().firestore, COLLECTIONS.bookings, bookingId));
      if (!detail.exists()) return null;
      const data = detail.data() as Record<string, unknown>;
      const customerContact = data.customerContact as { phoneE164?: unknown } | null | undefined;
      if (!customerContact?.phoneE164) {
        // Some older bookings and accounts were accepted before contact
        // snapshots were populated. Ask the server to repair this one booking;
        // the server checks the assigned driver and returns only safe contact
        // fields, with Firebase Auth as a fallback for legacy profiles.
        try {
          await callFunction<{ bookingId: string }, { uid: string; fullName: string; phoneE164: string }>(
            firebase(),
            'customerContactForAssignedDriver',
            { bookingId },
          );
          detail = await getDoc(doc(firebase().firestore, COLLECTIONS.bookings, bookingId));
        } catch {
          // Keep the trip usable if the contact lookup is temporarily unavailable.
        }
      }
      if (!detail.exists()) return null;
      return tripView(bookingId, detail.data() as Record<string, unknown>);
    },
  });
}

type CallOutcome<T> = { ok: true; result: T } | { ok: false; message: string };

/**
 * One callable, and the reads it re-fetches when it answers.
 *
 * A refusal comes back as text rather than a throw, because every message these
 * functions write is addressed to the person standing at the car — "ask the
 * customer for a fresh one" — and a screen that shows it is a screen the driver
 * can act on. The re-read happens on failure too: the trip may have moved anyway,
 * and a screen still saying "start" over a trip that is running is how a reading
 * gets posted twice.
 */
async function tripCall<T>(name: string, payload: unknown, refresh: () => Promise<unknown>): Promise<CallOutcome<T>> {
  try {
    const result = await callFunction<unknown, T>(firebase(), name, payload);
    await refresh();
    return { ok: true, result };
  } catch (error) {
    await refresh();
    return {
      ok: false,
      message:
        error instanceof FunctionCallError
          ? error.message
          : `${name} could not be reached, so nothing was changed on the trip.`,
    };
  }
}

/** The customer's start code and the dial at pickup. */
export function useStartTrip() {
  const client = useQueryClient();
  const { user } = useSession();
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ['driverTrip', user?.uid ?? 'anon'] }),
      client.invalidateQueries({ queryKey: ['booking'] }),
    ]);

  return useMutation({
    mutationFn: (input: { bookingId: string; code: string; odometerKm: number }) =>
      tripCall<{ status: BookingStatus; startOdometerKm: number; tripStartedAtMs: number }>(
        'verifyTripOtp',
        input,
        refresh,
      ),
  });
}

/** Mark the accepted driver as travelling to pickup before the OTP trip start. */
export function useStartTripApproach() {
  const client = useQueryClient();
  const { user } = useSession();
  const refresh = () => Promise.all([
    client.invalidateQueries({ queryKey: ['driverTrip', user?.uid ?? 'anon'] }),
    client.invalidateQueries({ queryKey: ['booking'] }),
  ]);
  return useMutation({
    mutationFn: (bookingId: string) => tripCall<{ bookingId: string; status: BookingStatus }>(
      'startTripApproach', { bookingId }, refresh,
    ),
  });
}

/** The reading as it stands, and the running bill priced from it. */
export function usePostReading() {
  const client = useQueryClient();
  const { user } = useSession();
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ['driverTrip', user?.uid ?? 'anon'] }),
      client.invalidateQueries({ queryKey: ['booking'] }),
    ]);

  return useMutation({
    mutationFn: (input: { bookingId: string; odometerKm: number }) =>
      tripCall<{
        currentOdometerKm: number;
        runMetres: number;
        runningFare: FareBreakdown;
      }>('recordOdometer', input, refresh),
  });
}

/** The end code, the closing reading, and the receipt with its commission. */
export function useEndTrip() {
  const client = useQueryClient();
  const { user } = useSession();
  // `drivenTrips` and the dues list are the two screens this changes: the trip
  // leaves duty and enters earnings, and the commission trigger raises the row
  // the money hold is watching.
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ['driverTrip', user?.uid ?? 'anon'] }),
      client.invalidateQueries({ queryKey: ['drivenTrips', user?.uid ?? 'anon'] }),
      client.invalidateQueries({ queryKey: ['booking'] }),
    ]);

  return useMutation({
    mutationFn: (input: { bookingId: string; code: string; odometerKm: number }) =>
      tripCall<{
        actualDistanceMeters: number;
        durationSeconds: number;
        quotedTotalPaise: number;
        finalFare: FareBreakdown;
        commissionPaise: number | null;
      }>('confirmCompletion', input, refresh),
  });
}
