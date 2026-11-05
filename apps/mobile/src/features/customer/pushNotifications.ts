import { useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  AndroidImportance,
  getPermissionsAsync,
  requestPermissionsAsync,
  scheduleNotificationAsync,
  setNotificationChannelAsync,
  setNotificationHandler,
} from 'expo-notifications';
import { Platform } from 'react-native';
import type { User } from 'firebase/auth';
import { deleteToken, getMessaging, getToken, onMessage, onTokenRefresh, registerDeviceForRemoteMessages } from '@react-native-firebase/messaging';
import { getMessaging as getWebMessaging, getToken as getWebToken, isSupported as isWebMessagingSupported, onMessage as onWebMessage, deleteToken as deleteWebToken } from 'firebase/messaging';
import { callFunction } from '@drivx/firebase-client';
import { firebase } from '../../lib/firebase';

const preferenceKey = (uid: string) => `drivx.push.enabled.${uid}`;

setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

async function registerToken(user: User, token: string) {
  await callFunction(firebase(), 'registerDeviceToken', {
    token,
    platform: Platform.OS === 'web' ? 'web' : Platform.OS === 'ios' ? 'ios' : 'android',
  });
}

async function webMessagingAndToken(requestPermission: boolean): Promise<{ messaging: ReturnType<typeof getWebMessaging>; token: string }> {
  if (!(await isWebMessagingSupported())) throw new Error('This browser does not support Firebase push notifications.');
  if (!('Notification' in globalThis)) throw new Error('This browser does not support notifications.');
  let permission = Notification.permission;
  if (permission !== 'granted' && requestPermission) permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Allow notifications in your browser settings, then try again.');
  const vapidKey = process.env.EXPO_PUBLIC_FIREBASE_VAPID_KEY
    || (window as Window & { DRIVX_FIREBASE_CONFIG?: { vapidKey?: string } }).DRIVX_FIREBASE_CONFIG?.vapidKey;
  if (!vapidKey) throw new Error('Web push is not configured yet. Add the Firebase Web Push public key and reload DrivX.');
  if (!('serviceWorker' in navigator)) throw new Error('This browser cannot register the DrivX notification worker.');
  const surface = window.location.pathname.split('/').filter(Boolean)[0];
  const workerPath = ['customer', 'driver', 'admin'].includes(surface ?? '')
    ? `/${surface}/firebase-messaging-sw.js`
    : '/firebase-messaging-sw.js';
  const registration = await navigator.serviceWorker.register(workerPath);
  await navigator.serviceWorker.ready;
  const messaging = getWebMessaging(firebase().app);
  const token = await getWebToken(messaging, { vapidKey, serviceWorkerRegistration: registration });
  if (token.length < 20) throw new Error('Firebase did not return a valid browser push token.');
  return { messaging, token };
}

async function currentDeviceToken(requestPermission = true): Promise<string> {
  if (Platform.OS === 'web') {
    return (await webMessagingAndToken(requestPermission)).token;
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
export async function enablePushNotifications(user: User): Promise<void> {
  const token = await currentDeviceToken();
  await registerToken(user, token);
  await AsyncStorage.setItem(preferenceKey(user.uid), 'true');
  if (Platform.OS === 'web' && typeof window !== 'undefined') window.dispatchEvent(new Event('drivx:push-preference-changed'));
}

export async function disablePushNotifications(user: User): Promise<void> {
  const token = Platform.OS === 'web'
    ? await currentDeviceToken(false)
    : await currentDeviceToken(false).catch(() => '');
  if (token) await callFunction(firebase(), 'unregisterDeviceToken', { token });
  await AsyncStorage.removeItem(preferenceKey(user.uid));
  if (Platform.OS !== 'web') await deleteToken(getMessaging());
  else if (token) await deleteWebToken(getWebMessaging(firebase().app));
  if (Platform.OS === 'web' && typeof window !== 'undefined') window.dispatchEvent(new Event('drivx:push-preference-changed'));
}

/** Re-register an opted-in device when the app opens or its FCM token rotates. */
export function usePushRegistrationSync(user: User | null) {
  useEffect(() => {
    if (!user) return undefined;
    let active = true;
    if (Platform.OS === 'web') {
      let stopMessage: (() => void) | undefined;
      const syncWebPush = async () => {
        stopMessage?.();
        stopMessage = undefined;
        const enabled = await AsyncStorage.getItem(preferenceKey(user.uid));
        if (!active || enabled !== 'true' || !('Notification' in globalThis) || Notification.permission !== 'granted') return;
        const { messaging, token } = await webMessagingAndToken(false);
        if (!active) return;
        await registerToken(user, token);
        stopMessage = onWebMessage(messaging, (message) => {
          if (!active || Notification.permission !== 'granted') return;
          const title = message.notification?.title ?? 'DrivX update';
          const body = message.notification?.body ?? 'There is an update to your booking.';
          try { new Notification(title, { body, icon: '/favicon.ico', data: message.data }); } catch { /* Inbox remains available. */ }
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
      if (await AsyncStorage.getItem(preferenceKey(user.uid)) !== 'true') return;
      const resolved = token ?? await currentDeviceToken(false);
      if (active) await registerToken(user, resolved);
    };
    void sync().catch(() => undefined);
    const messaging = getMessaging();
    const stopToken = onTokenRefresh(messaging, (token) => void sync(token).catch(() => undefined));
    const stopMessage = onMessage(messaging, (message) => {
      const title = message.notification?.title ?? 'DrivX update';
      const body = message.notification?.body ?? 'There is an update to your booking.';
      void scheduleNotificationAsync({ content: { title, body, data: message.data }, trigger: null }).catch(() => undefined);
    });
    return () => {
      active = false;
      stopToken();
      stopMessage();
    };
  }, [user]);
}
