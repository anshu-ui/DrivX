import 'react-native-get-random-values';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getReactNativePersistence } from 'firebase/auth';
import { Platform } from 'react-native';
import { initFirebase, DrivXAuth, type FirebaseClients } from '@drivx/firebase-client';
import { mobileEnv } from './env';
import { createNativePhoneVerifier } from './nativePhoneVerifier';

/**
 * Single Firebase instance for the app.
 *
 * `react-native-get-random-values` is imported first because the Firestore and
 * Auth transports call `crypto.getRandomValues` during construction. The JS SDK
 * needs an explicit persistence backend on React Native, which is why
 * AsyncStorage is handed in here rather than at the call site.
 */
let clients: FirebaseClients | null = null;

export function firebase(): FirebaseClients {
  if (!clients) {
    clients = initFirebase(
      mobileEnv(),
      // `getReactNativePersistence` only exists in the React Native build of
      // `firebase/auth`; the browser build Metro picks for the web target does
      // not export it. On web the SDK's own indexedDB/localStorage default is
      // the right persistence, so nothing is passed.
      Platform.OS === 'web' ? undefined : getReactNativePersistence(AsyncStorage),
    );
  }
  return clients;
}

let authApi: DrivXAuth | null = null;

export function drivxAuth(): DrivXAuth {
  if (!authApi) {
    const clients = firebase();
    authApi = new DrivXAuth(
      clients,
      Platform.OS === 'web' || clients.env.useEmulators
        ? undefined
        : createNativePhoneVerifier(clients),
    );
  }
  return authApi;
}
