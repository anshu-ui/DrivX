import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import {
  COLLECTIONS,
  SUBCOLLECTIONS,
  type AssignedDriverCard,
  type BookingStatus,
  type FareBreakdown,
  type Place,
  type SupportTicketStatus,
  type TripDirection,
  type TripEventType,
} from '@drivx/domain';
import { toEpochMs } from '@drivx/firebase-client';
import { useSession } from '../auth/AuthProvider';
import { firebase } from '../../lib/firebase';
import { isLive } from './labels';

/**
 * Reads the customer is allowed to make directly.
 *
 * These mirror the security rules rather than working around them: every query
 * is filtered on the caller's own uid, the limits are the ones the list rules
 * demand, and nothing here expects a client to write a fare, a status or a
 * claim. Fields the server owns are read as-is and never re-sent.
 */

export type BookingView = {
  id: string;
  reference: string;
  status: BookingStatus;
  paymentStatus: string;
  createdAtMs: number | null;
  scheduledForMs: number | null;
  pickup: Place | null;
  destination: Place | null;
  routePolyline: string | null;
  etaMinutes: number | null;
  /** Null on a booking written before the trip type was recorded — not a guess at one way. */
  tripDirection: TripDirection | null;
  estimate: FareBreakdown | null;
  /**
   * What the trip has cost so far, priced by the server off the latest reading
   * the driver posted. Null until the first reading arrives — an unmoving trip
   * is not a trip at ₹0.00.
   */
  runningFare: FareBreakdown | null;
  finalFare: FareBreakdown | null;
  /**
   * The dial, as the driver reported it and the server checked it. Null means
   * that reading has not happened; 0 km would mean a car that has never moved,
   * and the two are very different things to show a customer.
   */
  startOdometerKm: number | null;
  currentOdometerKm: number | null;
  assignedDriverUid: string | null;
  /**
   * The server's copy of the assigned driver, published onto this booking the
   * moment a uid lands on it. Null until then — a customer waiting for a car is
   * not shown somebody who has not been given the trip.
   */
  driver: AssignedDriverCard | null;
  /**
   * Null until the customer rates the trip — the absence is the state, not a
   * zero, and the receipt's rating panel reads it to decide whether to offer a
   * score or show the one already given.
   */
  customerRating: number | null;
  /**
   * How the trip was ended, straight off the record. Null fields mean the
   * booking was never cancelled rather than that the reason is unknown — a
   * customer who cancelled and sees no reason next to the status would assume
   * the app lost it.
   */
  cancellation: {
    by: string | null;
    reasonCode: string | null;
    reasonText: string | null;
    atMs: number | null;
  };
};

export type TripEventView = {
  id: string;
  type: TripEventType;
  atMs: number | null;
  fromStatus: string | null;
  toStatus: string | null;
};

/**
 * The receipt row `confirmCompletion` writes beside the booking.
 *
 * Field names follow that writer exactly: a distance read off the dial is
 * `actualDistanceMeters`, and the quoted one it is compared against is
 * `quotedDistanceMeters`. An earlier version of this type asked for
 * `distanceMeters`, which nothing ever wrote, so every completed trip printed
 * "Distance not measured" beside a bill the dial had produced.
 */
export type TripSummaryView = {
  actualDistanceMeters: number | null;
  quotedDistanceMeters: number | null;
  durationSeconds: number | null;
  startOdometerKm: number | null;
  endOdometerKm: number | null;
  startedAtMs: number | null;
  completedAtMs: number | null;
};

export type SavedPlaceView = {
  id: string;
  label: string;
  name: string;
  place: Place | null;
  updatedAtMs: number | null;
};

export type NotificationView = {
  id: string;
  title: string | null;
  body: string | null;
  type: string | null;
  createdAtMs: number | null;
  readAtMs: number | null;
};

export type TicketView = {
  id: string;
  subject: string;
  body: string;
  status: SupportTicketStatus;
  category: string | null;
  bookingId: string | null;
  createdAtMs: number | null;
  resolvedAtMs: number | null;
  resolution: string | null;
};

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** An address as the server wrote it. The driver app reads places with this too. */
export function placeOf(value: unknown): Place | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const location = raw.location as { lat?: number; lng?: number } | undefined;
  if (!location || typeof location.lat !== 'number' || typeof location.lng !== 'number') return null;
  return {
    label: text(raw.label) ?? text(raw.addressLine1) ?? 'Address',
    addressLine1: text(raw.addressLine1) ?? '',
    addressLine2: text(raw.addressLine2) ?? undefined,
    city: text(raw.city) ?? '',
    state: text(raw.state) ?? '',
    pincode: text(raw.pincode) ?? undefined,
    location: { lat: location.lat, lng: location.lng },
    placeId: text(raw.placeId) ?? undefined,
    source: (text(raw.source) as Place['source']) ?? 'saved_place',
  };
}

/**
 * A breakdown the server produced. Money arrives in integer paise and stays that
 * way here; nothing on a screen does arithmetic on rupees.
 */
export function fareOf(value: unknown): FareBreakdown | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const items = Array.isArray(raw.items) ? (raw.items as FareBreakdown['items']) : [];
  return {
    currency: 'INR',
    items,
    subtotalPaise: Number(raw.subtotalPaise ?? 0),
    taxPaise: Number(raw.taxPaise ?? 0),
    totalPaise: Number(raw.totalPaise ?? 0),
    pricingRuleId: text(raw.pricingRuleId) ?? '',
    quoteId: text(raw.quoteId),
    pricingVersion: Number(raw.pricingVersion ?? 1),
    pricingSnapshotHash: text(raw.pricingSnapshotHash),
    generatedAtMs: toEpochMs(raw.generatedAtMs) ?? 0,
    expiresAtMs: toEpochMs(raw.expiresAtMs),
    kind: raw.kind === 'final' ? 'final' : 'estimate',
    packageTierId: text(raw.packageTierId),
  };
}

/**
 * The driver, as the server published it onto this booking.
 *
 * Read defensively rather than trusted: a card written before a field existed
 * simply yields the same honest empty value the UI would show for a driver with
 * nothing on file. A customer is never shown a fabricated name or number.
 */
export function driverOf(value: unknown): AssignedDriverCard | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const uid = text(raw.uid);
  if (!uid) return null;
  const vehicle = (raw.vehicle ?? {}) as Record<string, unknown>;
  return {
    uid,
    driverId: text(raw.driverId),
    fullName: text(raw.fullName) ?? 'DrivX driver',
    phoneE164: text(raw.phoneE164) ?? '',
    photoPath: text(raw.photoPath),
    ratingAverage: typeof raw.ratingAverage === 'number' ? raw.ratingAverage : 0,
    ratingCount: typeof raw.ratingCount === 'number' ? raw.ratingCount : 0,
    lifetimeTrips: typeof raw.lifetimeTrips === 'number' ? raw.lifetimeTrips : 0,
    languages: Array.isArray(raw.languages)
      ? raw.languages.filter((item): item is string => typeof item === 'string')
      : [],
    vehicle: {
      make: text(vehicle.make),
      model: text(vehicle.model),
      plate: text(vehicle.plate),
    },
    publishedAtMs: toEpochMs(raw.publishedAtMs),
  };
}

function bookingView(snap: QueryDocumentSnapshot): BookingView {
  const data = snap.data() as Record<string, unknown>;
  const eta = data.driverEnRouteEta as { minutes?: number } | undefined;
  const cancellation = (data.cancellation ?? {}) as Record<string, unknown>;
  return {
    id: snap.id,
    reference: text(data.reference) ?? snap.id,
    status: (text(data.status) ?? 'unknown') as BookingStatus,
    paymentStatus: text(data.paymentStatus) ?? 'unknown',
    createdAtMs: toEpochMs(data.createdAtMs),
    scheduledForMs: toEpochMs(data.scheduledForMs),
    pickup: placeOf(data.pickup),
    destination: placeOf(data.destination),
    routePolyline: typeof data.routePolyline === 'string' ? data.routePolyline : null,
    etaMinutes: typeof eta?.minutes === 'number' ? eta.minutes : null,
    tripDirection:
      data.tripDirection === 'round_trip' || data.tripDirection === 'one_way'
        ? data.tripDirection
        : null,
    estimate: fareOf(data.estimate),
    runningFare: fareOf(data.runningFare),
    finalFare: fareOf(data.finalFare),
    startOdometerKm: typeof data.startOdometerKm === 'number' ? data.startOdometerKm : null,
    currentOdometerKm: typeof data.currentOdometerKm === 'number' ? data.currentOdometerKm : null,
    assignedDriverUid: text(data.assignedDriverUid),
    driver: driverOf(data.driver),
    // The score this customer already gave, mirrored onto the booking by
    // `rateTrip` so the receipt can show it without reading another collection.
    customerRating: typeof data.customerRating === 'number' ? data.customerRating : null,
    cancellation: {
      by: text(cancellation.by),
      reasonCode: text(cancellation.reasonCode),
      reasonText: text(cancellation.reasonText),
      atMs: toEpochMs(cancellation.atMs),
    },
  };
}

/** Bookings the caller is a party to, newest first — the shape the list rule allows. */
export function useMyBookings() {
  const { user } = useSession();
  const client = useQueryClient();
  const uid = user?.uid ?? 'anon';
  const queryKey = useMemo(() => ['bookings', uid], [uid]);

  // The list gets the same listener as the detail screen. Without it a customer
  // who opened Trips before the driver started the trip kept reading "Driver
  // assigned" and the quoted fare beside a live trip that had already moved on.
  useEffect(() => {
    if (!user) return undefined;
    const changed = () => void client.invalidateQueries({ queryKey });
    return onSnapshot(
      query(
        collection(firebase().firestore, COLLECTIONS.bookings),
        where('customerUid', '==', user.uid),
        orderBy('createdAtMs', 'desc'),
        limit(25),
      ),
      changed,
      changed,
    );
  }, [user?.uid, client, queryKey]);

  return useQuery({
    queryKey,
    enabled: Boolean(user),
    queryFn: async () => {
      const snap = await getDocs(
        query(
          collection(firebase().firestore, COLLECTIONS.bookings),
          where('customerUid', '==', user!.uid),
          orderBy('createdAtMs', 'desc'),
          limit(25),
        ),
      );
      return snap.docs.map(bookingView);
    },
  });
}

/**
 * The booking that is happening now or on its way.
 *
 * `isActiveTrip` only covers statuses from `trip_started` on, which would hide a
 * driver who is already en route — the one state the customer most wants to see.
 * Terminal statuses are what must be excluded here.
 */
export function useActiveBooking() {
  const bookings = useMyBookings();
  return {
    ...bookings,
    booking: bookings.data?.find((booking) => isLive(booking.status)) ?? null,
  };
}

export function useBookingDetail(bookingId: string | undefined) {
  const { user } = useSession();
  const client = useQueryClient();
  const queryKey = useMemo(
    () => ['booking', bookingId, user?.uid ?? 'anon'],
    [bookingId, user?.uid],
  );

  // A one-shot read would freeze the meter: the driver posts readings from their
  // own app, and the customer's screen has to follow the number as it climbs.
  // The listener only says "this changed" — every figure still comes from the
  // same server-authored read the first paint used, so nothing here is
  // recalculated on the phone.
  useEffect(() => {
    if (!bookingId || !user) return undefined;
    const fs = firebase().firestore;
    const changed = () => void client.invalidateQueries({ queryKey });
    const unsubscribes = [
      onSnapshot(doc(fs, COLLECTIONS.bookings, bookingId), changed, changed),
      onSnapshot(doc(fs, COLLECTIONS.tripSummaries, bookingId), changed, changed),
      onSnapshot(
        collection(fs, COLLECTIONS.bookings, bookingId, SUBCOLLECTIONS.tripEvents),
        changed,
        changed,
      ),
    ];
    return () => unsubscribes.forEach((stop) => stop());
  }, [bookingId, user, client, queryKey]);

  return useQuery({
    queryKey,
    enabled: Boolean(bookingId && user),
    queryFn: async () => {
      const fs = firebase().firestore;
      const [bookingSnap, summarySnap, eventsSnap] = await Promise.all([
        getDoc(doc(fs, COLLECTIONS.bookings, bookingId!)),
        getDoc(doc(fs, COLLECTIONS.tripSummaries, bookingId!)),
        getDocs(query(collection(fs, COLLECTIONS.bookings, bookingId!, SUBCOLLECTIONS.tripEvents), limit(50))),
      ]);
      if (!bookingSnap.exists()) return null;

      const summary = summarySnap.exists()
        ? ((): TripSummaryView => {
            const data = summarySnap.data() as Record<string, unknown>;
            return {
              actualDistanceMeters:
                typeof data.actualDistanceMeters === 'number' ? data.actualDistanceMeters : null,
              quotedDistanceMeters:
                typeof data.quotedDistanceMeters === 'number' ? data.quotedDistanceMeters : null,
              durationSeconds: typeof data.durationSeconds === 'number' ? data.durationSeconds : null,
              startOdometerKm: typeof data.startOdometerKm === 'number' ? data.startOdometerKm : null,
              endOdometerKm: typeof data.endOdometerKm === 'number' ? data.endOdometerKm : null,
              startedAtMs: toEpochMs(data.startedAtMs),
              completedAtMs: toEpochMs(data.completedAtMs),
            };
          })()
        : null;

      const events: TripEventView[] = eventsSnap.docs
        .map((snap) => {
          const data = snap.data() as Record<string, unknown>;
          return {
            id: snap.id,
            type: (text(data.type) ?? 'unknown') as TripEventType,
            atMs: toEpochMs(data.atMs),
            fromStatus: text(data.fromStatus),
            toStatus: text(data.toStatus),
          };
        })
        .sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0));

      return { booking: bookingView(bookingSnap), summary, events };
    },
  });
}

export function useSavedPlaces() {
  const { user } = useSession();
  return useQuery({
    queryKey: ['savedPlaces', user?.uid ?? 'anon'],
    enabled: Boolean(user),
    queryFn: async () => {
      // No orderBy: the collection-group index covers (uid, label), and the
      // client can sort a list this short itself.
      const snap = await getDocs(
        query(
          collection(firebase().firestore, COLLECTIONS.savedPlaces, user!.uid, SUBCOLLECTIONS.savedPlaces),
          where('uid', '==', user!.uid),
          limit(20),
        ),
      );
      return snap.docs
        .map((docSnap) => {
          const data = docSnap.data() as Record<string, unknown>;
          return {
            id: docSnap.id,
            label: text(data.label) ?? 'other',
            name: text(data.name) ?? text(data.label) ?? 'Place',
            place: placeOf(data.place),
            updatedAtMs: toEpochMs(data.updatedAtMs),
          } satisfies SavedPlaceView;
        })
        .sort((a, b) => (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0));
    },
  });
}

export function useNotifications() {
  const { user } = useSession();
  return useQuery({
    queryKey: ['notifications', user?.uid ?? 'anon'],
    enabled: Boolean(user),
    queryFn: async () => {
      const snap = await getDocs(
        query(
          collection(
            firebase().firestore,
            COLLECTIONS.users,
            user!.uid,
            SUBCOLLECTIONS.notifications,
          ),
          limit(25),
        ),
      );
      return snap.docs
        .map((docSnap) => {
          const data = docSnap.data() as Record<string, unknown>;
          return {
            id: docSnap.id,
            title: text(data.title),
            body: text(data.body),
            type: text(data.type),
            createdAtMs: toEpochMs(data.createdAtMs),
            readAtMs: toEpochMs(data.readAtMs),
          } satisfies NotificationView;
        })
        .sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0));
    },
  });
}

export function useMyTickets() {
  const { user } = useSession();
  return useQuery({
    queryKey: ['supportTickets', user?.uid ?? 'anon'],
    enabled: Boolean(user),
    queryFn: async () => {
      const snap = await getDocs(
        query(
          collection(firebase().firestore, COLLECTIONS.supportTickets),
          where('openedByUid', '==', user!.uid),
          orderBy('createdAtMs', 'desc'),
          limit(20),
        ),
      );
      return snap.docs.map((docSnap) => {
        const data = docSnap.data() as Record<string, unknown>;
        return {
          id: docSnap.id,
          subject: text(data.subject) ?? '',
          body: text(data.body) ?? '',
          status: (text(data.status) ?? 'open') as SupportTicketStatus,
          category: text(data.category),
          bookingId: text(data.bookingId),
          createdAtMs: toEpochMs(data.createdAtMs),
          resolvedAtMs: toEpochMs(data.resolvedAtMs),
          resolution: text(data.resolution),
        } satisfies TicketView;
      });
    },
  });
}

export function useCustomerProfile() {
  const { user } = useSession();
  return useQuery({
    queryKey: ['customerProfile', user?.uid ?? 'anon'],
    enabled: Boolean(user),
    queryFn: async () => {
      const snap = await getDoc(
        doc(firebase().firestore, COLLECTIONS.customerProfiles, user!.uid),
      );
      if (!snap.exists()) return null;
      const data = snap.data() as Record<string, unknown>;
      const privacy = (data.privacy ?? {}) as Record<string, unknown>;
      const contact = (data.emergencyContact ?? {}) as Record<string, unknown>;
      return {
        fullName: text(data.fullName) ?? '',
        email: text(data.email),
        contactPhoneE164: text(data.contactPhoneE164),
        preferredTransmission: text(data.preferredTransmission) ?? 'either',
        marketingOptIn: privacy.marketingOptIn === true,
        shareTripWithContact: privacy.shareTripWithContact === true,
        emergencyContactName: text(contact.name),
        emergencyContactPhone: text(contact.phoneE164),
        notes: text(data.notes),
        lifetimeBookings: typeof data.lifetimeBookings === 'number' ? data.lifetimeBookings : 0,
        ratingAverage: typeof data.ratingAverage === 'number' ? data.ratingAverage : null,
        ratingCount: typeof data.ratingCount === 'number' ? data.ratingCount : 0,
        createdAtMs: toEpochMs(data.createdAtMs),
      };
    },
  });
}
