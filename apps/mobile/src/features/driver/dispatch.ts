import { useEffect, useMemo } from 'react';
import { Accuracy, requestBackgroundPermissionsAsync, requestForegroundPermissionsAsync, getCurrentPositionAsync } from 'expo-location';
import { getPermissionsAsync } from 'expo-notifications';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  orderBy,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';
import {
  COLLECTIONS,
  DUTY_TERMS,
  SUBCOLLECTIONS,
  type FareBreakdown,
} from '@drivx/domain';
import { callFunction, FunctionCallError, type FirebaseClients } from '@drivx/firebase-client';
import { useSession } from '../auth/AuthProvider';
import { firebase } from '../../lib/firebase';
import { syncDriverLocationTask } from './locationTask';

export type DriverOffer = {
  id: string;
  bookingId: string;
  bookingReference: string;
  pickup: string;
  destination: string;
  estimate: FareBreakdown | null;
  estimatedDistanceMeters: number | null;
  estimatedDurationSeconds: number | null;
  customerNotes: string | null;
  vehicleDescription: string | null;
  carType: string;
  transmission: string;
  distanceToPickupMeters: number | null;
  offeredAtMs: number;
  expiresAtMs: number;
};

async function readOffers(clients: FirebaseClients, uid: string): Promise<DriverOffer[]> {
  // Use the already-deployed driverUid/status/expiry ascending index. The
  // Firestore result is sorted newest-first locally for the driver's screen.
  // Inbox/FCM delivery is not the source of truth.
  const assignments = await getDocs(
    query(
      collectionGroup(clients.firestore, SUBCOLLECTIONS.driverAssignments),
      where('driverUid', '==', uid),
      where('status', '==', 'offered'),
      orderBy('expiresAtMs', 'asc'),
    ),
  );
  const now = Date.now();
  const rows = await Promise.all(
    assignments.docs.filter((assignment) => assignment.data().status === 'offered').map(async (assignment) => {
      const data = assignment.data();
      const bookingId = typeof data.bookingId === 'string' ? data.bookingId : null;
      const expiresAtMs = Number(data.expiresAtMs);
      const offeredAtMs = Number(data.offeredAtMs);
      if (!bookingId || !Number.isFinite(expiresAtMs) || expiresAtMs <= now || !Number.isFinite(offeredAtMs)) return null;
      const booking = await getDoc(doc(clients.firestore, COLLECTIONS.bookings, bookingId));
      if (!booking.exists()) return null;
      const trip = booking.data();
      if (trip.assignedDriverUid != null || !['requested', 'searching_driver'].includes(String(trip.status))) return null;
      const pickup = trip.pickup as { label?: unknown } | null;
      const destination = trip.destination as { label?: unknown } | null;
      const estimate = (trip.estimate ?? null) as FareBreakdown | null;
      const estimatedDistanceMeters = Number(trip.estimatedDistanceMeters);
      const estimatedDurationSeconds = Number(trip.estimatedDurationSeconds);
      const distanceToPickupMeters = Number(data.distanceToPickupMeters);
      const notes = (trip.customerPreferences as { notes?: unknown } | null)?.notes;
      const preferences = (trip.customerPreferences ?? null) as { vehicleDescription?: unknown; carType?: unknown; transmission?: unknown } | null;
      return {
        id: assignment.id,
        bookingId,
        bookingReference: typeof trip.reference === 'string' ? trip.reference : bookingId,
        pickup: typeof pickup?.label === 'string' ? pickup.label : 'Pickup details unavailable',
        destination: typeof destination?.label === 'string' ? destination.label : 'Drop-off details unavailable',
        estimate,
        estimatedDistanceMeters: Number.isFinite(estimatedDistanceMeters) ? estimatedDistanceMeters : null,
        estimatedDurationSeconds: Number.isFinite(estimatedDurationSeconds) ? estimatedDurationSeconds : null,
        customerNotes: typeof notes === 'string' ? notes : null,
        vehicleDescription: typeof preferences?.vehicleDescription === 'string' ? preferences.vehicleDescription : null,
        carType: typeof preferences?.carType === 'string' ? preferences.carType : 'either',
        transmission: typeof preferences?.transmission === 'string' ? preferences.transmission : 'either',
        distanceToPickupMeters: Number.isFinite(distanceToPickupMeters) ? distanceToPickupMeters : null,
        offeredAtMs,
        expiresAtMs,
      } satisfies DriverOffer;
    }),
  );
  return rows.filter((row): row is DriverOffer => row !== null).sort((a, b) => b.offeredAtMs - a.offeredAtMs);
}

export function useDriverOffers() {
  const { user } = useSession();
  const client = useQueryClient();
  const queryKey = useMemo(() => ['driverOffers', user?.uid ?? 'anon'], [user?.uid]);

  useEffect(() => {
    if (!user) return undefined;
    const offersQuery = query(
      collectionGroup(firebase().firestore, SUBCOLLECTIONS.driverAssignments),
      where('driverUid', '==', user.uid),
      where('status', '==', 'offered'),
      orderBy('expiresAtMs', 'asc'),
    );
    // Watch the authoritative offer documents directly. Inbox delivery and
    // push notifications are intentionally not prerequisites for dispatch.
    let initialSnapshot = true;
    return onSnapshot(
      offersQuery,
      () => {
        if (initialSnapshot) {
          initialSnapshot = false;
          return;
        }
        void client.invalidateQueries({ queryKey });
      },
      () => void client.invalidateQueries({ queryKey }),
    );
  }, [client, queryKey, user]);

  return useQuery({
    queryKey,
    enabled: Boolean(user),
    queryFn: () => readOffers(firebase(), user!.uid),
    // Offer changes arrive through the Firestore listener above; avoid polling
    // and keep the rendered list stable between live updates.
    staleTime: Infinity,
  });
}

export function useAcceptDutyTerms() {
  const client = useQueryClient();
  const { user } = useSession();
  return useMutation({
    mutationFn: async () => {
      if (user) await user.getIdToken(true);
      return callFunction(firebase(), 'acceptDutyTerms', { version: DUTY_TERMS.version });
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['driverProfile', user?.uid ?? 'anon'] });
      await client.invalidateQueries({ queryKey: ['driverAccess', user?.uid ?? 'anon'] });
    },
  });
}

export function useSetDriverAvailability() {
  const client = useQueryClient();
  const { user } = useSession();
  return useMutation({
    mutationFn: async (state: 'online' | 'offline' | 'break') => {
      if (state !== 'online') {
        return callFunction(firebase(), 'setAvailability', { state });
      }
      if (user) await user.getIdToken(true);
      if (!user) throw new Error('Sign in to DrivX Captain before going online.');
      const pushEnabled = await AsyncStorage.getItem(`drivx.push.enabled.driver.${user.uid}`) === 'true';
      const pushGranted = Platform.OS === 'web'
        ? typeof Notification !== 'undefined' && Notification.permission === 'granted'
        : (await getPermissionsAsync()).granted;
      if (!pushEnabled || !pushGranted) {
        throw new Error('Enable trip push alerts in Account first. Driver offers and trip updates must be able to reach you when DrivX is closed.');
      }
      const permission = await requestForegroundPermissionsAsync();
      if (permission.status !== 'granted') {
        throw new Error('Location permission is required to go online and receive nearby trips.');
      }
      if (Platform.OS !== 'web') {
        const background = await requestBackgroundPermissionsAsync();
        if (background.status !== 'granted') {
          throw new Error('Allow DrivX location access all the time so trip offers and the customer live map keep working when your screen is locked.');
        }
      }
      const fix = await getCurrentPositionAsync({ accuracy: Accuracy.High });
      if (fix.coords.accuracy !== null && fix.coords.accuracy > 100) {
        throw new Error('GPS accuracy is too low. Move to an open area and try again.');
      }
      return callFunction(firebase(), 'setAvailability', {
        state,
        lat: fix.coords.latitude,
        lng: fix.coords.longitude,
        accuracyMeters: fix.coords.accuracy ?? 100,
        fixTimeMs: fix.timestamp,
        headingDegrees: fix.coords.heading,
        speedMps: fix.coords.speed,
      });
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['driverProfile', user?.uid ?? 'anon'] });
      await client.invalidateQueries({ queryKey: ['driverAccess', user?.uid ?? 'anon'] });
    },
  });
}

export function useRespondToDriverOffer() {
  const client = useQueryClient();
  const { user } = useSession();
  return useMutation({
    mutationFn: (input: { bookingId: string; decision: 'accept' | 'decline' }) =>
      callFunction(firebase(), 'respondToAssignment', input),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['driverOffers', user?.uid ?? 'anon'] }),
        client.invalidateQueries({ queryKey: ['driverTrip', user?.uid ?? 'anon'] }),
        client.invalidateQueries({ queryKey: ['driverProfile', user?.uid ?? 'anon'] }),
      ]);
    },
  });
}

/** Keep the driver's fresh position in the dispatch grid or active trip stream. */
export function usePublishDriverLocation(online: boolean, bookingId: string | null) {
  const { user } = useSession();
  const uid = user?.uid ?? null;
  const actualBookingId = bookingId;
  const shouldShare = Boolean(uid && (online || actualBookingId));

  useEffect(() => {
    if (Platform.OS === 'web') {
      if (!shouldShare || !uid || !globalThis.navigator?.geolocation) return undefined;
      let publishing = false;
      const watchId = navigator.geolocation.watchPosition(
        (position) => {
          if (publishing) return;
          publishing = true;
          const { latitude, longitude, accuracy, heading, speed } = position.coords;
          if (accuracy > 100) {
            publishing = false;
            return;
          }
          void callFunction(firebase(), 'publishDriverLocation', {
            bookingId: actualBookingId,
            lat: latitude,
            lng: longitude,
            accuracyMeters: accuracy ?? 100,
            headingDegrees: heading,
            speedMps: speed,
            fixTimeMs: position.timestamp,
          }).catch(() => undefined).finally(() => { publishing = false; });
        },
        () => undefined,
        { enableHighAccuracy: true, maximumAge: 5_000, timeout: 15_000 },
      );
      return () => navigator.geolocation.clearWatch(watchId);
    }
    void syncDriverLocationTask(
      shouldShare && uid
        ? { uid, bookingId: actualBookingId, online }
        : null,
    ).catch(() => undefined);
  }, [actualBookingId, online, shouldShare, uid]);
}

export function driverDispatchError(error: unknown): string {
  if (error instanceof FunctionCallError) return error.message;
  return error instanceof Error ? error.message : 'The dispatch request could not be completed.';
}
