import { useEffect, useState } from 'react';
import * as Location from 'expo-location';
import { Platform } from 'react-native';
import { onValue, ref } from 'firebase/database';
import { RTDB_PATHS, RTDB_RETENTION } from '@drivx/domain';
import { callFunction } from '@drivx/firebase-client';
import { firebase } from '../../lib/firebase';
import { useSession } from '../auth/AuthProvider';

export type LiveDriverFix = {
  lat: number;
  lng: number;
  receivedAtMs: number;
  accuracyMeters: number | null;
  stale: boolean;
};

/** The active booking stream is readable only to its customer, assigned driver and staff. */
export function useLiveDriverFix(bookingId: string | undefined, enabled: boolean): LiveDriverFix | null {
  const [state, setState] = useState<{ key: string; fix: LiveDriverFix | null }>({ key: '', fix: null });
  const key = `${bookingId ?? ''}:${enabled ? 'on' : 'off'}`;

  useEffect(() => {
    if (!bookingId || !enabled) return undefined;

    return onValue(
      ref(firebase().database, RTDB_PATHS.activeBooking(bookingId)),
      (snapshot) => {
        const location = snapshot.val()?.location as Record<string, unknown> | null | undefined;
        if (
          !location ||
          typeof location.lat !== 'number' ||
          typeof location.lng !== 'number' ||
          typeof location.receivedAtMs !== 'number'
        ) {
          setState({ key, fix: null });
          return;
        }
        setState({
          key,
          fix: {
            lat: location.lat,
            lng: location.lng,
            receivedAtMs: location.receivedAtMs,
            accuracyMeters: typeof location.accuracyMeters === 'number' ? location.accuracyMeters : null,
            stale: Date.now() - location.receivedAtMs > RTDB_RETENTION.staleAfterMs,
          },
        });
      },
      () => setState({ key, fix: null }),
    );
  }, [bookingId, enabled, key]);

  return state.key === key ? state.fix : null;
}

/** Customer position is sent only on an active trip screen and only to the assigned booking. */
export function usePublishCustomerLocation(bookingId: string | undefined, enabled: boolean): void {
  const { user } = useSession();
  useEffect(() => {
    if (!bookingId || !enabled || !user) return undefined;
    let active = true;
    let lastSentAt = 0;
    let publishing = false;
    const publish = (coords: { latitude: number; longitude: number; accuracy?: number | null; heading?: number | null; speed?: number | null }, timestamp: number) => {
      if (!active || publishing || Date.now() - lastSentAt < 5_000) return;
      const accuracy = coords.accuracy ?? 100;
      if (accuracy > 100) return;
      publishing = true;
      void callFunction(firebase(), 'publishCustomerLocation', {
        bookingId,
        lat: coords.latitude,
        lng: coords.longitude,
        accuracyMeters: accuracy,
        headingDegrees: coords.heading ?? null,
        speedMps: coords.speed ?? null,
        fixTimeMs: timestamp,
      }).catch(() => undefined).finally(() => {
        lastSentAt = Date.now();
        publishing = false;
      });
    };

    if (Platform.OS === 'web') {
      if (!globalThis.navigator?.geolocation) return undefined;
      const watchId = navigator.geolocation.watchPosition(
        (position) => publish(position.coords, position.timestamp),
        () => undefined,
        { enableHighAccuracy: true, maximumAge: 5_000, timeout: 15_000 },
      );
      return () => { active = false; navigator.geolocation.clearWatch(watchId); };
    }

    let subscription: Location.LocationSubscription | null = null;
    void Location.requestForegroundPermissionsAsync().then(async ({ granted }) => {
      if (!granted || !active) return;
      subscription = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, timeInterval: 5_000, distanceInterval: 20 },
        (position) => publish(position.coords, position.timestamp),
      );
      if (!active) subscription.remove();
    }).catch(() => undefined);
    return () => { active = false; subscription?.remove(); };
  }, [bookingId, enabled, user]);
}

/** Assigned driver reads the customer's guarded live fix from the active booking. */
export function useLiveCustomerFix(bookingId: string | undefined, enabled: boolean): LiveDriverFix | null {
  const [state, setState] = useState<{ key: string; fix: LiveDriverFix | null }>({ key: '', fix: null });
  const key = `${bookingId ?? ''}:${enabled ? 'on' : 'off'}`;
  useEffect(() => {
    if (!bookingId || !enabled) return undefined;
    return onValue(ref(firebase().database, `${RTDB_PATHS.activeBooking(bookingId)}/customerLocation`), (snapshot) => {
      const location = snapshot.val() as Record<string, unknown> | null;
      if (!location || typeof location.lat !== 'number' || typeof location.lng !== 'number' || typeof location.receivedAtMs !== 'number') {
        setState({ key, fix: null });
        return;
      }
      setState({ key, fix: {
        lat: location.lat,
        lng: location.lng,
        receivedAtMs: location.receivedAtMs,
        accuracyMeters: typeof location.accuracyMeters === 'number' ? location.accuracyMeters : null,
        stale: Date.now() - location.receivedAtMs > RTDB_RETENTION.staleAfterMs,
      } });
    }, () => setState({ key, fix: null }));
  }, [bookingId, enabled, key]);
  return state.key === key ? state.fix : null;
}
