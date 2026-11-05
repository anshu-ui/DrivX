import { getApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import {
  browserLocalPersistence,
  browserSessionPersistence,
  connectAuthEmulator,
  getAuth,
  indexedDBLocalPersistence,
  initializeAuth,
  type Auth,
  type Persistence,
} from 'firebase/auth';
import { connectDatabaseEmulator, getDatabase, type Database } from 'firebase/database';
import { connectFirestoreEmulator, getFirestore, type Firestore } from 'firebase/firestore';
import { connectStorageEmulator, getStorage, type FirebaseStorage } from 'firebase/storage';
import { assertConfigured, EMULATOR_PROJECT_ID, type ClientEnv } from './config';

export { EMULATOR_PROJECT_ID };

export type FirebaseClients = {
  app: FirebaseApp;
  auth: Auth;
  firestore: Firestore;
  database: Database;
  storage: FirebaseStorage;
  env: ClientEnv;
  /** Emulator targets in use, surfaced in the dev banner. */
  emulatorLabels: string[];
};

const EMULATOR_CONFIG = {
  apiKey: 'developer-mode-key',
  authDomain: `${EMULATOR_PROJECT_ID}.firebaseapp.com`,
  projectId: EMULATOR_PROJECT_ID,
  storageBucket: `${EMULATOR_PROJECT_ID}.appspot.com`,
  messagingSenderId: '000000000000',
  appId: '1:0:web:000000000000',
} as const;

let cached: FirebaseClients | null = null;

function label(endpoint: { host: string; port: number } | null): string | null {
  return endpoint ? `${endpoint.host}:${endpoint.port}` : null;
}

export function initFirebase(
  env: ClientEnv,
  /**
   * The JS SDK's default persistence needs `window.localStorage`, which React
   * Native does not provide. The mobile app builds this with
   * `getReactNativePersistence(AsyncStorage)` and passes it in; web callers
   * can leave it out.
   */
  nativePersistence?: Persistence,
): FirebaseClients {
  if (cached) return cached;
  assertConfigured(env);

  const app =
    getApps().length > 0
      ? getApp(getApps()[0]!.name)
      : initializeApp(env.firebase ?? EMULATOR_CONFIG, 'drivx');

  let auth: Auth;
  try {
    auth = initializeAuth(app, {
      persistence:
        nativePersistence ?? [indexedDBLocalPersistence, browserLocalPersistence, browserSessionPersistence],
    });
  } catch {
    // Already initialised for this app instance (hot reload, or SSR re-entry).
    auth = getAuth(app);
  }

  const firestore = getFirestore(app);
  const database = getDatabase(app);
  const storage = getStorage(app);
  const emulatorLabels: string[] = [];

  if (env.useEmulators) {
    if (env.emulator.auth) {
      connectAuthEmulator(auth, `http://${env.emulator.auth.host}:${env.emulator.auth.port}`, {
        disableWarnings: true,
      });
      emulatorLabels.push(`auth@${label(env.emulator.auth)}`);
    }
    if (env.emulator.firestore) {
      connectFirestoreEmulator(firestore, env.emulator.firestore.host, env.emulator.firestore.port);
      emulatorLabels.push(`firestore@${label(env.emulator.firestore)}`);
    }
    if (env.emulator.database) {
      connectDatabaseEmulator(database, env.emulator.database.host, env.emulator.database.port);
      emulatorLabels.push(`database@${label(env.emulator.database)}`);
    }
    if (env.emulator.storage) {
      connectStorageEmulator(storage, env.emulator.storage.host, env.emulator.storage.port);
      emulatorLabels.push(`storage@${label(env.emulator.storage)}`);
    }
  }

  cached = { app, auth, firestore, database, storage, env, emulatorLabels };
  return cached;
}

/** Test seam: drop the singleton so a suite can re-init per case. */
export function resetFirebaseClients(): void {
  cached = null;
}

/** True when the app is talking to local emulators rather than a live project. */
export function isEmulatorMode(clients: FirebaseClients): boolean {
  return clients.env.useEmulators;
}
