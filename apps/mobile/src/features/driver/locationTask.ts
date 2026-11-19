import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  Accuracy,
  hasStartedLocationUpdatesAsync,
  startLocationUpdatesAsync,
  stopLocationUpdatesAsync,
  type LocationObject,
} from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import { callFunction } from '@drivx/firebase-client';
import { firebase } from '../../lib/firebase';

export const DRIVER_LOCATION_TASK = 'drivx-driver-live-location';
const LOCATION_TASK_REVISION = 2;
const preferenceKey = (uid: string) => `drivx.driver.location.${uid}`;

type LocationState = { uid: string; bookingId: string | null; online: boolean };

if (!TaskManager.isTaskDefined(DRIVER_LOCATION_TASK)) {
  TaskManager.defineTask(DRIVER_LOCATION_TASK, async ({ data, error }) => {
    if (error || !data) return;
    const locations = (data as { locations?: LocationObject[] }).locations;
    const fix = locations?.at(-1);
    if (!fix) return;

    try {
      const user = firebase().auth.currentUser;
      if (!user) return;
      const saved = await AsyncStorage.getItem(preferenceKey(user.uid));
      if (!saved) return;
      const state = JSON.parse(saved) as LocationState;
      if (state.uid !== user.uid || (!state.online && !state.bookingId)) return;
      await callFunction(firebase(), 'publishDriverLocation', {
        bookingId: state.bookingId,
        lat: fix.coords.latitude,
        lng: fix.coords.longitude,
        accuracyMeters: fix.coords.accuracy ?? 5_000,
        headingDegrees: fix.coords.heading,
        speedMps: fix.coords.speed,
        fixTimeMs: fix.timestamp,
      });
    } catch {
      // A transient network or auth race must not stop the OS location service.
      // The next GPS fix retries; the customer UI calls stale positions out.
    }
  });
}

/** Keep a native foreground service alive while the driver is online/on-trip. */
export async function syncDriverLocationTask(state: LocationState | null): Promise<void> {
  if (Platform.OS === 'web') return;
  const registered = await hasStartedLocationUpdatesAsync(DRIVER_LOCATION_TASK);
  if (!state || (!state.online && !state.bookingId)) {
    if (registered) await stopLocationUpdatesAsync(DRIVER_LOCATION_TASK);
    if (state?.uid) await AsyncStorage.removeItem(preferenceKey(state.uid));
    return;
  }

  const saved = JSON.stringify({ ...state, revision: LOCATION_TASK_REVISION });
  const previous = await AsyncStorage.getItem(preferenceKey(state.uid));
  await AsyncStorage.setItem(preferenceKey(state.uid), saved);
  // Keep the foreground service running across ordinary app closure. Restart
  // only when duty/trip mode changes, so an assignment does not leave a GPS gap.
  if (registered && previous === saved) return;
  if (registered) await stopLocationUpdatesAsync(DRIVER_LOCATION_TASK);
  await startLocationUpdatesAsync(DRIVER_LOCATION_TASK, {
    accuracy: state.bookingId ? Accuracy.High : Accuracy.Balanced,
    timeInterval: state.bookingId ? 5_000 : 15_000,
    distanceInterval: state.bookingId ? 10 : 20,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'DrivX driver location is active',
      notificationBody: state.bookingId
        ? 'Sharing your live position for this trip. Finish the trip before going offline.'
        : 'Sharing your live position while you are online. Go offline in DrivX to stop sharing.',
      notificationColor: '#2563EB',
      killServiceOnDestroy: false,
    },
  });
}
