/**
 * Firebase client configuration.
 *
 * Nothing here contains a real credential. Values come from the app's
 * environment, and every consumer must handle the "not configured" state by
 * pointing at the emulator instead of silently failing.
 */

export type FirebaseProjectConfig = {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
  measurementId?: string;
  /** Required for @react-native-firebase and Android builds. */
  storageBucketUrl?: string;
  /**
   * Realtime Database instance URL, which live driver location needs. Left out,
   * the SDK guesses `<projectId>-default-rtdb.firebaseio.com` — wrong for a
   * named or non-default instance, so spell it out in the environment.
   */
  databaseURL?: string;
};

export type EmulatorEndpoints = {
  firestore: { host: string; port: number } | null;
  database: { host: string; port: number } | null;
  auth: { host: string; port: number } | null;
  functions: { host: string; port: number } | null;
  storage: { host: string; port: number } | null;
};

export type ClientEnv = {
  firebase: FirebaseProjectConfig | null;
  emulator: EmulatorEndpoints;
  useEmulators: boolean;
  region: string;
  /** Google Maps web key — admin dashboard only, never bundled into mobile. */
  googleMapsWebKey: string | null;
  functionsBaseURL: string | null;
};

const ENV_PREFIX = 'EXPO_PUBLIC_';

/**
 * The project id the emulator suite runs under, which is what `.firebaserc`
 * declares and what `npm run seed` writes. Apps in emulator mode must use it —
 * see `resolveProject` below for why the mismatch is invisible.
 */
export const EMULATOR_PROJECT_ID = 'drivx-local';

function read(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function isTruthy(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}

/**
 * In emulator mode the project id has to be the emulator's, even when a real
 * project's keys are present in the environment.
 *
 * The Firestore, Realtime Database and Storage emulators each namespace their
 * data by project id, so an app pointed at a live project id reads an empty
 * database while `npm run seed` fills `drivx-local`. The Auth emulator is not
 * namespaced, so sign-in keeps working and the app renders a logged-in shell
 * with nothing in it — which reads as an empty product rather than a
 * misconfiguration. Flipping `FIREBASE_EMULATOR=false` restores the live ids.
 */
export function resolveProject(
  firebase: FirebaseProjectConfig | null,
  useEmulators: boolean,
  override?: string,
): FirebaseProjectConfig | null {
  if (!firebase || !useEmulators) return firebase;
  const projectId = override && override.length > 0 ? override : EMULATOR_PROJECT_ID;
  return {
    ...firebase,
    projectId,
    authDomain: `${projectId}.firebaseapp.com`,
    storageBucket: `${projectId}.appspot.com`,
    // Same reason as the rewrites above: an emulator build carries no live
    // addresses, so nothing can reach the production instance by accident.
    databaseURL: undefined,
  };
}

/**
 * Assembles client config from a flat env record. Defaults to emulator mode
 * when no Firebase project is configured, so a fresh clone runs without keys.
 */
export function buildClientEnv(source: Record<string, string | undefined> = {}): ClientEnv {
  // Callers hand over either the Expo-prefixed names (mobile) or the plain ones
  // (admin). An absent value has to stay undefined: inventing one here reads as a
  // configured project, which silently switches the app off the emulator.
  const get = (key: string): string | undefined =>
    read(source[`${ENV_PREFIX}${key}`]) ?? read(source[key]);

  const apiKey = get('FIREBASE_API_KEY');
  const projectId = get('FIREBASE_PROJECT_ID');
  const appId = get('FIREBASE_APP_ID');

  const firebase: FirebaseProjectConfig | null =
    apiKey && projectId && appId
      ? {
          apiKey,
          appId,
          projectId,
          authDomain: get('FIREBASE_AUTH_DOMAIN') ?? `${projectId}.firebaseapp.com`,
          storageBucket: get('FIREBASE_STORAGE_BUCKET') ?? `${projectId}.appspot.com`,
          messagingSenderId: get('FIREBASE_MESSAGING_SENDER_ID') ?? '',
          databaseURL: get('FIREBASE_DATABASE_URL'),
        }
      : null;

  const host = get('FIREBASE_EMULATOR_HOST') ?? '127.0.0.1';
  const wantEmulators = isTruthy(get('FIREBASE_EMULATOR')) || firebase === null;

  return {
    firebase: resolveProject(firebase, wantEmulators, get('FIREBASE_EMULATOR_PROJECT_ID')),
    useEmulators: wantEmulators,
    region: get('FIREBASE_FUNCTIONS_REGION') ?? 'asia-south1',
    googleMapsWebKey: get('GOOGLE_MAPS_WEB_API_KEY') ?? null,
    functionsBaseURL: get('FUNCTIONS_BASE_URL') ?? null,
    emulator: {
      firestore: wantEmulators ? { host, port: Number(get('FIRESTORE_EMULATOR_PORT') ?? 8080) } : null,
      database: wantEmulators ? { host, port: Number(get('RTDB_EMULATOR_PORT') ?? 9000) } : null,
      auth: wantEmulators ? { host, port: Number(get('AUTH_EMULATOR_PORT') ?? 9099) } : null,
      functions: wantEmulators ? { host, port: Number(get('FUNCTIONS_EMULATOR_PORT') ?? 5001) } : null,
      storage: wantEmulators ? { host, port: Number(get('STORAGE_EMULATOR_PORT') ?? 9199) } : null,
    },
  };
}

/** Thrown when a real integration is attempted without its prerequisites. */
export class FirebaseNotConfiguredError extends Error {
  constructor(missing: string[]) {
    super(
      `Firebase is not configured. Missing: ${missing.join(', ')}. ` +
        `Start the emulator suite (npm run emulators) or add the values to apps/mobile/.env.`,
    );
    this.name = 'FirebaseNotConfiguredError';
  }
}

export function assertConfigured(env: ClientEnv): void {
  if (env.useEmulators) return;
  if (!env.firebase) {
    throw new FirebaseNotConfiguredError(['FIREBASE_API_KEY', 'FIREBASE_PROJECT_ID', 'FIREBASE_APP_ID']);
  }
}
