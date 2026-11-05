#!/usr/bin/env node
/**
 * Proves the trip loop against the emulator, with rules on and the real
 * Cloud Functions running: start code → opening odometer → live meter →
 * end code → closing odometer → the bill from what the car actually ran.
 *
 * The owner's rule in his own words: "jo bill bnega actual me ispe bnaega reading
 * ke hissab se" — the receipt is built from the dial, not from the map. So this
 * script books a trip the map quotes at roughly twelve kilometres, drives the
 * needle to thirty-five, and checks that the money follows the needle while
 * every number on screen still comes out of the same pricing rule.
 *
 * What it exercises, in order:
 *
 *   1. `createBooking` leaves all three odometer fields empty — an unread dial is
 *      never the same as a dial at zero — and the assignment copies the driver
 *      onto the booking, where the customer can read it and nobody else can.
 *   2. Only the customer is handed the codes, both are minted once against the
 *      booking id, and no client can read `otpCodes`.
 *   3. A wrong start code is refused, counted, and changes nothing on the trip.
 *   4. The right code opens the trip at the reported reading and switches the
 *      Realtime Database tracking gate on for that booking only.
 *   5. `recordOdometer` posts a running fare the server computed, moves the trip
 *      to `in_progress`, and refuses a reading that runs backwards.
 *   6. A code issued for one trip cannot open another, a start code cannot close
 *      one, and re-reading a booking's codes returns the same digits — there is
 *      no re-issue path left in the product.
 *   7. `confirmCompletion` prices the bill from the two readings, writes the
 *      summary, closes the tracking gate, and raises exactly one commission row
 *      for the amount the response quoted.
 *   8. A closed trip cannot be closed twice.
 *
 *   npm run emulators        # terminal 1 (needs Java 21+)
 *   npm run seed:catalogue   # price chart + services + developer sign-ins, no demo trips
 *   npm run verify:trip-loop
 *
 * Everything it creates — two throwaway drivers, two bookings, the codes, the
 * summary, the commission row and the tracking nodes — it deletes again, so the
 * emulator keeps holding only real data.
 */
import { connect } from 'node:net';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = process.env.FIREBASE_EMULATOR_HOST ?? '127.0.0.1';
const AUTH_PORT = Number(process.env.AUTH_EMULATOR_PORT ?? 9099);
const FIRESTORE_PORT = Number(process.env.FIRESTORE_EMULATOR_PORT ?? 8080);
const FUNCTIONS_PORT = Number(process.env.FUNCTIONS_EMULATOR_PORT ?? 5001);
const RTDB_PORT = Number(process.env.DATABASE_EMULATOR_PORT ?? 9000);
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

/** The dial readings this trip "drives": 12 km on the meter, 35 km on the road. */
const DIAL_OPEN = 5_000;
const DIAL_RUNNING = 5_012;
const DIAL_CLOSED = 5_035;

const CUSTOMER_EMAIL = 'amit@example.test';
const PICKUP = {
  label: 'Sector 56 residence',
  addressLine1: 'Sector 56, Gurugram',
  city: 'Gurugram',
  state: 'Haryana',
  pincode: '122011',
  location: { lat: 28.4215, lng: 77.0295 },
  source: 'map_pin',
};
const DROP = {
  label: 'MG Road metro',
  addressLine1: 'MG Road, Gurugram',
  city: 'Gurugram',
  state: 'Haryana',
  pincode: '122001',
  location: { lat: 28.5038, lng: 77.0905 },
  source: 'map_pin',
};

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

const [authUp, storeUp, fnUp, rtdbUp] = await Promise.all([
  reachable(AUTH_PORT),
  reachable(FIRESTORE_PORT),
  reachable(FUNCTIONS_PORT),
  reachable(RTDB_PORT),
]);
if (!authUp || !storeUp || !fnUp || !rtdbUp) {
  console.error(
    `Emulator not reachable (auth ${authUp ? 'ok' : 'DOWN'}, firestore ${storeUp ? 'ok' : 'DOWN'}, ` +
      `functions ${fnUp ? 'ok' : 'DOWN'}, database ${rtdbUp ? 'ok' : 'DOWN'} on ${HOST}).\n` +
      'Start it with `npm run emulators`, then `npm run seed:catalogue`.',
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

// Privileged access, which is what Cloud Functions and this script's setup share:
// the assignment that Phase 3 dispatch will one day make is written here by the
// same authority, and the tracking gate is read back as the server wrote it.
process.env.FIRESTORE_EMULATOR_HOST = `${HOST}:${FIRESTORE_PORT}`;
process.env.FIREBASE_AUTH_EMULATOR_HOST = `${HOST}:${AUTH_PORT}`;
process.env.FIREBASE_DATABASE_EMULATOR_HOST = `${HOST}:${RTDB_PORT}`;
const { initializeApp: initAdmin } = await import('firebase-admin/app');
const { getFirestore } = await import('firebase-admin/firestore');
const { getAuth } = await import('firebase-admin/auth');
const { getDatabase } = await import('firebase-admin/database');
initAdmin({ projectId: PROJECT_ID, databaseURL: `http://${HOST}:${RTDB_PORT}?ns=${PROJECT_ID}` });
const db = getFirestore();
const authAdmin = getAuth();
const rtdb = getDatabase();

/**
 * The server's own pricing code, loaded from the compiled Functions output.
 *
 * The expected fare is recomputed here from the rule document and the dial
 * readings, through `asRule` and `localStartHour` exactly as `meteredTrip` uses
 * them — so a check that passes means the callable and the engine agree, and a
 * check that fails says which of the two moved.
 */
const { asRule, localStartHour } = await import('../functions/lib/lib/pricing.js');
const { computeFare } = await import('../packages/domain/src/pricing.ts');
const snapshotHash = (canonical) => `sha256:${createHash('sha256').update(canonical).digest('hex')}`;

/** The breakdown the engine should produce for a given dial run. */
function expectedFare(rule, runKilometres, kind, tripStartMs, quotedMeters) {
  return computeFare({
    rule,
    zoneId: rule.zoneId,
    distanceMeters: runKilometres * 1000,
    // The band the customer was sold, so the chart row is the same one the
    // callable must still be pricing at.
    quotedDistanceMeters: quotedMeters,
    durationSeconds: 0,
    waitingMinutes: 0,
    localStartHour: localStartHour(tripStartMs, rule.zoneId),
    surgeMultiplier: 1,
    packageTierId: null,
    kind,
    nowMs: Date.now(),
    hash: snapshotHash,
  });
}

const money = (paise) => `₹${(paise / 100).toFixed(2)}`;

async function readBooking(bookingId) {
  const snap = await db.doc(`bookings/${bookingId}`).get();
  return { exists: snap.exists, data: snap.data() ?? null };
}

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

const callable = (who, name, payload) => fn.httpsCallable(who.functions, name)(payload);

async function expectRefusedByRules(label, operation) {
  try {
    await operation();
    check(label, false, 'the rules let it through');
  } catch (error) {
    check(label, error?.code === 'permission-denied', String(error?.code ?? error));
  }
}

/** Background triggers write the commission row a moment after the response. */
async function waitForDue(driverUid, dueId, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const snap = await db.doc(`driverProfiles/${driverUid}/dues/${dueId}`).get();
    if (snap.exists) return snap.data() ?? {};
    await sleep(500);
  }
  return null;
}

/** The same grace for any other trigger's write, addressed by path. */
async function waitForDoc(path, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const snap = await db.doc(path).get();
    if (snap.exists) return snap.data() ?? {};
    await sleep(500);
  }
  return null;
}

/**
 * The booking document exists the moment `createBooking` returns, so waiting for
 * the file is not waiting for the card. This polls for the field the assignment
 * trigger writes onto it.
 */
async function waitForDriverCard(bookingId, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const data = (await db.doc(`bookings/${bookingId}`).get()).data() ?? {};
    if (data.driver) return data.driver;
    await sleep(500);
  }
  return null;
}

const throwawayDrivers = [];
const createdBookings = [];

/** A verified driver with a session signed in as them, deleted by the finally. */
async function makeDriver(label) {
  const uid = `verify-loop-${label}-${randomBytes(4).toString('hex')}`;
  const email = `trip-loop-${label}@example.test`;
  await authAdmin.createUser({ uid, email, emailVerified: true, password: PASSWORD, displayName: `Loop Driver ${label}` });
  await authAdmin.setCustomUserClaims(uid, {
    role: 'driver',
    roles: ['driver'],
    admin: false,
    ops: false,
    driverVerified: true,
    zoneId: 'zone-ggn-1',
    serviceTypeIds: [],
    testAccount: true,
  });
  await db.doc(`driverProfiles/${uid}`).set({
    uid,
    fullName: `Loop Driver ${label}`,
    phoneE164: '+919000000077',
    verificationStatus: 'approved',
    driverId: `DRV-LOOP-${label.toUpperCase()}`,
    availabilityState: 'online',
    zoneId: 'zone-ggn-1',
    languages: ['hi', 'en'],
    ratingAverage: 4.7,
    ratingCount: 18,
    lifetimeTrips: 92,
    // The car the customer is told to look for. These belong to a throwaway
    // profile this script deletes, which is the only place a made-up plate is
    // honest — the seed leaves these null rather than showing a fake Swift.
    vehicleMake: 'Maruti Suzuki',
    vehicleModel: 'Dzire',
    vehiclePlate: `DRIVX-TEST-${label.toUpperCase()}`,
    photoUrl: null,
    createdAtMs: Date.now() - 86_400_000,
    updatedAtMs: Date.now(),
  });
  const made = { uid, email, label, ...(await session(`loop-driver-${label}`, email)) };
  throwawayDrivers.push(made);
  return made;
}

/** Book the trip through the real callable, then hand it to a driver as dispatch would. */
async function bookAndAssign(customer, driver) {
  const made = await callable(customer, 'createBooking', {
    serviceTypeId: 'chauffeur_own_car',
    pickup: PICKUP,
    destination: DROP,
    tripDirection: 'one_way',
    scheduledForMs: null,
    preferences: { transmission: 'automatic', carType: 'sedan', notes: null },
    idempotencyKey: randomUUID(),
  });
  const bookingId = made.data.bookingId;
  createdBookings.push(bookingId);
  await db.doc(`bookings/${bookingId}`).update({
    status: 'assigned',
    assignedDriverUid: driver.uid,
    stateVersion: 2,
  });
  return { bookingId, quote: made.data };
}

const customer = await session('loop-customer', CUSTOMER_EMAIL);

try {
  const catalogue = await db.collection('pricingRules').get();
  if (catalogue.empty) {
    throw new Error('No pricing rules in the emulator. Run `npm run seed:catalogue` first.');
  }
  const driver = await makeDriver('one');
  const stranger = await makeDriver('two');

  console.log('\n1. A booked trip carries no reading yet');

  const { bookingId, quote } = await bookAndAssign(customer, driver);
  const ruleId = quote.breakdown.pricingRuleId;
  const ruleDoc = (await db.doc(`pricingRules/${ruleId}`).get()).data() ?? {};
  const rule = asRule(ruleId, ruleDoc);
  check('the booking was priced server-side', typeof bookingId === 'string' && quote.breakdown.totalPaise > 0,
    `${quote.reference} at ${money(quote.breakdown.totalPaise)} for ${(quote.distanceMeters / 1000).toFixed(1)} km`);
  check('on a distance-slab chart, so the bill moves with the dial',
    rule.pricingModel === 'distance_slab' && rule.perMinutePaise === 0,
    `${rule.pricingModel}, ${rule.perMinutePaise} paise per minute`);

  const booked = (await readBooking(bookingId)).data;
  check('and leaves all three odometer fields empty rather than at zero',
    booked.startOdometerKm === null && booked.currentOdometerKm === null && booked.endOdometerKm === null,
    `${booked.startOdometerKm} / ${booked.currentOdometerKm} / ${booked.endOdometerKm}`);
  check('with no running bill until a reading is posted', booked.runningFare == null,
    String(booked.runningFare?.totalPaise ?? booked.runningFare));
  check('with no tracking gate open yet', (await rtdb.ref(`authz/${bookingId}`).get()).exists() === false);

  // Handing the trip to a driver is the trigger's cue to copy that driver onto
  // the booking. The owner's rule: "uski sab details aaegi… name kya hai uska,
  // number, sab kuch customer ke paas" — and the way a customer gets them is a
  // bounded copy on a document they may already read, not the driver's profile.
  const card = await waitForDriverCard(bookingId);
  check('the assignment publishes the driver onto the booking', card !== null,
    card ? `${card.fullName} · ${card.driverId}` : 'no card after 30s');
  check('with the name, number and office reference the customer asked for',
    card?.fullName === 'Loop Driver one' && card?.phoneE164 === '+919000000077' &&
      card?.driverId === 'DRV-LOOP-ONE' && card?.uid === driver.uid,
    `${card?.fullName} · ${card?.phoneE164} · ${card?.driverId}`);
  check('the car to look for, and the rating and history the office already holds',
    `${card?.vehicle?.make} ${card?.vehicle?.model} ${card?.vehicle?.plate}` ===
      'Maruti Suzuki Dzire DRIVX-TEST-ONE' &&
      card?.ratingAverage === 4.7 && card?.ratingCount === 18 && card?.lifetimeTrips === 92,
    `${card?.vehicle?.make} ${card?.vehicle?.model} · ${card?.vehicle?.plate} · ` +
      `${card?.ratingAverage}★ from ${card?.ratingCount}, ${card?.lifetimeTrips} trips`);

  const cardKeys = Object.keys(card ?? {}).sort().join(',');
  check('and nothing the customer has no business with — no document numbers, dues or home address',
    cardKeys === [
      'driverId', 'fullName', 'languages', 'lifetimeTrips', 'phoneE164', 'photoPath', 'publishedAtMs',
      'ratingAverage', 'ratingCount', 'uid', 'vehicle',
    ].sort().join(','),
    cardKeys);
  check('with the photo path left empty while none is on file, so the card falls back to initials',
    card?.photoPath === null, String(card?.photoPath));

  const cardAsCustomer = await fs.getDoc(fs.doc(customer.firestore, 'bookings', bookingId));
  check('which the customer reads with their own session, rules on',
    cardAsCustomer.data()?.driver?.phoneE164 === '+919000000077',
    String(cardAsCustomer.data()?.driver?.phoneE164 ?? 'nothing on the read'));
  await expectRefusedByRules('while the driver’s own profile behind it stays closed to them',
    () => fs.getDoc(fs.doc(customer.firestore, 'driverProfiles', driver.uid)));
  await expectRefusedByRules('and a driver who is not on the trip cannot read the card off the booking',
    () => fs.getDoc(fs.doc(stranger.firestore, 'bookings', bookingId)));

  const assignedMessage = await waitForDoc(`users/${customer.uid}/notifications/driver_${bookingId}`);
  check('the same details arrive in the customer’s inbox as a message',
    assignedMessage?.type === 'driver_assigned' &&
      String(assignedMessage?.body).includes('Loop Driver one') &&
      String(assignedMessage?.body).includes('+919000000077') &&
      String(assignedMessage?.body).includes('DRIVX-TEST-ONE'),
    `${assignedMessage?.title ?? 'no message'}`);

  console.log('\n2. Who a code can come from, and who it can never be read by');

  const driverAsked = await callFailure(callable(driver, 'tripCodes', { bookingId }));
  check('a driver cannot hand themselves the codes', driverAsked.code === 'permission-denied',
    `${driverAsked.code}: ${driverAsked.message.slice(0, 90)}`);
  await expectRefusedByRules('the assigned driver cannot read the issued code from the database',
    () => fs.getDoc(fs.doc(driver.firestore, 'otpCodes', `${bookingId}_trip_start`)));
  await expectRefusedByRules('nor can the customer who owns it',
    () => fs.getDoc(fs.doc(customer.firestore, 'otpCodes', `${bookingId}_trip_start`)));

  const codes = await callable(customer, 'tripCodes', { bookingId });
  const startCode = codes.data.start;
  const endCode = codes.data.end;
  check('the customer is handed both codes for the booking at once, six digits each',
    /^\d{6}$/.test(String(startCode)) && /^\d{6}$/.test(String(endCode)) && startCode !== endCode,
    `${startCode} / ${endCode}`);
  check('minted against the booking id, one document per stage',
    (await db.doc(`otpCodes/${bookingId}_trip_start`).get()).exists &&
      (await db.doc(`otpCodes/${bookingId}_trip_end`).get()).exists,
    `otpCodes/${bookingId}_trip_start and _trip_end`);

  const reread = await callable(customer, 'tripCodes', { bookingId });
  check('and a second read returns the same digits — nothing in the product can issue a new code',
    reread.data.start === startCode && reread.data.end === endCode,
    `${reread.data.start} / ${reread.data.end}`);

  const message = (await db.doc(`users/${customer.uid}/notifications/codes_${bookingId}`).get()).data() ?? {};
  check('the same digits reach the customer as a message in their own inbox',
    message.type === 'trip_codes' && String(message.body).includes(startCode) && String(message.body).includes(endCode),
    `${message.title}`);

  const mintLog = await db.collection(`bookings/${bookingId}/events`).get();
  const mintedTypes = mintLog.docs.map((doc) => doc.data().type);
  check('with one otp_sent line per stage, and no digits anywhere in the booking’s log',
    mintedTypes.filter((type) => type === 'otp_sent').length === 2 &&
      !JSON.stringify(mintLog.docs.map((doc) => doc.data())).includes(startCode),
    mintedTypes.join(', '));

  const earlyClose = await callFailure(
    callable(driver, 'confirmCompletion', { bookingId, code: endCode, odometerKm: DIAL_OPEN }),
  );
  check('the end code that has been on the customer’s screen since pickup still cannot close a trip that never ran',
    earlyClose.code === 'failed-precondition', `${earlyClose.code}: ${earlyClose.message.slice(0, 90)}`);
  const tooEarlyMeter = await callFailure(
    callable(driver, 'recordOdometer', { bookingId, odometerKm: DIAL_OPEN }),
  );
  check('nor is a meter accepted before the trip has started', tooEarlyMeter.code === 'failed-precondition',
    `${tooEarlyMeter.code}: ${tooEarlyMeter.message.slice(0, 90)}`);

  console.log('\n3. The start code, and the dial that opens the trip');

  const wrongCode = String((Number(startCode) + 1) % 1_000_000).padStart(6, '0');
  const refused = await callFailure(
    callable(driver, 'verifyTripOtp', { bookingId, code: wrongCode, odometerKm: DIAL_OPEN }),
  );
  check('a wrong code is refused', refused.code === 'permission-denied', `${refused.code}: ${refused.message.slice(0, 90)}`);
  check('and the refusal says how many tries are left', /left before it locks/.test(refused.message), refused.message.slice(0, 110));
  const afterWrong = (await readBooking(bookingId)).data;
  check('while the trip stays exactly where it was — no reading, no status, no gate',
    afterWrong.status === 'assigned' && afterWrong.startOdometerKm === null &&
      (await rtdb.ref(`authz/${bookingId}`).get()).exists() === false,
    `${afterWrong.status}`);
  const codeDoc = (await db.doc(`otpCodes/${bookingId}_trip_start`).get()).data() ?? {};
  check('with the wrong guess counted against the code, not the customer, and no deadline stored',
    codeDoc.attempts === 1 && codeDoc.consumedAtMs === null && codeDoc.expiresAtMs === null,
    `attempts=${codeDoc.attempts}, expiresAtMs=${codeDoc.expiresAtMs}`);
  check('and the stage still holds the digits it minted first, because a code the customer must be able to read tomorrow has to exist somewhere',
    codeDoc.code === startCode && typeof codeDoc.codeHash === 'string' &&
      codeDoc.codeHash === `sha256:${createHash('sha256').update(`${bookingId}|trip_start|${startCode}`).digest('hex')}` &&
      codeDoc.issuedCount === undefined,
    `issuedCount=${codeDoc.issuedCount}, hash ${String(codeDoc.codeHash).slice(0, 18)}`);

  const notYours = await callFailure(
    callable(stranger, 'verifyTripOtp', { bookingId, code: startCode, odometerKm: DIAL_OPEN }),
  );
  check('a driver who was not given this booking cannot open it with the right code',
    notYours.code === 'permission-denied', `${notYours.code}: ${notYours.message.slice(0, 80)}`);

  const started = await callable(driver, 'verifyTripOtp', {
    bookingId,
    code: startCode,
    odometerKm: DIAL_OPEN,
  });
  check('the right code and the opening reading start the trip',
    started.data.status === 'trip_started' && started.data.startOdometerKm === DIAL_OPEN,
    `${started.data.status} at ${started.data.startOdometerKm} km`);
  const openDoc = (await readBooking(bookingId)).data;
  check('which writes both the opening and the current dial',
    openDoc.startOdometerKm === DIAL_OPEN && openDoc.currentOdometerKm === DIAL_OPEN,
    `${openDoc.startOdometerKm}/${openDoc.currentOdometerKm}`);
  const gate = (await rtdb.ref(`authz/${bookingId}`).get()).val() ?? {};
  check('and opens the tracking gate for this booking to these two people only',
    gate.trackingEnabled === true && gate.driverUid === driver.uid &&
      gate.customerUid === customer.uid && Object.keys(gate.sharedWith ?? {}).length === 2,
    `trackingEnabled=${gate.trackingEnabled} sharedWith=${JSON.stringify(Object.keys(gate.sharedWith ?? {}))}`);
  const spent = (await db.doc(`otpCodes/${bookingId}_trip_start`).get()).data() ?? {};
  check('with the code burned, so it cannot start a second trip',
    spent.consumedAtMs !== null && spent.consumedAtMs !== undefined, `consumedAtMs=${String(spent.consumedAtMs)}`);

  console.log('\n4. The meter the customer watches');

  const backwards = await callFailure(
    callable(driver, 'recordOdometer', { bookingId, odometerKm: DIAL_OPEN - 1 }),
  );
  check('a reading below the one taken at pickup is refused',
    backwards.code === 'failed-precondition' && /below the/.test(backwards.message),
    backwards.message.slice(0, 110));

  const posted = await callable(driver, 'recordOdometer', { bookingId, odometerKm: DIAL_RUNNING });
  const expectedRunning = expectedFare(rule, DIAL_RUNNING - DIAL_OPEN, 'estimate', openDoc.tripStartedAtMs, quote.distanceMeters);
  check('posting the dial twelve kilometres on moves the trip to in_progress',
    posted.data.status === 'in_progress' && posted.data.runMetres === 12_000,
    `${posted.data.status}, ${(posted.data.runMetres ?? 0) / 1000} km run`);
  check('and the running fare the server returns is the fare engine’s own answer for those kilometres',
    posted.data.runningFare.totalPaise === expectedRunning.totalPaise &&
      posted.data.runningFare.subtotalPaise === expectedRunning.subtotalPaise,
    `${money(posted.data.runningFare.totalPaise)} vs expected ${money(expectedRunning.totalPaise)} ` +
      `(${posted.data.runningFare.items?.map((i) => `${i.key}:${i.amountPaise}`).join(', ')})`);
  // The owner's rule: the price shown for the mapped route is what is paid, and
  // the car running *inside* the band that price covers adds nothing.
  check('and while the dial is inside the priced band, not one paisa more than the quote',
    posted.data.runningFare.totalPaise === quote.breakdown.totalPaise &&
      posted.data.runningFare.items.length === quote.breakdown.items.length,
    `quoted ${money(quote.breakdown.totalPaise)} at ${(quote.distanceMeters / 1000).toFixed(1)} km, ` +
      `running ${money(posted.data.runningFare.totalPaise)} at 12 km`);
  // A further posting eight kilometres down the road has to show more money, as
  // extra kilometres at the chart's own rate — never a jump to a higher slab.
  const accrued = await callable(driver, 'recordOdometer', { bookingId, odometerKm: DIAL_RUNNING + 8 });
  const expectedAccrued = expectedFare(rule, DIAL_RUNNING + 8 - DIAL_OPEN, 'estimate', openDoc.tripStartedAtMs, quote.distanceMeters);
  // The ceiling of the band the quote was priced in, read off the same chart.
  const pricedUpToKm =
    [...rule.slabs]
      .sort((a, b) => a.upToKilometers - b.upToKilometers)
      .find((s) => quote.distanceMeters <= s.upToKilometers * 1000)?.upToKilometers ??
    Math.max(...rule.slabs.map((s) => s.upToKilometers));
  const expectedExtraPaise = Math.round(Math.max(0, 20 - pricedUpToKm) * rule.slabOverflowPerKmPaise);
  const accruedItems = accrued.data.runningFare.items ?? [];
  check('and the kilometres past that band are billed per kilometre, not by moving the trip onto a bigger slab',
    accrued.data.runningFare.totalPaise === expectedAccrued.totalPaise &&
      accrued.data.runningFare.totalPaise > posted.data.runningFare.totalPaise &&
      accruedItems.find((i) => i.key === 'slab_fare')?.amountPaise ===
        quote.breakdown.items.find((i) => i.key === 'slab_fare')?.amountPaise &&
      accruedItems.find((i) => i.key === 'distance')?.amountPaise === expectedExtraPaise,
    `${money(posted.data.runningFare.totalPaise)} at 12 km → ${money(accrued.data.runningFare.totalPaise)} at 20 km, ` +
      `with ${money(expectedExtraPaise)} for the km past ${pricedUpToKm} at ₹${rule.slabOverflowPerKmPaise / 100}/km`);
  const meterDoc = (await readBooking(bookingId)).data;
  const asCustomer = await fs.getDoc(fs.doc(customer.firestore, 'bookings', bookingId));
  check('and both apps read the same number off the booking',
    meterDoc.currentOdometerKm === DIAL_RUNNING + 8 &&
      asCustomer.data().currentOdometerKm === DIAL_RUNNING + 8 &&
      asCustomer.data().status === 'in_progress',
    `driver posted ${DIAL_RUNNING + 8}, customer sees ${asCustomer.data().currentOdometerKm}`);
  await expectRefusedByRules('the customer cannot write that number themselves',
    () => fs.updateDoc(fs.doc(customer.firestore, 'bookings', bookingId), { currentOdometerKm: 1 }));
  // The customer's app cannot post a reading, so the only running bill it can
  // show is the one the server left on the booking. It has to be the same
  // breakdown the driver was handed, or the two screens disagree about money.
  const storedRunning = asCustomer.data().runningFare;
  check('the booking carries the server’s running bill, item for item',
    storedRunning?.totalPaise === accrued.data.runningFare.totalPaise &&
      storedRunning?.subtotalPaise === accrued.data.runningFare.subtotalPaise &&
      storedRunning?.taxPaise === accrued.data.runningFare.taxPaise &&
      JSON.stringify(storedRunning?.items?.map((i) => [i.key, i.amountPaise])) ===
        JSON.stringify(accrued.data.runningFare.items?.map((i) => [i.key, i.amountPaise])),
    `${money(storedRunning?.totalPaise)} stored against ${money(accrued.data.runningFare.totalPaise)} returned ` +
      `(${storedRunning?.items?.map((i) => `${i.key}:${i.amountPaise}`).join(', ')})`);
  check('and it is metered from the dial, on the rule the trip was quoted at',
    storedRunning?.kind === 'estimate' && storedRunning?.pricingRuleId === ruleId,
    `kind=${storedRunning?.kind} rule=${storedRunning?.pricingRuleId}`);
  const strangerPost = await callFailure(
    callable(stranger, 'recordOdometer', { bookingId, odometerKm: DIAL_RUNNING + 1 }),
  );
  check('nor can any other driver post to it', strangerPost.code === 'permission-denied', strangerPost.code);

  const events = (await db.collection(`bookings/${bookingId}/events`).get()).docs.map((doc) => doc.data().type);
  check('every step of it is in the booking’s own event log',
    ['otp_sent', 'otp_verified', 'trip_started', 'odometer_recorded'].every((type) => events.includes(type)),
    events.join(', '));

  console.log('\n5. A code belongs to one trip and one stage of it');

  const { bookingId: other } = await bookAndAssign(customer, driver);
  const otherCodes = await callable(customer, 'tripCodes', { bookingId: other });
  check('the next booking gets its own pair of digits, not this trip’s',
    otherCodes.data.start !== startCode && otherCodes.data.end !== endCode,
    `${otherCodes.data.start} / ${otherCodes.data.end} on ${otherCodes.data.reference}`);

  const borrowedStart = await callFailure(
    callable(driver, 'verifyTripOtp', { bookingId: other, code: endCode, odometerKm: DIAL_OPEN }),
  );
  check('this trip’s end code does not open the next one',
    borrowedStart.code === 'permission-denied', `${borrowedStart.code}: ${borrowedStart.message.slice(0, 90)}`);
  const borrowedClose = await callFailure(
    callable(driver, 'confirmCompletion', { bookingId, code: otherCodes.data.start, odometerKm: DIAL_CLOSED }),
  );
  check('another trip’s start code does not close this one',
    borrowedClose.code === 'permission-denied', `${borrowedClose.code}: ${borrowedClose.message.slice(0, 90)}`);
  const untouched = (await readBooking(bookingId)).data;
  check('and both refusals left the trip running with no bill on it',
    untouched.status === 'in_progress' && untouched.finalFare === null && untouched.endOdometerKm === null,
    `${untouched.status}, endOdometerKm=${untouched.endOdometerKm}`);

  const otherStarted = await callFailure(
    callable(driver, 'verifyTripOtp', { bookingId: other, code: otherCodes.data.start, odometerKm: DIAL_OPEN }),
  );
  check('while each trip still opens with its own code, wrong guesses notwithstanding',
    otherStarted.code === 'no error', `${otherStarted.code}: ${otherStarted.message.slice(0, 90)}`);

  const spentAgain = await callable(customer, 'tripCodes', { bookingId });
  check('a consumed start code is still the same digits on the screen, not a fresh pair',
    spentAgain.data.start === startCode, `${spentAgain.data.start}`);

  console.log('\n6. The bill the car actually ran');

  const closed = await callable(driver, 'confirmCompletion', {
    bookingId,
    code: endCode,
    odometerKm: DIAL_CLOSED,
  });
  const expectedFinal = expectedFare(rule, DIAL_CLOSED - DIAL_OPEN, 'final', untouched.tripStartedAtMs, quote.distanceMeters);
  check('the closing reading prices the receipt off 35 km',
    closed.data.status === 'completed' && closed.data.actualDistanceMeters === 35_000,
    `${closed.data.status}, ${(closed.data.actualDistanceMeters ?? 0) / 1000} km`);
  check('at the same chart, through the same engine, on the band the customer confirmed',
    closed.data.finalFare.totalPaise === expectedFinal.totalPaise &&
      closed.data.finalFare.subtotalPaise === expectedFinal.subtotalPaise,
    `${money(closed.data.finalFare.totalPaise)} vs expected ${money(expectedFinal.totalPaise)} ` +
      `(quoted ${money(quote.breakdown.totalPaise)})`);
  check('so running further costs the quoted slab plus kilometres, never a larger slab',
    closed.data.finalFare.totalPaise > quote.breakdown.totalPaise &&
      closed.data.finalFare.items.find((i) => i.key === 'slab_fare')?.amountPaise ===
        quote.breakdown.items.find((i) => i.key === 'slab_fare')?.amountPaise &&
      closed.data.finalFare.items.some((i) => i.key === 'distance') &&
      closed.data.finalFare.pricingRuleId === ruleId,
    `${money(quote.breakdown.totalPaise)} for ${(quote.distanceMeters / 1000).toFixed(1)} km → ` +
      `${money(closed.data.finalFare.totalPaise)} for 35 km on ${closed.data.finalFare.pricingRuleId}`);
  const receiptItems = closed.data.finalFare.items ?? [];
  check('with the itemised lines the customer was shown, summing to the subtotal',
    receiptItems.length > 0 &&
      receiptItems.reduce((sum, item) => sum + item.amountPaise, 0) === closed.data.finalFare.subtotalPaise &&
      closed.data.finalFare.totalPaise === closed.data.finalFare.subtotalPaise + closed.data.finalFare.taxPaise,
    receiptItems.map((i) => `${i.label} ${money(i.amountPaise)}`).join(' + '));

  const summary = (await db.doc(`tripSummaries/${bookingId}`).get()).data() ?? null;
  check('and the accounting row says plainly that it was priced from the dial',
    summary?.pricedFromOdometer === true && summary?.startOdometerKm === DIAL_OPEN &&
      summary?.endOdometerKm === DIAL_CLOSED && summary?.actualDistanceMeters === 35_000,
    `${summary?.startOdometerKm}→${summary?.endOdometerKm}, ${summary?.actualDistanceMeters} m, ` +
      `${money(summary?.totalPaise ?? 0)}`);
  check('keeping the quoted distance beside it, so the difference is auditable',
    summary?.quotedDistanceMeters === quote.distanceMeters,
    `quoted ${((summary?.quotedDistanceMeters ?? 0) / 1000).toFixed(1)} km vs ran 35 km`);

  const closedGate = (await rtdb.ref(`authz/${bookingId}`).get()).val() ?? {};
  check('the tracking gate is shut the moment the trip is', closedGate.trackingEnabled === false,
    `trackingEnabled=${closedGate.trackingEnabled}`);
  check('and the booking is off the live list',
    (await rtdb.ref(`activeBookings/${bookingId}`).get()).exists() === false);

  const doubleClose = await callFailure(
    callable(driver, 'confirmCompletion', { bookingId, code: endCode, odometerKm: DIAL_CLOSED + 1 }),
  );
  check('a closed trip cannot be closed a second time', doubleClose.code === 'failed-precondition',
    `${doubleClose.code}: ${doubleClose.message.slice(0, 80)}`);

  console.log('\n7. What the completion owes the office');

  const dueId = `commission_${bookingId}`;
  const due = await waitForDue(driver.uid, dueId);
  check('one commission row appears for the trip that was just billed', due !== null, dueId);
  check('for exactly the amount the completion response named',
    due?.totalPaise === closed.data.commissionPaise,
    `ledger ${money(due?.totalPaise ?? 0)} vs screen ${money(closed.data.commissionPaise ?? 0)}`);
  // This chart carries no platform-fee line, so the base the office takes its
  // cut of is the whole subtotal — and none of the customer's GST.
  const feeLines = (expectedFinal.items ?? [])
    .filter((item) => item.key === 'platform_fee')
    .reduce((sum, item) => sum + item.amountPaise, 0);
  check('which is the office’s cut of the fare before its GST, and unpaid until it is collected',
    due?.kind === 'commission' && due?.status === 'unpaid' &&
      due?.commissionablePaise === expectedFinal.subtotalPaise - feeLines &&
      due?.basePaise === closed.data.commissionPaise - (due?.gstPaise ?? 0),
    `base ${money(due?.basePaise ?? 0)} + GST ${money(due?.gstPaise ?? 0)} on ${money(expectedFinal.subtotalPaise)}`);

  // The driver's Earnings card splits the trip using the booking's own commission
  // block, not the ledger row, so the two have to say the same thing. Before the
  // completion re-pinned it, a 35 km trip driven on a 13 km quote billed ₹72.21 in
  // the ledger while the driver's list showed ₹39.45 for the same booking.
  const pinnedCommission = (await db.doc(`bookings/${bookingId}`).get()).data()?.commission ?? null;
  check('and the booking itself carries those terms, not the ones the quote pinned',
    pinnedCommission?.totalPaise === due?.totalPaise &&
      pinnedCommission?.commissionablePaise === due?.commissionablePaise &&
      pinnedCommission?.rate === due?.rate,
    `booking ${money(pinnedCommission?.totalPaise ?? 0)} vs ledger ${money(due?.totalPaise ?? 0)}, ` +
      `on ${money(pinnedCommission?.commissionablePaise ?? 0)} commissionable`);

  const completionEvents = (await db.collection(`bookings/${bookingId}/events`).get())
    .docs.map((doc) => doc.data().type);
  check('every one of it logged against the booking for the office to read',
    ['fare_finalised', 'destination_detected', 'trip_completed'].every((type) => completionEvents.includes(type)),
    [...new Set(completionEvents)].join(', '));
} finally {
  console.log('\n8. Cleanup');
  for (const bookingId of createdBookings) {
    for (const collection of ['events', 'assignments']) {
      const docs = await db.collection(`bookings/${bookingId}/${collection}`).get();
      for (const doc of docs.docs) await doc.ref.delete();
    }
    for (const purpose of ['trip_start', 'trip_end']) {
      await db.doc(`otpCodes/${bookingId}_${purpose}`).delete();
    }
    await db.doc(`tripSummaries/${bookingId}`).delete();
    await db.doc(`users/${customer.uid}/notifications/codes_${bookingId}`).delete();
    await db.doc(`users/${customer.uid}/notifications/driver_${bookingId}`).delete();
    await db.doc(`bookings/${bookingId}`).delete();
    await rtdb.ref(`authz/${bookingId}`).remove();
    await rtdb.ref(`activeBookings/${bookingId}`).remove();
  }
  for (const made of throwawayDrivers) {
    const dues = await db.collection(`driverProfiles/${made.uid}/dues`).get();
    for (const doc of dues.docs) await doc.ref.delete();
    await db.doc(`driverProfiles/${made.uid}`).delete();
    await authAdmin.deleteUser(made.uid);
    const gone = await db.doc(`driverProfiles/${made.uid}`).get();
    check(`the ${made.label} driver, their ${dues.size} bill row(s) and their account are gone`,
      gone.exists === false, gone.exists ? 'profile survived' : 'removed');
  }
  for (const bookingId of createdBookings) {
    const left = await readBooking(bookingId);
    check(`booking ${bookingId} removed`, left.exists === false, left.exists ? 'still present' : 'removed');
  }
  await deleteApp(customer.app).catch(() => {});
}

console.log(
  failures.length > 0
    ? `\n${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`
    : '\nEvery trip-loop check passed: codes, both dial readings, the running meter, the bill off the odometer and the commission it raised.',
);
process.exit(failures.length > 0 ? 1 : 0);
