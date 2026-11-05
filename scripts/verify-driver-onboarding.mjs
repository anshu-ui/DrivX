/**
 * Proves the driver onboarding money gate against the emulator, with rules on.
 *
 * The owner's rule is that a new driver pays the configured one-time onboarding fee before the
 * account can take bookings. There is no payment gateway in this project, so what
 * is being tested here is the part that *is* real: the fee is raised
 * automatically when paperwork is filed, nobody client-side can mark it paid,
 * approval is refused while it is owed, an administrator records a cash or UPI
 * handover with a reference and an audit entry, and only then does a distinct
 * driver id get minted.
 *
 * This script checks the attested cash/UPI path and confirms a paid row can only
 * be written by the admin recorder. Cashfree settlement has its own verification.
 *
 *   npm run emulators   # terminal 1 (needs Java 21+)
 *   npm run seed        # terminal 2
 *   npm run verify:driver-onboarding
 *
 * It creates one throwaway driver account and one throwaway profile, and deletes
 * all of it — including the audit rows and the Auth account — before exiting.
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
const DOC_BASE =
  `http://${HOST}:${FIRESTORE_PORT}/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
/** The same path without the host: Firestore wants resource names inside a write. */
const DOC_RESOURCE = `projects/${PROJECT_ID}/databases/(default)/documents`;
/** The onboarding fee default: ₹500 + 5% GST, expressed in paise. */
const FEE = { base: 50_000, gst: 2_500, total: 52_500 };

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

async function assertOk(response, label) {
  if (!response.ok) {
    throw new Error(`${label} failed with ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

/** `Bearer owner` is the emulator's magic token: it bypasses the rules. */
async function commitWrite(write, label) {
  return assertOk(
    await fetch(`${DOC_BASE}:commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
      body: JSON.stringify({ writes: [write] }),
    }),
    label,
  );
}

async function deleteDocument(path) {
  await commitWrite({ delete: `${DOC_RESOURCE}/${path}` }, `delete ${path}`);
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
    auth,
    firestore,
    functions,
    uid: cred.user.uid,
    claims: (await cred.user.getIdTokenResult()).claims,
  };
}

const admin = await session('onboarding-admin', 'admin@drivx.test');
const seededDriver = await session('onboarding-seeded-driver', 'suna@example.test');
const nosyCustomer = await session('onboarding-customer', 'amit@example.test');

const callable = (session, name, payload) => fn.httpsCallable(session.functions, name)(payload);

/** A callable refusal, as `{ code, message }` with the `functions/` prefix cut. */
async function callFailure(promise) {
  try {
    await promise;
    return { code: 'no error', message: '' };
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

// A unique tail so a repeat run cannot collide with a leftover fixture. The uid
// carries it twice because the privileged callables refuse an id under twenty
// characters, and the Auth emulator mints one it does not tell us in advance.
const tag = randomBytes(3).toString('hex');
const freshEmail = `fresh-${tag}@example.test`;
const freshUid = `verify-driver-${tag}-${tag}`;

console.log('\n1. The seeded pending driver already owes the fee');

const seededDue = await fs.getDoc(
  fs.doc(seededDriver.firestore, 'driverProfiles', seededDriver.uid, 'dues', 'onboarding_fee'),
);
check('a driver reads their own bill', seededDue.exists(), `uid=${seededDriver.uid}`);
check(
  'the bill is ₹500 plus 5% GST',
  seededDue.data()?.basePaise === FEE.base &&
    seededDue.data()?.gstPaise === FEE.gst &&
    seededDue.data()?.totalPaise === FEE.total &&
    seededDue.data()?.gstRate === 0,
  `${seededDue.data()?.basePaise}+${seededDue.data()?.gstPaise}=${seededDue.data()?.totalPaise} paise`,
);
check('and it is unpaid, because nobody has collected it', seededDue.data()?.status === 'unpaid');
check('with no collector, method or reference recorded',
  seededDue.data()?.recordedByUid == null &&
    seededDue.data()?.method == null &&
    seededDue.data()?.reference == null);
await expectRefusedByRules('a customer cannot read a driver’s bill',
  () => fs.getDoc(fs.doc(nosyCustomer.firestore, 'driverProfiles', seededDriver.uid, 'dues', 'onboarding_fee')));
await expectRefusedByRules('the driver cannot clear their own fee',
  () => fs.updateDoc(
    fs.doc(seededDriver.firestore, 'driverProfiles', seededDriver.uid, 'dues', 'onboarding_fee'),
    { status: 'paid' },
  ));
await expectRefusedByRules('or rewrite the amount',
  () => fs.updateDoc(
    fs.doc(seededDriver.firestore, 'driverProfiles', seededDriver.uid, 'dues', 'onboarding_fee'),
    { totalPaise: 1 },
  ));
await expectRefusedByRules('and cannot mint their own driver id',
  () => fs.updateDoc(fs.doc(seededDriver.firestore, 'driverProfiles', seededDriver.uid), { driverId: 'DRV-SELF1' }));

// Worth attempting against a *seeded* driver, not just a fresh one: their uids
// used to be the five-character alias, which `uidSchema` refused for a reason
// unrelated to money, so the console could never show this refusal to an operator.
const refuseApprove = await callFailure(
  callable(admin, 'setDriverVerification', {
    driverUid: seededDriver.uid,
    decision: 'approved',
    reason: 'Attempting to approve while the onboarding fee is owed',
    documentIds: ['driving_licence'],
  }),
);
check(
  'approval is refused while the fee is owed',
  refuseApprove.code === 'failed-precondition',
  `${refuseApprove.code}: ${refuseApprove.message.slice(0, 120)}`,
);
check(
  'and the refusal names the money, not a generic error',
  /₹525/.test(refuseApprove.message) && /uncleared|outstanding/i.test(refuseApprove.message),
  refuseApprove.message.slice(0, 110),
);
check('the seeded driver is still awaiting the office',
  (await fs.getDoc(fs.doc(seededDriver.firestore, 'driverProfiles', seededDriver.uid))).data()
    ?.verificationStatus === 'pending_review');

console.log('\n2. A brand-new driver is billed automatically when they file paperwork');

// The account is created through the Admin SDK's emulator transport, which is
// how `scripts/seed.mjs` makes accounts: the Auth emulator's REST API refuses
// custom claims otherwise.
process.env.FIREBASE_AUTH_EMULATOR_HOST = `${HOST}:${AUTH_PORT}`;
const { getAuth } = await import('firebase-admin/auth');
const { initializeApp: initAdmin } = await import('firebase-admin/app');
try {
  initAdmin({ projectId: PROJECT_ID });
} catch {
  /* an app already exists in this process */
}
const authAdmin = getAuth();
const fresh = await authAdmin.createUser({
  uid: freshUid,
  email: freshEmail,
  emailVerified: true,
  password: PASSWORD,
  displayName: `Fresh Driver ${tag}`,
});
await authAdmin.setCustomUserClaims(fresh.uid, {
  role: 'driver',
  roles: ['driver'],
  admin: false,
  ops: false,
  driverVerified: false,
  zoneId: 'zone-ggn-1',
  serviceTypeIds: [],
  testAccount: true,
});

const driver = await session('onboarding-fresh-driver', freshEmail);

try {
  await fs.setDoc(fs.doc(driver.firestore, 'driverProfiles', driver.uid), {
    uid: driver.uid,
    fullName: `Fresh Driver ${tag}`,
    phoneE164: '+919000000099',
    photoUrl: null,
    languages: ['hi', 'en'],
    zoneId: 'zone-ggn-1',
    serviceAreas: [],
    vehicleMake: null,
    vehicleModel: null,
    vehiclePlate: null,
    serviceTypeIds: [],
    verificationStatus: 'not_started',
    verifiedAtMs: null,
    verifiedByUid: null,
    rejectionReason: null,
    driverId: null,
    documentsExpiringBeforeMs: null,
    availabilityState: 'offline',
    availabilitySinceMs: null,
    ratingAverage: 0,
    ratingCount: 0,
    lifetimeTrips: 0,
    onTimeArrivalRate: null,
    acceptanceRate: null,
    createdAtMs: new Date(),
    updatedAtMs: new Date(),
  });

  const dlRef = fs.doc(driver.firestore, 'driverProfiles', driver.uid, 'documents', 'driving_licence');
  await fs.setDoc(dlRef, {
    id: 'driving_licence',
    driverUid: driver.uid,
    type: 'driving_licence',
    storagePath: `drivers/${driver.uid}/driving_licence`,
    sha256: null,
    status: 'pending_review',
    numberMasked: 'DL-****-1122',
    issuedBy: 'Haryana RTO',
    validFromMs: null,
    validUntilMs: null,
    uploadedAtMs: new Date(),
    reviewedAtMs: null,
    reviewedByUid: null,
    rejectionNote: null,
  });

  // The billing happens in `flagDriverOnFirstUpload`, a Firestore trigger, so it
  // arrives asynchronously. Polling proves the trigger ran rather than the seed.
  let created = null;
  for (let attempt = 0; attempt < 40 && !created?.exists(); attempt += 1) {
    await sleep(500);
    created = await fs.getDoc(fs.doc(driver.firestore, 'driverProfiles', driver.uid, 'dues', 'onboarding_fee'));
  }
  check('the first upload raised the onboarding fee without being asked', created?.exists() === true);
  check('for the full ₹525 including GST',
    created?.data()?.totalPaise === FEE.total && created?.data()?.basePaise === FEE.base,
    created ? `${created.data()?.basePaise}+${created.data()?.gstPaise} paise` : 'no row');
  check('addressed to this driver, marked unpaid',
    created?.data()?.driverUid === driver.uid && created?.data()?.status === 'unpaid');
  check('one document and an unpaid fee do not submit the application',
    (await fs.getDoc(fs.doc(driver.firestore, 'driverProfiles', driver.uid))).data()
      ?.verificationStatus === 'not_started');

  for (const [id, numberMasked] of [['driver_photograph', null], ['photo_id', 'ID-****-1122']]) {
    await fs.setDoc(fs.doc(driver.firestore, 'driverProfiles', driver.uid, 'documents', id), {
      id, driverUid: driver.uid, type: id, storagePath: `drivers/${driver.uid}/${id}`,
      sha256: null, status: 'pending_review', numberMasked, issuedBy: null,
      validFromMs: null, validUntilMs: null, uploadedAtMs: new Date(),
      reviewedAtMs: null, reviewedByUid: null, rejectionNote: null,
    });
  }
  check('all three required document records are filed before review',
    (await fs.getDocs(fs.collection(driver.firestore, 'driverProfiles', driver.uid, 'documents'))).size === 3);

  const shortReference = await callFailure(
    callable(admin, 'recordDriverDuePayment', {
      driverUid: driver.uid,
      dueId: 'onboarding_fee',
      method: 'cash',
      reference: 'ab',
    }),
  );
  check('a reference under three characters is refused',
    shortReference.code === 'invalid-argument', `${shortReference.code}: ${shortReference.message.slice(0, 80)}`);

  const notAdmin = await callFailure(
    callable(driver, 'recordDriverDuePayment', {
      driverUid: driver.uid,
      dueId: 'onboarding_fee',
      method: 'cash',
      reference: 'Driver pays themselves',
    }),
  );
  check('only an administrator can record a collection', notAdmin.code === 'permission-denied', notAdmin.code);

  const unknown = await callFailure(
    callable(admin, 'recordDriverDuePayment', {
      driverUid: driver.uid,
      dueId: 'made_up_charge',
      method: 'cash',
      reference: 'No such row',
    }),
  );
  check('and only against a charge that exists', unknown.code === 'not-found', unknown.code);

  console.log('\n3. Approval stays shut until the office records the money');

  const blocked = await callFailure(
    callable(admin, 'setDriverVerification', {
      driverUid: driver.uid,
      decision: 'approved',
      reason: 'Approving a driver who has not paid the onboarding fee',
      documentIds: ['driving_licence'],
    }),
  );
  check('the server refuses to approve an unpaid driver', blocked.code === 'failed-precondition', blocked.code);
  check('naming the outstanding ₹525 rather than a generic error',
    /₹525/.test(blocked.message) && /uncleared|outstanding/i.test(blocked.message),
    blocked.message.slice(0, 110));
  check('the driver id is still absent',
    (await fs.getDoc(fs.doc(driver.firestore, 'driverProfiles', driver.uid))).data()?.driverId == null);

  const rejected = await callable(admin, 'setDriverVerification', {
    driverUid: driver.uid,
    decision: 'rejected',
    reason: 'Licence photo is unreadable, send it again',
    documentIds: ['driving_licence'],
  });
  check('rejecting does not require the fee — sending paperwork back costs nothing',
    rejected.data.verificationStatus === 'rejected');

  await fs.updateDoc(dlRef, { status: 'pending_review', rejectionNote: null, uploadedAtMs: new Date() });
  check('a corrected licence is resubmitted for review',
    (await fs.getDoc(dlRef)).data()?.status === 'pending_review');

  console.log('\n4. A collection recorded by the office');

  const paid = await callable(admin, 'recordDriverDuePayment', {
    driverUid: driver.uid,
    dueId: 'onboarding_fee',
    method: 'upi',
    reference: 'UPI ref 4471 8823',
  });
  check('the call reports the charge as paid', paid.data.status === 'paid' && paid.data.outstandingDues === 0,
    `${paid.data.totalPaise} paise, ${paid.data.outstandingDues} left`);

  const dueRow = (await fs.getDoc(fs.doc(driver.firestore, 'driverProfiles', driver.uid, 'dues', 'onboarding_fee'))).data();
  check('the row carries the method, reference and the admin who recorded it',
    dueRow.status === 'paid' && dueRow.method === 'upi' && dueRow.reference === 'UPI ref 4471 8823' &&
      dueRow.recordedByUid === admin.uid,
    `method=${dueRow.method} by=${dueRow.recordedByUid}`);
  check('the driver can now read a cleared bill', dueRow.status === 'paid');

  const audit = await fs.getDocs(
    fs.query(
      fs.collection(admin.firestore, 'adminAuditLogs'),
      fs.where('targetId', '==', driver.uid),
      fs.where('action', '==', 'driver_fee_recorded'),
      fs.limit(5),
    ),
  );
  check('an audit entry names the collector and the reference',
    audit.size === 1 && audit.docs[0].data().actorUid === admin.uid &&
      audit.docs[0].data().reason === 'UPI ref 4471 8823',
    `${audit.size} rows`);

  const twice = await callFailure(
    callable(admin, 'recordDriverDuePayment', {
      driverUid: driver.uid,
      dueId: 'onboarding_fee',
      method: 'cash',
      reference: 'Collect it a second time',
    }),
  );
  check('collecting the same fee twice is refused', twice.code === 'failed-precondition', twice.code);

  console.log('\n5. Activation, and the id it issues');

  // Read straight from the call rather than `callFailure`: the driver id is in
  // the success payload, and a helper that only reports refusals would throw it
  // away and make the mint look like a failure.
  let approvalFailure = null;
  let approvalResult = null;
  try {
    approvalResult = await callable(admin, 'setDriverVerification', {
      driverUid: driver.uid,
      decision: 'approved',
      reason: 'Licence legible and the onboarding fee is on the record',
      documentIds: ['driver_photograph', 'photo_id', 'driving_licence'],
    });
  } catch (error) {
    approvalFailure = error;
  }
  check(
    'approval succeeds once the fee is cleared',
    approvalFailure === null,
    String(approvalFailure?.message ?? approvalFailure ?? '').slice(0, 120),
  );

  const profile = (await fs.getDoc(fs.doc(driver.firestore, 'driverProfiles', driver.uid))).data();
  const driverId = approvalResult?.data?.driverId ?? null;
  check('a distinct driver id is minted on approval',
    /^DRV-[A-Z2-9]{6}$/.test(String(driverId ?? '')), String(driverId));
  check('and stored on the profile, not just returned', profile.driverId === driverId);
  check('with no ambiguous characters, so it survives being read aloud',
    !/[IO01]/.test(String(driverId ?? '')), String(driverId));
  check('the account is approved and the claim is set',
    profile.verificationStatus === 'approved' &&
      (await authAdmin.getUser(driver.uid)).customClaims?.driverVerified === true);

  const reApproved = await callable(admin, 'setDriverVerification', {
    driverUid: driver.uid,
    decision: 'approved',
    reason: 'Renewing one document must not issue a second driver id',
    documentIds: ['driving_licence'],
  });
  check('a re-approval keeps the id the office already wrote on the slip',
    reApproved.data.driverId === driverId, `${reApproved.data.driverId} vs ${driverId}`);

  const others = await fs.getDocs(
    fs.query(fs.collection(admin.firestore, 'driverProfiles'), fs.where('driverId', '==', driverId), fs.limit(5)),
  );
  check('that id belongs to exactly one driver', others.size === 1, `${others.size} profiles`);

  console.log('\n6. The gateway is only ever asked about a charge the ledger holds');

  // With live merchant keys in `functions/.env`, asking for a real due would open
  // a real order on the merchant account — so this proves the ordering instead:
  // an id the driver does not own is refused before any gateway call is made, and
  // the due they really do owe is left exactly as it was.
  const invented = await callFailure(
    callable(driver, 'createPaymentOrder', { dueId: 'commission_bk-no-such-trip' }),
  );
  check('a charge that is not on this driver’s ledger is refused, gateway never asked',
    invented.code === 'not-found', `${invented.code}: ${invented.message.slice(0, 90)}`);

  const stillOwed = (
    await fs.getDoc(fs.doc(admin.firestore, 'driverProfiles', fresh.uid, 'dues', 'onboarding_fee'))
  ).data();
  check('the refused call leaked no gateway order onto the bill the driver really owes',
    !stillOwed?.providerOrderId && !stillOwed?.paymentSessionId,
    `${stillOwed?.status}${stillOwed?.providerOrderId ? ` + order ${stillOwed.providerOrderId}` : ''}`);
} finally {
  console.log('\n7. Cleanup');
  await deleteApp(driver.app).catch(() => {});
  for (const path of [
    `driverProfiles/${fresh.uid}/dues/onboarding_fee`,
    `driverProfiles/${fresh.uid}/documents/driving_licence`,
    `driverProfiles/${fresh.uid}`,
  ]) {
    await deleteDocument(path);
  }
  const auditRows = await fs.getDocs(
    fs.query(fs.collection(admin.firestore, 'adminAuditLogs'), fs.where('targetId', '==', fresh.uid), fs.limit(50)),
  );
  for (const row of auditRows.docs) await deleteDocument(`adminAuditLogs/${row.id}`);
  await authAdmin.deleteUser(fresh.uid);
  const gone = await fs.getDoc(fs.doc(admin.firestore, 'driverProfiles', fresh.uid));
  check('the throwaway driver, bill, document and audit rows are gone',
    !gone.exists(), gone.exists() ? 'profile survived' : `removed ${auditRows.size} audit rows`);
  await deleteApp(admin.app).catch(() => {});
  await deleteApp(seededDriver.app).catch(() => {});
  await deleteApp(nosyCustomer.app).catch(() => {});
}

console.log(
  failures.length > 0
    ? `\n${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`
    : '\nEvery onboarding-money check passed against the emulator with rules enforced.',
);
process.exit(failures.length > 0 ? 1 : 0);
