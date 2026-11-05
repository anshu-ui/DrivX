import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  initializeTestEnvironment,
  type RulesTestContext,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';

/**
 * Emulator-based security rules tests.
 *
 * These run against `firebase emulators:start`, so they exercise the exact rule
 * language the production project will use. Nothing here passes without a live
 * emulator: if the suite is started without one it fails loudly instead of
 * reporting a green run that never happened.
 */

const RULES_DIR = fileURLToPath(new URL('../../../firebase/', import.meta.url));

export const TEST_PROJECT = 'drivx-rules-test';

/** Storage rules match /b/{bucket}/o, so the emulator bucket name is arbitrary. */
export const BUCKET_URL = `gs://${TEST_PROJECT}.appspot.com`;

function port(name: string, fallback: number): number {
  const raw = process.env[name];
  return raw && raw.trim() ? Number(raw) : fallback;
}

const HOST = process.env.FIREBASE_EMULATOR_HOST ?? '127.0.0.1';

export const EMULATORS = {
  firestore: { host: HOST, port: port('FIRESTORE_EMULATOR_PORT', 8080) },
  database: { host: HOST, port: port('RTDB_EMULATOR_PORT', 9000) },
  storage: { host: HOST, port: port('STORAGE_EMULATOR_PORT', 9199) },
};

function reachable(target: { host: string; port: number }): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: target.host, port: target.port });
    socket.setTimeout(750);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

/** Starts the suite only when every emulator the tests touch is actually up. */
export async function createTestEnvironment(): Promise<RulesTestEnvironment> {
  const checks = await Promise.all([
    reachable(EMULATORS.firestore),
    reachable(EMULATORS.database),
    reachable(EMULATORS.storage),
  ]);
  if (checks.some((ok) => !ok)) {
    throw new Error(
      'Firebase emulator suite is not reachable on ' +
        `${EMULATORS.firestore.host} (firestore ${EMULATORS.firestore.port}, ` +
        `database ${EMULATORS.database.port}, storage ${EMULATORS.storage.port}). ` +
        `Start it with \`npm run emulators\`. The emulator requires a JDK, and firebase-tools ` +
        '15 refuses anything below Java 21.',
    );
  }

  return initializeTestEnvironment({
    projectId: TEST_PROJECT,
    firestore: {
      host: EMULATORS.firestore.host,
      port: EMULATORS.firestore.port,
      rules: readFileSync(`${RULES_DIR}firestore.rules`, 'utf8'),
    },
    database: {
      host: EMULATORS.database.host,
      port: EMULATORS.database.port,
      rules: readFileSync(`${RULES_DIR}database.rules.json`, 'utf8'),
    },
    storage: {
      host: EMULATORS.storage.host,
      port: EMULATORS.storage.port,
      rules: readFileSync(`${RULES_DIR}storage.rules`, 'utf8'),
    },
  });
}

/** A Firestore document path: at least one segment, spreadable into `doc()`. */
export type DocPath = [string, ...string[]];

/**
 * Fixtures live under a per-run uid namespace.
 *
 * Two layers keep this suite off the app's data. The project id is its own
 * (`drivx-rules-test`, while the apps use `drivx-local`), and the emulator gives
 * each project id its own Firestore namespace. Inside that, every uid and doc id
 * still carries a per-run tag, so a fixture that fails can be traced to the run
 * that wrote it — and `RULES_RUN_ID` pins one exact set. `purgeRunData` below
 * empties the namespace after each file; `env.cleanup()` closes SDK clients and
 * never touches data.
 */
const RUN = process.env.RULES_RUN_ID?.trim() || Date.now().toString(36);
export const CUSTOMER_ONE = `cust-1-${RUN}`;
export const CUSTOMER_TWO = `cust-2-${RUN}`;
export const DRIVER_ONE = `drv-1-${RUN}`;
export const DRIVER_TWO = `drv-2-${RUN}`;
export const ADMIN_UID = `admin-1-${RUN}`;
export const OPS_UID = `ops-1-${RUN}`;
export const BOOKING_ONE = `bk-1-${RUN}`;
export const BOOKING_TWO = `bk-2-${RUN}`;

/**
 * A doc id for a test that is allowed to *create* one.
 *
 * Writes made through an allowed path stay in the emulator afterwards, and a
 * second `setDoc` on the same id is an update, which the create rules are not
 * meant to allow. Naming such a doc per run keeps the assertion about creating.
 */
export const runId = (name: string): string => `${name}-${RUN}`;

/** Claim shapes minted by the setRole callable; tests pass them as token claims. */
export const claims = {
  customer: { role: 'customer', roles: ['customer'], admin: false, ops: false },
  driver: { role: 'driver', roles: ['driver'], admin: false, ops: false },
  /** One phone number, two accounts: the shape the rules must not lock out. */
  dual: { role: 'customer', roles: ['customer', 'driver'], admin: false, ops: false },
  admin: { role: 'admin', roles: ['admin'], admin: true, ops: false },
  ops: { role: 'ops', roles: ['ops'], admin: false, ops: true },
} as const;

export type TestRole = keyof typeof claims;

/** An auth context carrying the claims Cloud Functions would have minted. */
export function ctxFor(env: RulesTestEnvironment, uid: string, role: TestRole): RulesTestContext {
  return env.authenticatedContext(uid, { ...claims[role] });
}

/** Seeds through the rules-disabled context, i.e. exactly what Cloud Functions do. */
export function seedViaServer(env: RulesTestEnvironment, work: (ctx: RulesTestContext) => Promise<void>) {
  return env.withSecurityRulesDisabled(work);
}

/**
 * The emulator's Firestore REST endpoint, used only to sweep fixtures after a run.
 *
 * REST rather than the SDK because the *client* SDK cannot enumerate a document's
 * subcollections — `listCollections` is a server-side call — and a sweep that
 * guesses at subcollection names silently leaves rows behind. `Bearer owner` is
 * the emulator's own bypass, the same privilege `withSecurityRulesDisabled` rides
 * on, and it is scoped to `TEST_PROJECT`, so the apps' `drivx-local` data cannot
 * be touched from here.
 */
const REST = `http://${EMULATORS.firestore.host}:${EMULATORS.firestore.port}/v1/projects/${TEST_PROJECT}/databases/(default)/documents`;
/** What `document.name` starts with, so a REST response can be cut back to a path. */
const NAME_PREFIX = `projects/${TEST_PROJECT}/databases/(default)/documents/`;

interface RestPage {
  documents?: { name: string }[];
  nextPageToken?: string;
  collectionIds?: string[];
}

async function restJson(url: string, init?: RequestInit): Promise<RestPage> {
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
  });
  if (!response.ok) {
    throw new Error(`Firestore emulator REST ${response.status} for ${url}: ${await response.text()}`);
  }
  return response.json() as Promise<RestPage>;
}

/** Subcollection names directly under one document (empty path = the root). */
async function childCollections(documentPath: string): Promise<string[]> {
  const where = documentPath ? `${REST}/${documentPath}` : REST;
  const page = await restJson(`${where}:listCollectionIds`, {
    method: 'POST',
    body: JSON.stringify({ pageSize: 100 }),
  });
  return page.collectionIds ?? [];
}

/** Relative paths of every document in one collection, following page tokens. */
async function listDocuments(collectionPath: string): Promise<string[]> {
  const found: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = await restJson(
      `${REST}/${collectionPath}?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`,
    );
    found.push(...(page.documents ?? []).map((row) => row.name.slice(NAME_PREFIX.length)));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return found;
}

async function deleteDocument(documentPath: string): Promise<void> {
  await restJson(`${REST}:commit`, {
    method: 'POST',
    body: JSON.stringify({ writes: [{ delete: `${NAME_PREFIX}${documentPath}` }] }),
  });
}

/** Deletes a document's whole subcollection tree, children before parents. */
async function deleteTree(documentPath: string): Promise<void> {
  for (const child of await childCollections(documentPath)) {
    for (const row of await listDocuments(`${documentPath}/${child}`)) {
      await deleteTree(row);
      await deleteDocument(row);
    }
  }
}

/**
 * Empties the test project's Firestore namespace.
 *
 * `env.cleanup()` only closes SDK clients; it never touches data. Without a sweep
 * every run leaves its fixtures behind, and this emulator had accumulated 89
 * driver profiles and 12 bookings across old runs — enough for a list-query test
 * to read rows it never wrote. The names are read back from the store rather than
 * listed here, so a subcollection added to the schema cannot be forgotten, and the
 * tree goes with the parent (`dues` and `documents` aside from a profile would
 * otherwise outlive it).
 *
 * The whole namespace is swept rather than only this run's tagged ids, because the
 * project is dedicated to this suite — the apps use `drivx-local` and never write
 * here — and the four files run one after another (`pool: forks`, `singleFork`),
 * each re-seeding what it needs in `beforeAll`. Running two `npm run test:rules`
 * processes against one emulator at the same time is not supported by this: they
 * would clear each other's fixtures.
 */
export async function purgeRunData(): Promise<void> {
  for (const name of await childCollections('')) {
    for (const row of await listDocuments(name)) {
      await deleteTree(row);
      await deleteDocument(row);
    }
  }
}

/**
 * The three SDKs each report a rules rejection differently: Firestore uses the
 * bare gRPC code (`permission-denied`), Storage namespaces its own
 * (`storage/unauthorized`), and a Realtime Database *write* carries the
 * SCREAMING_SNAKE form (`PERMISSION_DENIED`) while a *read* has no code at all —
 * just `Error('Permission denied')`. Normalize all four into one answer.
 */
export function isPermissionDenied(error: unknown): boolean {
  const candidate = error as { code?: string; customData?: { code?: string }; message?: string } | null;
  const code = String(candidate?.code ?? candidate?.customData?.code ?? '').toLowerCase().replace(/_/g, '-');
  if (code.endsWith('permission-denied') || code.endsWith('unauthorized')) return true;
  return code === '' && /permission denied|unauthorized/i.test(String(candidate?.message ?? ''));
}

/** Passes only when the operation is rejected by the rules, not by luck. */
export async function expectDenied(operation: Promise<unknown>): Promise<void> {
  let denied = false;
  try {
    await operation;
  } catch (error) {
    if (!isPermissionDenied(error)) throw error;
    denied = true;
  }
  if (!denied) throw new Error('Expected permission-denied, but the operation succeeded.');
}

export async function expectAllowed<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    if (isPermissionDenied(error)) throw new Error('Expected access, but the rules denied it.');
    throw error;
  }
}
