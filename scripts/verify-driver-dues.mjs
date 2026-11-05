/**
 * Proves the trip-commission ledger against the emulator, with rules on.
 *
 * The owner's rule is the office's configured cut — 13% unless `appConfig/commission`
 * says otherwise — of the fare before its GST, plus 5% GST on that share, per
 * completed booking, and a driver who has not cleared what they owe stops
 * receiving bookings. There
 * is no payment gateway here and no trip-completion callable yet — Phase 4 owns
 * that — so what this script exercises is the part that is real today:
 *
 *   1. `status: completed` on an assigned, fare-bearing booking raises exactly
 *      one `commission_{bookingId}` row, at the domain's own numbers;
 *   2. retried events, a re-imported trip and a status flip cannot bill it twice;
 *   3. a trip that is not completed, or has no driver, raises nothing;
 *   4. nobody client-side can read another driver's bill or mark their own paid;
 *   5. while a row is unpaid the server refuses that driver an offer response and
 *      refuses to put them online — but never stops them going offline, and
 *      never touches a trip they are already carrying;
 *   6. an administrator's recorded collection is what lifts the hold;
 *   7. the rate comes from `appConfig/commission`, never from the fare's GST, the
 *      office's own fee line, or a number a client supplied.
 *
 * The completed bookings are written through the Admin SDK, which is exactly the
 * privilege Cloud Functions and a data import hold. Hand-writing a finished trip
 * is not a simulation of money: the fare the commission is computed from is the
 * one on the document, and the amount that lands on the ledger is recomputed by
 * the trigger, not asserted by this script.
 *
 *   npm run emulators   # terminal 1 (needs Java 21+)
 *   npm run seed        # terminal 2
 *   npm run verify:driver-dues
 *
 * It creates throwaway drivers, throwaway bookings and the rows they bill, then
 * deletes all of it, including the audit entries, the Auth accounts and the
 * commission config it moved.
 */
import { connect } from 'node:net';
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

/**
 * Trip fares and what the office's 13% makes of them.
 *
 * On the ₹960.00 pre-GST subtotal of the first trip, 13% is ₹124.80 and 5% GST
 * on that share is ₹6.24, so the driver owes ₹131.04. Commissioning the
 * ₹1,008.00 GST-inclusive receipt instead would also print ₹131.04 — with the
 * customer's tax and the platform's GST both at 5%, the two totals coincide to
 * the paisa. That is why the checks read `basePaise` and not only the total:
 * ₹124.80 is only reachable from a base the GST was taken out of.
 */
const TRIP_ONE = { base: 96_000, gst: 4_800, total: 100_800, commissionBase: 12_480, commissionGst: 624, commissionTotal: 13_104 };
const TRIP_TWO = { base: 30_500, gst: 1_525, total: 32_025, commissionBase: 3_965, commissionGst: 198, commissionTotal: 4_163 };

/** The same ₹960.00 subtotal with ₹50.00 of it being the office's own platform fee. */
const TRIP_WITH_FEE = {
  ...TRIP_ONE,
  lines: [
    { key: 'slab_fare', label: 'Fare', amountPaise: 91_000 },
    { key: 'platform_fee', label: 'Platform fee', amountPaise: 5_000 },
  ],
  commissionBase: 11_830,
  commissionGst: 592,
  commissionTotal: 12_422,
};

/** TRIP_TWO priced while the office has set its cut to 10%. */
const TRIP_AT_TEN = { ...TRIP_TWO, commissionBase: 3_050, commissionGst: 153, commissionTotal: 3_203 };

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
      `functions ${fnUp ? 'ok' : 'DOWN'} on ${HOST}).\nStart it with \`npm run emulators\`, then \`npm run seed\`.`,
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
  return {
    app,
    firestore,
    functions,
    uid: cred.user.uid,
    claims: (await cred.user.getIdTokenResult()).claims,
  };
}

const admin = await session('dues-admin', 'admin@drivx.test');
const ops = await session('dues-ops', 'ops@drivx.test');
const otherDriver = await session('dues-other-driver', 'rakesh@example.test');
const customer = await session('dues-customer', 'amit@example.test');

const callable = (session, name, payload) => fn.httpsCallable(session.functions, name)(payload);

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

/** The document trigger is a background function, so its work is not synchronous. */
async function waitForDue(duePath, attempts = 60) {
  let snap = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    snap = await getDocPrivileged(duePath);
    if (snap.exists) return snap;
    await sleep(500);
  }
  return snap;
}

// Privileged writes go through the Admin SDK: it holds the same bypass Cloud
// Functions and a data import hold, and it is what makes the booking document the
// trigger actually reads.
process.env.FIRESTORE_EMULATOR_HOST = `${HOST}:${FIRESTORE_PORT}`;
process.env.FIREBASE_AUTH_EMULATOR_HOST = `${HOST}:${AUTH_PORT}`;
const { getFirestore } = await import('firebase-admin/firestore');
const { getAuth } = await import('firebase-admin/auth');
const { initializeApp: initAdmin } = await import('firebase-admin/app');
try {
  initAdmin({ projectId: PROJECT_ID });
} catch {
  /* an app already exists in this process */
}
const db = getFirestore();
const authAdmin = getAuth();

async function getDocPrivileged(docPath) {
  const snap = await db.doc(docPath).get();
  return { exists: snap.exists, id: snap.id, data: snap.data() ?? null, ref: snap.ref };
}

const tag = randomBytes(3).toString('hex');
const bookingOne = `bk-dues-${tag}-one`;
const bookingTwo = `bk-dues-${tag}-two`;
const bookingOngoing = `bk-dues-${tag}-live`;
const bookingUnassigned = `bk-dues-${tag}-free`;
const bookingWithFee = `bk-dues-${tag}-fee`;
const bookingReRated = `bk-dues-${tag}-rate`;
const bookingPinned = `bk-dues-${tag}-pinned`;
const bookingBogusRate = `bk-dues-${tag}-bogus`;

/**
 * A booking the way `createBooking` writes one, so the trigger reads a real
 * document: the fare engine's own breakdown, with `items` summing to the
 * subtotal and GST sitting on top of it rather than inside it.
 */
function bookingBody(id, reference, trip, status, driverField, extra = {}) {
  return {
    id,
    reference,
    customerUid: customer.uid,
    ...driverField,
    status,
    serviceTypeId: 'cab-ac',
    zoneId: 'zone-ggn-1',
    currency: 'INR',
    estimate: {
      kind: 'estimate',
      currency: 'INR',
      items: trip.lines ?? [{ key: 'slab_fare', label: 'Distance', amountPaise: trip.base }],
      subtotalPaise: trip.base,
      taxPaise: trip.gst,
      totalPaise: trip.total,
    },
    finalFare: null,
    createdAtMs: Date.now() - 6_000_000,
    completedAtMs: status === 'completed' ? Date.now() - 60_000 : null,
    ...extra,
  };
}

const throwawayDrivers = [];
/** The office's own cut, as the seed left it, so the finally can put it back. */
let commissionConfig = null;

/**
 * A verified driver with nothing billed yet and a session signed in as them.
 *
 * Two are made: one to be held over money, one to carry the rate experiments, so
 * moving `appConfig/commission` halfway through cannot change what the first one
 * owes while its hold is being checked.
 */
async function makeDriver(label) {
  // The uid carries the tag twice: the privileged callables refuse an id under
  // twenty characters, and the Auth emulator mints one it never tells us in advance.
  const uid = `verify-dues-${label}-${tag}-${tag}`;
  const email = `dues-${label}-${tag}@example.test`;
  await authAdmin.createUser({
    uid,
    email,
    emailVerified: true,
    password: PASSWORD,
    displayName: `Dues Driver ${label} ${tag}`,
  });
  await authAdmin.setCustomUserClaims(uid, {
    role: 'driver',
    roles: ['driver'],
    admin: false,
    ops: false,
    // Verified, so the hold under test is the money and not the paperwork.
    driverVerified: true,
    zoneId: 'zone-ggn-1',
    serviceTypeIds: [],
    testAccount: true,
  });
  await db.doc(`driverProfiles/${uid}`).set({
    uid,
    fullName: `Dues Driver ${label} ${tag}`,
    phoneE164: `+91900000009${throwawayDrivers.length}`,
    verificationStatus: 'approved',
    driverId: `DRV-${label.toUpperCase()}-${tag.toUpperCase()}`,
    availabilityState: 'offline',
    zoneId: 'zone-ggn-1',
    ratingAverage: 4.8,
    ratingCount: 12,
    lifetimeTrips: 2,
    createdAtMs: Date.now() - 86_400_000,
    updatedAtMs: Date.now(),
  });
  const made = { uid, email, label, ...(await session(`dues-driver-${label}`, email)) };
  throwawayDrivers.push(made);
  return made;
}

console.log('\n1. A completed trip raises its own commission row');

const driver = await makeDriver('held');
const { uid: driverUid } = driver;

try {
  const before = await db.collection(`driverProfiles/${driverUid}/dues`).get();
  check('a verified driver starts with no bill', before.size === 0, `${before.size} rows`);

  await db.doc(`bookings/${bookingOne}`).set(
    bookingBody(bookingOne, `DRX-${tag.toUpperCase()}A`, TRIP_ONE, 'completed', { assignedDriverUid: driverUid }),
  );
  const dueOne = await waitForDue(`driverProfiles/${driverUid}/dues/commission_${bookingOne}`);
  check('the completed booking raised a commission row on its own', dueOne?.exists === true);

  const one = dueOne?.data ?? {};
  check(
    'at the office’s 13% of the fare before its own GST, plus 5% GST on that',
    one.basePaise === TRIP_ONE.commissionBase &&
      one.gstRate === 0.05 &&
      one.gstPaise === TRIP_ONE.commissionGst &&
      one.totalPaise === TRIP_ONE.commissionTotal,
    `${one.basePaise}+${one.gstPaise}=${one.totalPaise} paise, expected ${TRIP_ONE.commissionBase}+${TRIP_ONE.commissionGst}=${TRIP_ONE.commissionTotal}`,
  );
  check(
    'so the customer’s tax is never part of the base',
    one.basePaise !== Math.round(TRIP_ONE.total * 0.13),
    `13% of the ₹1,008.00 receipt would be ${Math.round(TRIP_ONE.total * 0.13)} paise, not ${TRIP_ONE.commissionBase}`,
  );
  check('the row is addressed, unpaid, and names its trip',
    one.driverUid === driverUid && one.kind === 'commission' && one.status === 'unpaid' && one.bookingId === bookingOne,
    `kind=${one.kind} status=${one.status} booking=${one.bookingId}`);
  check('and is titled with the booking reference the office reads',
    typeof one.title === 'string' && one.title.includes(`DRX-${tag.toUpperCase()}A`), String(one.title));
  check('with no collector, method or reference recorded',
    one.recordedByUid == null && one.method == null && one.reference == null);

  console.log('\n2. Every trip bills itself, and no trip bills twice');

  await db.doc(`bookings/${bookingTwo}`).set(
    bookingBody(bookingTwo, `DRX-${tag.toUpperCase()}B`, TRIP_TWO, 'completed', { assignedDriverUid: driverUid }),
  );
  const dueTwo = await waitForDue(`driverProfiles/${driverUid}/dues/commission_${bookingTwo}`);
  check('a second completed trip raised its own row', dueTwo?.exists === true);
  check('with its own amount, not a copy of the first',
    dueTwo?.data?.basePaise === TRIP_TWO.commissionBase && dueTwo?.data?.totalPaise === TRIP_TWO.commissionTotal,
    `${dueTwo?.data?.totalPaise} paise`);

  // A re-run of the event: the trip is already `completed`, so the update trigger
  // should not even try, and the derived id means a retry collides rather than
  // bills again.
  await db.doc(`bookings/${bookingOne}`).set({ updatedAtMs: Date.now() }, { merge: true });
  await db.doc(`bookings/${bookingOne}`).update({ status: 'cancelled' });
  await db.doc(`bookings/${bookingOne}`).update({ status: 'completed' });
  await sleep(2_500);
  const rowsAfterRetry = await db.collection(`driverProfiles/${driverUid}/dues`).get();
  check('a trip closed, reopened and closed again is still billed once', rowsAfterRetry.size === 2, `${rowsAfterRetry.size} rows`);
  const stillOne = await getDocPrivileged(`driverProfiles/${driverUid}/dues/commission_${bookingOne}`);
  check('and the original amount was not rewritten by the retry',
    stillOne.data?.totalPaise === TRIP_ONE.commissionTotal, `${stillOne.data?.totalPaise} paise`);

  // Nothing billable: a trip nobody drove, and one that has not finished.
  await db.doc(`bookings/${bookingUnassigned}`).set(
    bookingBody(bookingUnassigned, `DRX-${tag.toUpperCase()}C`, TRIP_ONE, 'completed', { assignedDriverUid: null }),
  );
  await db.doc(`bookings/${bookingOngoing}`).set(
    bookingBody(bookingOngoing, `DRX-${tag.toUpperCase()}D`, TRIP_TWO, 'in_progress', { assignedDriverUid: driverUid }),
  );
  await sleep(2_500);
  const finalRows = await db.collection(`driverProfiles/${driverUid}/dues`).get();
  check('an unfinished trip raises nothing', finalRows.size === 2, `${finalRows.size} rows`);
  const freeRow = await getDocPrivileged(`driverProfiles/${driverUid}/dues/commission_${bookingUnassigned}`);
  check('and a trip with no assigned driver raises nothing on anyone', freeRow?.exists !== true);

  console.log('\n3. Whose bill is whose');

  const ownRow = await fs.getDoc(
    fs.doc(driver.firestore, 'driverProfiles', driverUid, 'dues', `commission_${bookingOne}`),
  );
  check('a driver reads their own commission', ownRow.exists && ownRow.data().totalPaise === TRIP_ONE.commissionTotal,
    `${ownRow.data()?.totalPaise} paise`);
  await expectRefusedByRules('another driver cannot read it',
    () => fs.getDoc(fs.doc(otherDriver.firestore, 'driverProfiles', driverUid, 'dues', `commission_${bookingOne}`)));
  await expectRefusedByRules('nor can a customer',
    () => fs.getDoc(fs.doc(customer.firestore, 'driverProfiles', driverUid, 'dues', `commission_${bookingOne}`)));
  await expectRefusedByRules('the driver cannot mark it paid',
    () => fs.updateDoc(
      fs.doc(driver.firestore, 'driverProfiles', driverUid, 'dues', `commission_${bookingOne}`),
      { status: 'paid' },
    ));
  await expectRefusedByRules('nor shrink it',
    () => fs.updateDoc(
      fs.doc(driver.firestore, 'driverProfiles', driverUid, 'dues', `commission_${bookingOne}`),
      { totalPaise: 1 },
    ));
  await expectRefusedByRules('and cannot delete the row',
    () => fs.deleteDoc(
      fs.doc(driver.firestore, 'driverProfiles', driverUid, 'dues', `commission_${bookingOne}`),
    ));

  const groupAs = async (who) => {
    const snap = await fs.getDocs(fs.query(fs.collectionGroup(who.firestore, 'dues'), fs.where('status', '==', 'unpaid')));
    return snap.docs.map((doc) => doc.ref.path);
  };
  const staffPaths = await groupAs(admin);
  check('the console’s outstanding list reaches an administrator',
    staffPaths.includes(`driverProfiles/${driverUid}/dues/commission_${bookingOne}`), `${staffPaths.length} rows`);
  const opsPaths = await groupAs(ops);
  check('and to operations staff, who read operations but decide nothing',
    opsPaths.includes(`driverProfiles/${driverUid}/dues/commission_${bookingTwo}`), `${opsPaths.length} rows`);
  await expectRefusedByRules('a driver cannot list everyone’s dues',
    () => fs.getDocs(fs.query(fs.collectionGroup(driver.firestore, 'dues'), fs.where('status', '==', 'unpaid'))));
  await expectRefusedByRules('nor can a customer',
    () => fs.getDocs(fs.query(fs.collectionGroup(customer.firestore, 'dues'), fs.where('status', '==', 'unpaid'))));

  console.log('\n4. New work is held while a row is unpaid');

  const owedPaise = TRIP_ONE.commissionTotal + TRIP_TWO.commissionTotal;
  const online = await callFailure(callable(driver, 'setAvailability', { state: 'online' }));
  check('going online is refused', online.code === 'failed-precondition', `${online.code}: ${online.message.slice(0, 120)}`);
  check('the refusal names the amount and that it is commission',
    /172\.67/.test(online.message) && /commission/i.test(online.message), online.message.slice(0, 140));

  const accept = await callFailure(
    callable(driver, 'respondToAssignment', { bookingId: bookingOne, decision: 'accept' }),
  );
  check('answering an offer is refused the same way', accept.code === 'failed-precondition', accept.code);
  const decline = await callFailure(
    callable(driver, 'respondToAssignment', { bookingId: bookingOne, decision: 'decline', reason: 'Not in that area' }),
  );
  check('and refusing an offer is held too, so a driver cannot sit on a queue they cannot work',
    decline.code === 'failed-precondition', decline.code);

  const offline = await callFailure(callable(driver, 'setAvailability', { state: 'offline' }));
  check('stopping work is never held over money', offline.code === 'unimplemented',
    `${offline.code}: ${offline.message.slice(0, 90)}`);

  const tracking = await callFailure(
    callable(driver, 'publishDriverLocation', {
      bookingId: bookingTwo,
      lat: 28.4595,
      lng: 77.0266,
      accuracyMeters: 12,
      fixTimeMs: Date.now(),
    }),
  );
  check('a trip already being carried is never cut off over money',
    tracking.code === 'unimplemented', `${tracking.code}: ${tracking.message.slice(0, 90)}`);

  console.log('\n5. What it takes to clear a row');

  const opsRecords = await callFailure(
    callable(ops, 'recordDriverDuePayment', {
      driverUid,
      dueId: `commission_${bookingOne}`,
      method: 'cash',
      reference: 'Ops tries to close it',
    }),
  );
  check('operations staff cannot record a collection', opsRecords.code === 'permission-denied', opsRecords.code);

  const firstCollection = await callable(admin, 'recordDriverDuePayment', {
    driverUid,
    dueId: `commission_${bookingOne}`,
    method: 'upi',
    reference: `UPI ref dues-${tag}`,
  });
  check('one recorded collection clears exactly that trip',
    firstCollection.data.totalPaise === TRIP_ONE.commissionTotal &&
      firstCollection.data.outstandingDues === 1,
    `${firstCollection.data.totalPaise} paise, ${firstCollection.data.outstandingDues} left`);

  const secondCollection = await callable(admin, 'recordDriverDuePayment', {
    driverUid,
    dueId: `commission_${bookingTwo}`,
    method: 'cash',
    reference: `Receipt ${tag}`,
  });
  check('and the ledger is empty once both trips are in', secondCollection.data.outstandingDues === 0,
    `${secondCollection.data.totalPaise} paise, ${secondCollection.data.outstandingDues} left`);

  const audit = await fs.getDocs(
    fs.query(
      fs.collection(admin.firestore, 'adminAuditLogs'),
      fs.where('targetId', '==', driverUid),
      fs.where('action', '==', 'driver_fee_recorded'),
      fs.limit(10),
    ),
  );
  check('each collection has its own audit entry naming the collector',
    audit.size === 2 && audit.docs.every((doc) => doc.data().actorUid === admin.uid), `${audit.size} rows`);

  console.log('\n6. The hold lifts, and a paid trip does not come back');

  const onlineAgain = await callFailure(callable(driver, 'setAvailability', { state: 'online' }));
  check('going online now reaches Phase 3 instead of the money refusal',
    onlineAgain.code === 'unimplemented', `${onlineAgain.code}: ${onlineAgain.message.slice(0, 90)}`);
  const acceptAgain = await callFailure(
    callable(driver, 'respondToAssignment', { bookingId: bookingOne, decision: 'accept' }),
  );
  check('and so does answering an offer', acceptAgain.code === 'unimplemented', acceptAgain.code);

  // Re-running the billing event after collection: the derived id collides with
  // the paid row, so a completed trip can never be charged a second time.
  await db.doc(`bookings/${bookingOne}`).update({ status: 'cancelled' });
  await db.doc(`bookings/${bookingOne}`).update({ status: 'completed' });
  await sleep(2_500);
  const afterRebill = await getDocPrivileged(`driverProfiles/${driverUid}/dues/commission_${bookingOne}`);
  const rowCount = (await db.collection(`driverProfiles/${driverUid}/dues`).get()).size;
  check('a cleared trip is not billed again by a later event',
    afterRebill.data?.status === 'paid' && rowCount === 2, `${afterRebill.data?.status}, ${rowCount} rows`);

  const owedNow = await callFailure(callable(driver, 'setAvailability', { state: 'online' }));
  check('with nothing owed the driver stays allowed to work', owedNow.code === 'unimplemented', owedNow.code);

  console.log(`\n(both trips together came to ₹${(owedPaise / 100).toFixed(2)})`);

  console.log('\n7. The cut the office sets is the cut the trip is billed at');

  // Its own driver, so moving the office's rate here cannot change what the
  // held driver owes while the hold above is still being read.
  const rateDriver = await makeDriver('rate');
  const billedTo = (bookingId) => waitForDue(`driverProfiles/${rateDriver.uid}/dues/commission_${bookingId}`);
  commissionConfig = (await db.doc('appConfig/commission').get()).data() ?? null;
  check('the office’s cut is a document the ledger reads, seeded at 13%',
    commissionConfig?.rate === 0.13, `${commissionConfig?.rate}`);

  // ₹50.00 of this ₹960.00 subtotal is the office's own platform fee, which the
  // driver never earned, so the 13% falls on the remaining ₹910.00. The customer's
  // GST is out of the base the same way — it is never in `subtotalPaise`. Tolls,
  // parking and tips have no line in a breakdown at all, because the customer
  // hands those over on the spot, so there is nothing here to commission.
  await db.doc(`bookings/${bookingWithFee}`).set(
    bookingBody(bookingWithFee, `DRX-${tag.toUpperCase()}E`, TRIP_WITH_FEE, 'completed', { assignedDriverUid: rateDriver.uid }),
  );
  const feeRow = await billedTo(bookingWithFee);
  check('the office’s own fee line is not commissioned',
    feeRow.data?.commissionablePaise === 91_000 && feeRow.data?.basePaise === TRIP_WITH_FEE.commissionBase,
    `${feeRow.data?.basePaise} paise on a ${feeRow.data?.commissionablePaise} paise base, ` +
      `expected ${TRIP_WITH_FEE.commissionBase} on 91000`);

  await db.doc('appConfig/commission').set(
    { rate: 0.1, gstRate: 0.05, updatedByUid: 'verify-dues', updatedAtMs: Date.now() },
    { merge: true },
  );
  await db.doc(`bookings/${bookingReRated}`).set(
    bookingBody(bookingReRated, `DRX-${tag.toUpperCase()}F`, TRIP_TWO, 'completed', { assignedDriverUid: rateDriver.uid }),
  );
  const reRated = await billedTo(bookingReRated);
  check('a trip taken after the office lowers its cut is billed at the new one',
    reRated.data?.rate === 0.1 && reRated.data?.totalPaise === TRIP_AT_TEN.commissionTotal,
    `${reRated.data?.rate} → ${reRated.data?.totalPaise} paise, expected 0.1 → ${TRIP_AT_TEN.commissionTotal}`);

  // Every booking `createBooking` takes carries the terms it was quoted on, and
  // the ledger bills from them rather than from today's figure — a driver who
  // agreed ₹131.04 on a trip cannot be re-billed ₹96.00 because the office
  // changed its mind after the trip was driven.
  await db.doc(`bookings/${bookingPinned}`).set(
    bookingBody(bookingPinned, `DRX-${tag.toUpperCase()}G`, TRIP_ONE, 'completed', { assignedDriverUid: rateDriver.uid }, {
      commission: {
        rate: 0.13,
        gstRate: 0.05,
        commissionablePaise: TRIP_ONE.base,
        basePaise: TRIP_ONE.commissionBase,
        gstPaise: TRIP_ONE.commissionGst,
        totalPaise: TRIP_ONE.commissionTotal,
      },
    }),
  );
  const pinned = await billedTo(bookingPinned);
  check('a trip that carries its own terms keeps them while the configured rate is 10%',
    pinned.data?.rate === 0.13 && pinned.data?.totalPaise === TRIP_ONE.commissionTotal,
    `${pinned.data?.rate} → ${pinned.data?.totalPaise} paise`);

  // The document is edited by a person, so the boundary is tested: 5 is not a
  // fraction of a fare, and charging it would bill five times the trip.
  await db.doc('appConfig/commission').set({ rate: 5 }, { merge: true });
  await db.doc(`bookings/${bookingBogusRate}`).set(
    bookingBody(bookingBogusRate, `DRX-${tag.toUpperCase()}H`, TRIP_ONE, 'completed', { assignedDriverUid: rateDriver.uid }),
  );
  const bogus = await billedTo(bookingBogusRate);
  check('a rate that is not a fraction of the fare is refused and the default charged',
    bogus.data?.rate === 0.13 && bogus.data?.totalPaise === TRIP_ONE.commissionTotal,
    `${bogus.data?.rate} → ${bogus.data?.totalPaise} paise`);

  const rateRows = await db.collection(`driverProfiles/${rateDriver.uid}/dues`).get();
  check('and each of those four trips billed exactly one row', rateRows.size === 4, `${rateRows.size} rows`);
} finally {
  console.log('\n8. Cleanup');
  const allBookings = [
    bookingOne, bookingTwo, bookingOngoing, bookingUnassigned,
    bookingWithFee, bookingReRated, bookingPinned, bookingBogusRate,
  ];
  for (const docPath of allBookings.map((id) => `bookings/${id}`)) {
    await db.doc(docPath).delete();
  }
  for (const made of throwawayDrivers) {
    const rows = await db.collection(`driverProfiles/${made.uid}/dues`).get();
    for (const row of rows.docs) await row.ref.delete();
    await db.doc(`driverProfiles/${made.uid}`).delete();
    const auditRows = await fs.getDocs(
      fs.query(fs.collection(admin.firestore, 'adminAuditLogs'), fs.where('targetId', '==', made.uid), fs.limit(50)),
    );
    for (const row of auditRows.docs) await db.doc(`adminAuditLogs/${row.id}`).delete();
    await authAdmin.deleteUser(made.uid);
    const gone = await getDocPrivileged(`driverProfiles/${made.uid}`);
    check(`the ${made.label} driver, their ${rows.size} bill rows and ${auditRows.size} audit rows are gone`,
      gone.exists !== true, gone.exists ? 'profile survived' : 'removed');
  }
  if (commissionConfig) {
    await db.doc('appConfig/commission').set(commissionConfig);
    const restored = await getDocPrivileged('appConfig/commission');
    check('the office’s commission config is back as the seed wrote it',
      restored.data?.rate === 0.13, `${restored.data?.rate}`);
  }
  for (const id of allBookings) {
    const booking = await getDocPrivileged(`bookings/${id}`);
    if (booking.exists) check(`booking ${id} removed`, false, 'still present');
  }
  for (const made of [...throwawayDrivers, admin, ops, otherDriver, customer]) {
    await deleteApp(made.app).catch(() => {});
  }
}

console.log(
  failures.length > 0
    ? `\n${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`
    : '\nEvery trip-commission and dues-gating check passed against the emulator with rules enforced.',
);
process.exit(failures.length > 0 ? 1 : 0);
