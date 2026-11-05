#!/usr/bin/env node
/**
 * Proves the rating loop against the emulator, with rules on and the real
 * Cloud Functions running: a closed trip is rated by its own customer, the score
 * lands on the driver's profile, and nobody else can move it.
 *
 * The owner asked for this twice — "sath me section rating ka bnao" in the
 * driver's app, and a rating written "against the driverId". The rules make the
 * order unavoidable: `ratings` is `write: if false` for every client, so the
 * number a driver sees can only be produced by a function. This script is the
 * proof that the function does what the screens then claim.
 *
 * What it exercises, in order:
 *
 *   1. A finished trip is rated once — the row, the driver's new average, and the
 *      score on the booking all move together, in the same transaction.
 *   2. The same customer submitting again is answered with the rating that
 *      already exists, and the average does not move a second time.
 *   3. Only the booking's own customer can rate it; a driver cannot rate himself,
 *      and neither can anyone invent a score with a direct write.
 *   4. A trip that is still running, a trip that was cancelled, and a trip with
 *      no driver on it are each refused for their own reason.
 *   5. A score outside one-to-five and a tag the product does not offer are
 *      refused before anything is written.
 *   6. The driver is told about it in his inbox, and the rating stays readable to
 *      the two people it involves and to nobody else.
 *
 *   npm run emulators        # terminal 1 (needs Java 21+)
 *   npm run verify:ratings
 *
 * Everything it creates — two throwaway accounts, three bookings, the ratings,
 * the inbox rows and the driver profiles — it deletes again.
 */
import { connect } from 'node:net';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = process.env.FIREBASE_EMULATOR_HOST ?? '127.0.0.1';
const AUTH_PORT = Number(process.env.AUTH_EMULATOR_PORT ?? 9099);
const FIRESTORE_PORT = Number(process.env.FIRESTORE_EMULATOR_PORT ?? 8080);
const FUNCTIONS_PORT = Number(process.env.FUNCTIONS_EMULATOR_PORT ?? 5001);
const REGION = process.env.FUNCTIONS_REGION ?? 'asia-south1';

let PROJECT_ID = 'drivx-local';
try {
  PROJECT_ID = JSON.parse(readFileSync(path.join(root, '.firebaserc'), 'utf8')).projects?.default ?? PROJECT_ID;
} catch {
  /* fall back to the emulator's default project */
}

const CONFIG = {
  apiKey: 'developer-mode-key',
  projectId: PROJECT_ID,
  storageBucket: `${PROJECT_ID}.appspot.com`,
  appId: '1:0:web:000000000000',
};
const PASSWORD = 'drivx-dev-password';

const failures = [];
function check(label, ok, detail) {
  console.log(`${ok ? 'ok   ' : 'FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

function reachable(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: HOST, port });
    socket.setTimeout(800);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const [authUp, storeUp, fnUp] = await Promise.all([
  reachable(AUTH_PORT),
  reachable(FIRESTORE_PORT),
  reachable(FUNCTIONS_PORT),
]);
if (!authUp || !storeUp || !fnUp) {
  console.error(
    `Emulator not reachable (auth ${authUp ? 'ok' : 'DOWN'}, firestore ${storeUp ? 'ok' : 'DOWN'}, ` +
      `functions ${fnUp ? 'ok' : 'DOWN'} on ${HOST}).\nStart it with \`npm run emulators\`.`,
  );
  process.exit(1);
}

const { initializeApp, deleteApp } = await import('firebase/app');
const authMod = await import('firebase/auth');
const fs = await import('firebase/firestore');
const fn = await import('firebase/functions');

/** Sign in one account into its own app, so sessions can overlap. */
async function session(name, email) {
  const app = initializeApp(CONFIG, name);
  const auth = authMod.getAuth(app);
  authMod.connectAuthEmulator(auth, `http://${HOST}:${AUTH_PORT}`, { disableWarnings: true });
  const cred = await authMod.signInWithEmailAndPassword(auth, email, PASSWORD);
  const firestore = fs.getFirestore(app);
  fs.connectFirestoreEmulator(firestore, HOST, FIRESTORE_PORT);
  const functions = fn.getFunctions(app, REGION);
  fn.connectFunctionsEmulator(functions, HOST, FUNCTIONS_PORT);
  return { app, firestore, functions, uid: cred.user.uid };
}

process.env.FIRESTORE_EMULATOR_HOST = `${HOST}:${FIRESTORE_PORT}`;
process.env.FIREBASE_AUTH_EMULATOR_HOST = `${HOST}:${AUTH_PORT}`;
const { initializeApp: initAdmin } = await import('firebase-admin/app');
const { getFirestore } = await import('firebase-admin/firestore');
const { getAuth } = await import('firebase-admin/auth');
initAdmin({ projectId: PROJECT_ID });
const db = getFirestore();
const authAdmin = getAuth();

/**
 * The server's own arithmetic, so a check that passes means the callable and the
 * domain agree. Read from the compiled build rather than the TypeScript source:
 * this file only needs the two helpers, and the source imports Firestore paths
 * that Node's type-stripping cannot resolve on its own.
 */
const { applyRating, customerRatingId } = createRequire(import.meta.url)(
  '../packages/domain/dist/ratings.js',
);

const callable = (who, name, payload) => fn.httpsCallable(who.functions, name)(payload);

async function callFailure(promise) {
  try {
    const result = await promise;
    return { code: 'no error', message: '', result };
  } catch (error) {
    return {
      code: String(error?.code ?? 'unknown').replace('functions/', ''),
      message: String(error?.message ?? error),
    };
  }
}

async function expectRefusedByRules(label, operation) {
  try {
    await operation();
    check(label, false, 'the rules let it through');
  } catch (error) {
    check(label, error?.code === 'permission-denied', String(error?.code ?? error));
  }
}

/** The driver's inbox is written by a trigger-adjacent helper, so it lands a moment late. */
async function waitForDoc(docPath, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const snap = await db.doc(docPath).get();
    if (snap.exists) return snap.data() ?? {};
    await sleep(500);
  }
  return null;
}

const throwaways = [];
const createdBookings = [];

/** An auth account with a signed-in session, deleted by the finally. */
async function makeAccount(label, role, email) {
  const uid = `verify-rate-${label}-${randomBytes(4).toString('hex')}`;
  await authAdmin.createUser({ uid, email, emailVerified: true, password: PASSWORD, displayName: `Rate ${label}` });
  await authAdmin.setCustomUserClaims(uid, {
    role,
    roles: [role],
    admin: false,
    ops: false,
    driverVerified: role === 'driver',
    zoneId: 'zone-ggn-1',
    serviceTypeIds: [],
    testAccount: true,
  });
  const made = { uid, role, label, email, ...(await session(`rate-${label}`, email)) };
  throwaways.push(made);
  return made;
}

/**
 * A booking already at the stage a rating needs.
 *
 * The trip loop itself is `verify:trip-loop`'s job; here the point is the state
 * the rating is written against, so the row is placed by the same authority
 * dispatch uses and the rating path is what runs.
 */
async function putBooking(fields) {
  const id = `verify-rate-${randomBytes(4).toString('hex')}`;
  createdBookings.push(id);
  await db.doc(`bookings/${id}`).set({
    id,
    reference: `DRIVX-RATE-${id.slice(-6).toUpperCase()}`,
    createdAtMs: Date.now() - 3_600_000,
    status: 'completed',
    estimate: null,
    runningFare: null,
    finalFare: null,
    ...fields,
  });
  return id;
}

const driver = await makeAccount('driver', 'driver', 'rate-driver@example.test');
const owner = await makeAccount('customer', 'customer', 'rate-owner@example.test');
const stranger = await makeAccount('stranger', 'customer', 'rate-stranger@example.test');
await db.doc(`driverProfiles/${driver.uid}`).set({
  uid: driver.uid,
  fullName: 'Rakesh Yadav',
  phoneE164: '+919000000077',
  driverId: 'DRV-RATE-ONE',
  verificationStatus: 'approved',
  availabilityState: 'online',
  zoneId: 'zone-ggn-1',
  // 4.7 from 18 is the figure the seeded profile in verify-trip-loop carries, so
  // the arithmetic below is the same one a real driver's row would produce.
  ratingAverage: 4.7,
  ratingCount: 18,
  lifetimeTrips: 92,
  createdAtMs: Date.now() - 86_400_000,
  updatedAtMs: Date.now(),
});

const BEFORE = { ratingAverage: 4.7, ratingCount: 18 };
const EXPECTED = applyRating(BEFORE, 4);

try {
  console.log('\n1. A finished trip is rated by the customer who took it');

  const rated = await putBooking({ customerUid: owner.uid, assignedDriverUid: driver.uid });
  // The reference the booking carries, which the rating row must copy so the
  // driver's own list can say which job a star came from.
  const REFERENCE = `DRIVX-RATE-${rated.slice(-6).toUpperCase()}`;
  const first = await callable(owner, 'rateTrip', {
    bookingId: rated,
    score: 4,
    tags: ['knew_the_route', 'car_was_clean'],
    comment: 'Smooth drive, reached ahead of the estimate.',
  });
  check('the callable accepts the score, the chips and the note',
    first.data.alreadyRated === false && first.data.score === 4,
    `${first.data.score} ★ · ${first.data.tags?.join(', ') ?? 'no tags'}`);
  check('and names the driver it landed on, from the booking rather than from the caller',
    first.data.driverName === 'Rakesh Yadav' && first.data.driverRating?.ratingAverage === EXPECTED.ratingAverage,
    `${first.data.driverName} → ${JSON.stringify(first.data.driverRating)} (expected ${JSON.stringify(EXPECTED)})`);

  const row = (await db.doc(`ratings/${customerRatingId(rated)}`).get()).data() ?? {};
  check('one row exists, ided by the booking so a second submit cannot make a second',
    row.id === customerRatingId(rated) && row.bookingId === rated,
    `ratings/${row.id ?? 'missing'}`);
  check('written against the driver id the trip carried, in the customer-to-driver direction',
    row.raterUid === owner.uid && row.ratedUid === driver.uid && row.direction === 'customer_to_driver',
    `${row.raterUid} → ${row.ratedUid} (${row.direction})`);
  check('holding the score, the chips exactly as offered and the note as typed',
    row.score === 4 && JSON.stringify(row.tags) === JSON.stringify(['knew_the_route', 'car_was_clean']) &&
      row.comment === 'Smooth drive, reached ahead of the estimate.',
    `${row.score} ★ ${JSON.stringify(row.tags)} — ${row.comment}`);
  check('and the trip’s own reference, so the driver’s list names the job rather than a document id',
    row.bookingReference === REFERENCE && first.data.bookingReference === REFERENCE,
    `${row.bookingReference ?? 'none on the row'} / ${first.data.bookingReference ?? 'none in the answer'}`);

  const profile = (await db.doc(`driverProfiles/${driver.uid}`).get()).data() ?? {};
  check('and the driver’s profile now carries the average that arithmetic produces',
    profile.ratingAverage === EXPECTED.ratingAverage && profile.ratingCount === EXPECTED.ratingCount,
    `${profile.ratingAverage} from ${profile.ratingCount}, expected ${EXPECTED.ratingAverage} from ${EXPECTED.ratingCount}`);

  const booking = (await db.doc(`bookings/${rated}`).get()).data() ?? {};
  check('with the score on the booking itself, which is what the customer’s receipt reads',
    booking.customerRating === 4, String(booking.customerRating));

  const inbox = await waitForDoc(`users/${driver.uid}/notifications/rated_${rated}`);
  check('and the driver is told, in a message that names the trip and quotes the new average',
    inbox?.type === 'driver_rated' && String(inbox?.title).includes(REFERENCE) &&
      String(inbox?.body).includes('4 stars') &&
      String(inbox?.body).includes(String(EXPECTED.ratingAverage)) &&
      String(inbox?.body).includes(`${EXPECTED.ratingCount} ratings`),
    `${inbox?.title ?? 'no message'} — ${String(inbox?.body ?? '').slice(0, 120)}`);

  console.log('\n2. One rating per trip, however often it is sent');

  const again = await callable(owner, 'rateTrip', { bookingId: rated, score: 5, tags: ['polite'] });
  check('a second submit is answered with the rating that already exists, not a fresh one',
    again.data.alreadyRated === true && again.data.score === 4 &&
      again.data.bookingReference === REFERENCE &&
      JSON.stringify(again.data.tags) === JSON.stringify(['knew_the_route', 'car_was_clean']),
    `${again.data.score} ★ ${again.data.bookingReference} ${JSON.stringify(again.data.tags)}`);
  const afterSecond = (await db.doc(`driverProfiles/${driver.uid}`).get()).data() ?? {};
  check('and the average is not folded a second time',
    afterSecond.ratingAverage === EXPECTED.ratingAverage && afterSecond.ratingCount === EXPECTED.ratingCount,
    `${afterSecond.ratingAverage} from ${afterSecond.ratingCount}`);
  const rows = await db.collection('ratings').where('bookingId', '==', rated).get();
  check('with still exactly one row on the ledger for that trip', rows.size === 1, `${rows.size} row(s)`);

  console.log('\n3. Who can move a rating, and who cannot');

  const wrongCustomer = await callFailure(callable(stranger, 'rateTrip', { bookingId: rated, score: 1 }));
  check('a customer who was not on the trip cannot rate it', wrongCustomer.code === 'permission-denied',
    `${wrongCustomer.code}: ${wrongCustomer.message.slice(0, 80)}`);
  const selfRating = await callFailure(callable(driver, 'rateTrip', { bookingId: rated, score: 5 }));
  check('and the driver on the trip cannot rate it, whatever their own role claims', selfRating.code === 'permission-denied',
    `${selfRating.code}: ${selfRating.message.slice(0, 80)}`);
  const afterRefusals = (await db.doc(`driverProfiles/${driver.uid}`).get()).data() ?? {};
  check('neither refusal changed anything on the profile',
    afterRefusals.ratingAverage === EXPECTED.ratingAverage && afterRefusals.ratingCount === EXPECTED.ratingCount,
    `${afterRefusals.ratingAverage} from ${afterRefusals.ratingCount}`);

  await expectRefusedByRules('the customer cannot write the rating straight into the database',
    () => fs.setDoc(fs.doc(owner.firestore, 'ratings', `forge_${rated}`), {
      bookingId: rated, raterUid: owner.uid, ratedUid: driver.uid, score: 5,
    }));
  await expectRefusedByRules('nor amend the one they gave',
    () => fs.updateDoc(fs.doc(owner.firestore, 'ratings', customerRatingId(rated)), { score: 1 }));

  const readBack = await fs.getDoc(fs.doc(owner.firestore, 'ratings', customerRatingId(rated)));
  check('while the customer reads their own rating back, rules on — which is what the receipt screen relies on',
    readBack.exists() && readBack.data().score === 4, String(readBack.data()?.score ?? 'not readable'));
  await expectRefusedByRules('and a stranger cannot read it at all',
    () => fs.getDoc(fs.doc(stranger.firestore, 'ratings', customerRatingId(rated))));

  console.log('\n4. What a rating refuses to attach itself to');

  const running = await putBooking({ customerUid: owner.uid, assignedDriverUid: driver.uid, status: 'in_progress' });
  const tooEarly = await callFailure(callable(owner, 'rateTrip', { bookingId: running, score: 5 }));
  check('a trip still on the road cannot be rated', tooEarly.code === 'failed-precondition',
    `${tooEarly.code}: ${tooEarly.message.slice(0, 80)}`);

  const called = await putBooking({
    customerUid: owner.uid,
    assignedDriverUid: driver.uid,
    status: 'cancelled',
    cancellation: { by: 'customer', reasonCode: 'plan_changed', reasonText: null },
  });
  const cancelled = await callFailure(callable(owner, 'rateTrip', { bookingId: called, score: 5 }));
  check('nor a trip that was cancelled — there was no service to judge', cancelled.code === 'failed-precondition',
    `${cancelled.code}: ${cancelled.message.slice(0, 80)}`);

  const driverless = await putBooking({ customerUid: owner.uid, assignedDriverUid: null });
  const nobody = await callFailure(callable(owner, 'rateTrip', { bookingId: driverless, score: 5 }));
  check('and a booking with no driver on it says so instead of inventing one', nobody.code === 'failed-precondition',
    `${nobody.code}: ${nobody.message.slice(0, 80)}`);

  const missing = await callFailure(
    callable(owner, 'rateTrip', { bookingId: 'verify-rate-none', score: 5 }),
  );
  check('an unknown booking id is a not-found, not a silent success', missing.code === 'not-found',
    `${missing.code}: ${missing.message.slice(0, 80)}`);

  const before = (await db.doc(`driverProfiles/${driver.uid}`).get()).data() ?? {};
  check('and none of those refusals moved the driver’s number',
    before.ratingAverage === EXPECTED.ratingAverage && before.ratingCount === EXPECTED.ratingCount,
    `${before.ratingAverage} from ${before.ratingCount}`);

  console.log('\n5. The score and the chips are checked before anything is written');

  for (const score of [0, 6, 4.5]) {
    const refused = await callFailure(callable(owner, 'rateTrip', { bookingId: rated, score }));
    check(`a score of ${score} is refused as invalid-argument`, refused.code === 'invalid-argument',
      `${refused.code}: ${refused.message.slice(0, 70)}`);
  }
  const badTag = await callFailure(
    callable(owner, 'rateTrip', { bookingId: rated, score: 5, tags: ['gave_a_bribe'] }),
  );
  check('and so is a chip the product does not offer', badTag.code === 'invalid-argument',
    `${badTag.code}: ${badTag.message.slice(0, 70)}`);
  const unchanged = await db.collection('ratings').where('bookingId', '==', rated).get();
  check('leaving the one honest row on the ledger', unchanged.size === 1, `${unchanged.size} row(s)`);
} finally {
  console.log('\n6. Cleanup');
  for (const bookingId of createdBookings) {
    await db.doc(`ratings/${customerRatingId(bookingId)}`).delete();
    await db.doc(`users/${driver.uid}/notifications/rated_${bookingId}`).delete();
    await db.doc(`bookings/${bookingId}`).delete();
  }
  await db.doc(`driverProfiles/${driver.uid}`).delete();
  for (const made of throwaways) {
    await authAdmin.deleteUser(made.uid);
    await deleteApp(made.app).catch(() => {});
  }
  const leftovers = await db.collection('ratings').get();
  check('no rating row from this run survives',
    leftovers.docs.every((doc) => !String(doc.id).includes('verify-rate')),
    `${leftovers.docs.length} row(s) in ratings`);
  const profiles = await db.doc(`driverProfiles/${driver.uid}`).get();
  check('and the throwaway driver is gone', profiles.exists === false,
    profiles.exists ? 'profile survived' : 'removed');
}

console.log(
  failures.length > 0
    ? `\n${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`
    : '\nEvery rating check passed: the customer’s score, the driver’s average, one rating per trip, and nobody else’s say.',
);
process.exit(failures.length > 0 ? 1 : 0);
