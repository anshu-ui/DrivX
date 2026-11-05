import { DrivXAuth, initFirebase, type FirebaseClients } from '@drivx/firebase-client';
import { adminEnv } from './env';

/**
 * One Firebase client for the console, created on demand in the browser.
 *
 * `initFirebase` calls `initializeAuth`, which needs a DOM persistence backend,
 * so nothing here may run during a server render — every caller reaches it from
 * an effect or a click handler, never at module scope.
 */
let clients: FirebaseClients | null = null;

export function firebaseClients(): FirebaseClients {
  if (!clients) clients = initFirebase(adminEnv());
  return clients;
}

let auth: DrivXAuth | null = null;

/**
 * The same auth surface the mobile app uses, so the console cannot grow its own
 * sign-in path. `emailPasswordSignIn` works against the live project too: the
 * staff account and its admin claim are created server-side by
 * `scripts/provision-live.mjs`, so this form can only prove a password someone
 * already has — it can never hand out a role.
 */
export function consoleAuth(): DrivXAuth {
  if (!auth) auth = new DrivXAuth(firebaseClients());
  return auth;
}
