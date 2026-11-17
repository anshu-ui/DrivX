import { useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  AndroidImportance,
  addNotificationResponseReceivedListener,
  clearLastNotificationResponseAsync,
  getLastNotificationResponseAsync,
  getPermissionsAsync,
  requestPermissionsAsync,
  scheduleNotificationAsync,
  setNotificationChannelAsync,
  setNotificationHandler,
} from 'expo-notifications';
import { router, type Href } from 'expo-router';
import { Platform } from 'react-native';
import type { User } from 'firebase/auth';
import { deleteToken, getMessaging, getToken, onMessage, onTokenRefresh, registerDeviceForRemoteMessages } from '@react-native-firebase/messaging';
import { getMessaging as getWebMessaging, getToken as getWebToken, isSupported as isWebMessagingSupported, onMessage as onWebMessage, deleteToken as deleteWebToken } from 'firebase/messaging';
import { callFunction } from '@drivx/firebase-client';
import { firebase } from '../../lib/firebase';
import type { AppSurface } from '../../lib/appSurface';

type NotificationSurface = Exclude<AppSurface, null>;
const preferenceKey = (uid: string, surface: NotificationSurface) => `drivx.push.enabled.${surface}.${uid}`;
const legacyPreferenceKey = (uid: string) => `drivx.push.enabled.${uid}`;
let lastOpenedNotificationId: string | null = null;

/** Move existing opt-ins to the new per-app setting without prompting again. */
export async function pushPreferenceEnabled(uid: string, surface: NotificationSurface): Promise<boolean> {
  if (await AsyncStorage.getItem(preferenceKey(uid, surface)) === 'true') return true;
  if (await AsyncStorage.getItem(legacyPreferenceKey(uid)) !== 'true') return false;
  await AsyncStorage.setItem(preferenceKey(uid, surface), 'true');
  return true;
}

function openNotificationRoute(response: NonNullable<Awaited<ReturnType<typeof getLastNotificationResponseAsync>>>) {
  const request = response.notification.request;
  const requestId = request.identifier;
  if (requestId && requestId === lastOpenedNotificationId) return;
  lastOpenedNotificationId = requestId || null;
  const route = request.content.data?.route;
  if (typeof route === 'string' && route.startsWith('/') && !route.startsWith('//')) {
    router.push(route as Href);
  }
  void clearLastNotificationResponseAsync().catch(() => undefined);
}

setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

async function registerToken(user: User, token: string, surface: NotificationSurface) {
  await callFunction(firebase(), 'registerDeviceToken', {
    token,
    platform: Platform.OS === 'web' ? 'web' : Platform.OS === 'ios' ? 'ios' : 'android',
    surface,
  });
}

async function webMessagingAndToken(requestPermission: boolean, appRole: NotificationSurface): Promise<{ messaging: ReturnType<typeof getWebMessaging>; token: string }> {
  if (!(await isWebMessagingSupported())) throw new Error('This browser does not support Firebase push notifications.');
  if (!('Notification' in globalThis)) throw new Error('This browser does not support notifications.');
  let permission = Notification.permission;
  if (permission !== 'granted' && requestPermission) permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Allow notifications in your browser settings, then try again.');
  const vapidKey = process.env.EXPO_PUBLIC_FIREBASE_VAPID_KEY
    || (window as Window & { DRIVX_FIREBASE_CONFIG?: { vapidKey?: string } }).DRIVX_FIREBASE_CONFIG?.vapidKey;
  if (!vapidKey) throw new Error('Web push is not configured yet. Add the Firebase Web Push public key and reload DrivX.');
  if (!('serviceWorker' in navigator)) throw new Error('This browser cannot register the DrivX notification worker.');
  const workerPath = `/${appRole}/firebase-messaging-sw.js`;
  const registration = await navigator.serviceWorker.register(workerPath);
  await navigator.serviceWorker.ready;
  const messaging = getWebMessaging(firebase().app);
  const token = await getWebToken(messaging, { vapidKey, serviceWorkerRegistration: registration });
  if (token.length < 20) throw new Error('Firebase did not return a valid browser push token.');
  return { messaging, token };
}

async function currentDeviceToken(requestPermission: boolean, surface: NotificationSurface): Promise<string> {
  if (Platform.OS === 'web') {
    return (await webMessagingAndToken(requestPermission, surface)).token;
  }
  if (Platform.OS === 'android') {
    await setNotificationChannelAsync('bookings', {
      name: 'Trip updates',
      importance: AndroidImportance.MAX,
      vibrationPattern: [0, 250, 200, 250],
      sound: 'default',
    });
  }
  let permission = await getPermissionsAsync();
  if (!permission.granted && requestPermission) permission = await requestPermissionsAsync();
  if (!permission.granted) throw new Error('Notification permission is off. Enable it in Android Settings to receive trip alerts.');
  const messaging = getMessaging();
  if (Platform.OS === 'ios' && !messaging.isDeviceRegisteredForRemoteMessages) {
    await registerDeviceForRemoteMessages(messaging);
  }
  const token = await getToken(messaging);
  if (token.length < 20) throw new Error('Firebase did not return a valid push token.');
  return token;
}

/** Called only from the user's explicit Enable action in Account. */
export async function enablePushNotifications(user: User, surface: NotificationSurface): Promise<void> {
  const token = await currentDeviceToken(true, surface);
  await registerToken(user, token, surface);
  await AsyncStorage.setItem(preferenceKey(user.uid, surface), 'true');
  if (Platform.OS === 'web' && typeof window !== 'undefined') window.dispatchEvent(new Event('drivx:push-preference-changed'));
}

export async function disablePushNotifications(user: User, surface: NotificationSurface): Promise<void> {
  const token = Platform.OS === 'web'
    ? await currentDeviceToken(false, surface)
    : await currentDeviceToken(false, surface).catch(() => '');
  if (token) await callFunction(firebase(), 'unregisterDeviceToken', { token, surface });
  await AsyncStorage.removeItem(preferenceKey(user.uid, surface));
  await AsyncStorage.removeItem(legacyPreferenceKey(user.uid));
  if (Platform.OS !== 'web') await deleteToken(getMessaging());
  else if (token) await deleteWebToken(getWebMessaging(firebase().app));
  if (Platform.OS === 'web' && typeof window !== 'undefined') window.dispatchEvent(new Event('drivx:push-preference-changed'));
}

/** Re-register an opted-in device when the app opens or its FCM token rotates. */
export function usePushRegistrationSync(user: User | null, surface: NotificationSurface) {
  useEffect(() => {
    if (!user) return undefined;
    let active = true;
    if (Platform.OS === 'web') {
      let stopMessage: (() => void) | undefined;
      const syncWebPush = async () => {
        stopMessage?.();
        stopMessage = undefined;
        const enabled = await pushPreferenceEnabled(user.uid, surface);
        if (!active || !enabled || !('Notification' in globalThis) || Notification.permission !== 'granted') return;
        const { messaging, token } = await webMessagingAndToken(false, surface);
        if (!active) return;
        await registerToken(user, token, surface);
        stopMessage = onWebMessage(messaging, (message) => {
          if (!active || Notification.permission !== 'granted') return;
          const title = message.notification?.title ?? 'DrivX update';
          const body = message.notification?.body ?? 'There is an update to your booking.';
          try {
            const notification = new Notification(title, { body, icon: '/favicon.ico', data: message.data });
            notification.onclick = () => {
              const route = typeof message.data?.route === 'string' ? message.data.route : '/';
          const base = `/${surface}`;
              const targetPath = route === '/' ? `${base}/` : route.startsWith(`${base}/`) ? route : `${base}${route.startsWith('/') ? route : `/${route}`}`;
              window.location.assign(new URL(targetPath, window.location.origin).href);
            };
          } catch { /* Inbox remains available. */ }
        });
      };
      const onPreferenceChanged = () => void syncWebPush().catch(() => undefined);
      void syncWebPush().catch(() => undefined);
      window.addEventListener('drivx:push-preference-changed', onPreferenceChanged);
      return () => {
        active = false;
        window.removeEventListener('drivx:push-preference-changed', onPreferenceChanged);
        stopMessage?.();
      };
    }
    const sync = async (token?: string) => {
      if (!await pushPreferenceEnabled(user.uid, surface)) return;
      const resolved = token ?? await currentDeviceToken(false, surface);
      if (active) await registerToken(user, resolved, surface);
    };
    void sync().catch(() => undefined);
    const messaging = getMessaging();
    const stopToken = onTokenRefresh(messaging, (token) => void sync(token).catch(() => undefined));
    const stopMessage = onMessage(messaging, (message) => {
      const title = message.notification?.title ?? 'DrivX update';
      const body = message.notification?.body ?? 'There is an update to your booking.';
      void scheduleNotificationAsync({ content: { title, body, data: message.data }, trigger: null }).catch(() => undefined);
    });
    const stopResponse = addNotificationResponseReceivedListener(openNotificationRoute);
    void getLastNotificationResponseAsync().then((response) => {
      if (response) openNotificationRoute(response);
    }).catch(() => undefined);
    return () => {
      active = false;
      stopToken();
      stopMessage();
      stopResponse.remove();
    };
  }, [user, surface]);
}
