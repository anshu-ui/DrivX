import { buildClientEnv, type ClientEnv } from '@drivx/firebase-client';

/**
 * The console's Firebase config, read the only way Next.js can deliver it.
 *
 * Next replaces `process.env.NEXT_PUBLIC_*` with a literal string when it builds
 * the browser bundle, and it can only do that for references it can see written
 * out. Indexing `process.env` with a computed key — `source[`NEXT_PUBLIC_${name}`]`
 * — leaves the whole object unresolved in the browser, so every value arrives as
 * `undefined`. `buildClientEnv` then reports an unconfigured project and switches
 * to the emulator by design, which is how this console came to show a server-rendered
 * "live · drivx-116de" banner while the code running on screen signed people in
 * through `127.0.0.1:9099` with `developer-mode-key`. Each line below is therefore
 * load-bearing: add a new value by writing it out, never by looping over names.
 */
function source(): Record<string, string | undefined> {
  return {
    FIREBASE_API_KEY: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    FIREBASE_PROJECT_ID: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    FIREBASE_APP_ID: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
    FIREBASE_AUTH_DOMAIN: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    FIREBASE_STORAGE_BUCKET: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    FIREBASE_MESSAGING_SENDER_ID: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    FIREBASE_DATABASE_URL: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL,
    FIREBASE_EMULATOR: process.env.NEXT_PUBLIC_FIREBASE_EMULATOR,
    FIREBASE_EMULATOR_HOST: process.env.NEXT_PUBLIC_FIREBASE_EMULATOR_HOST,
    FIRESTORE_EMULATOR_PORT: process.env.NEXT_PUBLIC_FIRESTORE_EMULATOR_PORT,
    RTDB_EMULATOR_PORT: process.env.NEXT_PUBLIC_RTDB_EMULATOR_PORT,
    AUTH_EMULATOR_PORT: process.env.NEXT_PUBLIC_AUTH_EMULATOR_PORT,
    FUNCTIONS_EMULATOR_PORT: process.env.NEXT_PUBLIC_FUNCTIONS_EMULATOR_PORT,
    STORAGE_EMULATOR_PORT: process.env.NEXT_PUBLIC_STORAGE_EMULATOR_PORT,
    FIREBASE_FUNCTIONS_REGION: process.env.NEXT_PUBLIC_FIREBASE_FUNCTIONS_REGION,
    GOOGLE_MAPS_WEB_API_KEY: process.env.NEXT_PUBLIC_GOOGLE_MAPS_WEB_API_KEY,
    FUNCTIONS_BASE_URL: process.env.NEXT_PUBLIC_FUNCTIONS_BASE_URL,
  };
}

export function adminEnv(): ClientEnv {
  return buildClientEnv(source());
}
