/**
 * Proves the customer app's data paths against the emulator, with rules on.
 *
 * Every query and write below restates one hook from
 * `apps/mobile/src/features/customer/` — same filter, same limit, same payload
 * keys — over a real signed-in session, so a passing line here means the screen
 * it mirrors genuinely works on a device with the same rules. Nothing is stubbed
 * and nothing is asserted that the emulator did not answer.
 *
 * The session is the seeded email/password account, which is also what the app's
 * "Developer sign-in" uses. The phone-OTP leg is covered separately by
 * `npm run verify:phone-otp`; what matters for rules is the token's claims, and
 * both paths end up with the same `role: customer` claim.
 *
 *   npm run emulators   # terminal 1 (needs Java 21+)
 *   npm run seed        # terminal 2
 *   npm run verify:customer-paths
 */
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// Node ESM resolves `@drivx/domain` to its TypeScript source, which only Metro
// can load, so the shared schemas come from the built CommonJS bundle instead.
const { emailSchema } = createRequire(import.meta.url)('@drivx/domain');

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

const { initializeApp, deleteApp } = await import('firebase/app');
const authMod = await import('firebase/auth');
const fs = await import('firebase/firestore');
const fn = await import('firebase/functions');

/** Run `operation` and report whether the rules refused it (and with which code). */
async function refusal(operation) {
  try {
    await operation();
    return null;
  } catch (error) {
    return error?.code ?? 'unknown';
  }
}

async function expectRefused(label, operation) {
  const code = await refusal(operation);
  check(label, code === 'permission-denied', code ?? 'the rules allowed it');
}

/** A callable refusal arrives prefixed `functions/`, so compare on the suffix. */
async function callableCode(operation) {
  const code = await refusal(operation);
  return code === null ? 'no error' : String(code).replace('functions/', '');
}

/**
 * A callable's refusal with both its code and its message.
 *
 * The code decides whether the app can react, but the message is what the
 * customer reads, so a check on the wording is a check on the product.
 */
async function callFailure(operation) {
  try {
    await operation();
    return { code: 'no error', message: '' };
  } catch (error) {
    return {
      code: String(error?.code ?? 'unknown').replace('functions/', ''),
      message: String(error?.message ?? error),
    };
  }
}

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
  return { app, cred, auth, firestore, functions, uid: cred.user.uid, claims: (await cred.user.getIdTokenResult()).claims };
}

const [authUp, storeUp, fnUp] = await Promise.all([reachable(AUTH_PORT), reachable(FIRESTORE_PORT), reachable(FUNCTIONS_PORT)]);
if (!authUp || !storeUp || !fnUp) {
  console.error(
    `Emulator not reachable (auth ${authUp ? 'ok' : 'DOWN'}, firestore ${storeUp ? 'ok' : 'DOWN'}, ` +
      `functions ${fnUp ? 'ok' : 'DOWN'} on ${HOST}).\nStart it with \`npm run emulators\`, then \`npm run seed\`.`,
  );
  process.exit(1);
}

const customer = await session('verify-customer', 'amit@example.test');
const other = await session('verify-other-customer', 'priya@example.test');
const admin = await session('verify-admin', 'admin@drivx.test');
const driver = await session('verify-driver', 'rakesh@example.test');
const db = () => customer.firestore;

console.log('\n1. Session and claims');
check('signed in as a seeded customer', customer.claims?.role === 'customer', `uid=${customer.uid}`);
check('no privileged claim on a customer token', customer.claims?.admin !== true && customer.claims?.ops !== true);
check('second customer is a different account', other.uid !== customer.uid);

console.log('\n2. Reads — the exact queries the screens issue');

const bookings = await fs.getDocs(
  fs.query(fs.collection(db(), 'bookings'), fs.where('customerUid', '==', customer.uid), fs.orderBy('createdAtMs', 'desc'), fs.limit(25)),
);
check('useMyBookings returns the customer’s own trips', bookings.size >= 2, `${bookings.size} rows`);
const live = bookings.docs.find((row) => row.data().status === 'driver_en_route');
check('the en-route booking is visible for the live card', Boolean(live), live?.data().reference);
const finished = bookings.docs.find((row) => row.data().status === 'completed');
check('a completed trip carries a final fare', Boolean(finished?.data().finalFare),
  finished ? `₹${(finished.data().finalFare.totalPaise / 100).toFixed(2)} over ${finished.data().finalFare.items.length} lines` : undefined);
check('every row belongs to this customer', bookings.docs.every((row) => row.data().customerUid === customer.uid));

const detail = await Promise.all([
  fs.getDoc(fs.doc(db(), 'bookings', finished.id)),
  fs.getDoc(fs.doc(db(), 'tripSummaries', finished.id)),
  fs.getDocs(fs.query(fs.collection(db(), 'bookings', finished.id, 'events'), fs.limit(50))),
]);
check('useBookingDetail reads booking + summary + events', detail[0].exists() && detail[1].exists() && detail[2].size > 0,
  `${detail[2].size} events, ${detail[1].data()?.distanceMeters} m`);
const addressKeys = Object.keys(detail[0].data().pickup);
check('pickup is a full Place, so no row renders “Not set”',
  ['label', 'addressLine1', 'city', 'state', 'location', 'source'].every((key) => addressKeys.includes(key)),
  addressKeys.join(','));

const places = await fs.getDocs(
  fs.query(fs.collection(db(), 'savedPlaces', customer.uid, 'places'), fs.where('uid', '==', customer.uid), fs.limit(20)),
);
check('useSavedPlaces has at least two places, so the booking sheet works', places.size >= 2, `${places.size} places`);

const notifications = await fs.getDocs(fs.query(fs.collection(db(), 'users', customer.uid, 'notifications'), fs.limit(25)));
check('useNotifications reads the inbox', notifications.size >= 1, `${notifications.size} rows`);

const tickets = await fs.getDocs(
  fs.query(fs.collection(db(), 'supportTickets'), fs.where('openedByUid', '==', customer.uid), fs.orderBy('createdAtMs', 'desc'), fs.limit(20)),
);
check('useMyTickets lists only this customer’s tickets', tickets.size >= 1 && tickets.docs.every((row) => row.data().openedByUid === customer.uid),
  `${tickets.size} rows`);

const profile = await fs.getDoc(fs.doc(db(), 'customerProfiles', customer.uid));
check('useCustomerProfile reads the profile fields the account screen binds',
  Boolean(profile.data()?.preferredTransmission) && Boolean(profile.data()?.privacy) && 'email' in profile.data(),
  `transmission=${profile.data()?.preferredTransmission} email=${profile.data()?.email}`);

console.log('\n3. Reads the rules must refuse');
const othersBooking = (
  await fs.getDocs(
    fs.query(fs.collection(other.firestore, 'bookings'), fs.where('customerUid', '==', other.uid), fs.orderBy('createdAtMs', 'desc'), fs.limit(25)),
  )
).docs[0];
check('the other customer sees only their own trips', othersBooking?.data().customerUid === other.uid,
  `${othersBooking?.id ?? 'no rows'}`);
await expectRefused('another customer’s booking is invisible',
  () => fs.getDoc(fs.doc(db(), 'bookings', othersBooking.id)));
await expectRefused('the same booking read as a stranger is denied',
  () => fs.getDoc(fs.doc(other.firestore, 'bookings', bookings.docs[0].id)));
await expectRefused('bookings without the ownership filter are not served',
  () => fs.getDocs(fs.query(fs.collection(db(), 'bookings'), fs.limit(25))));
await expectRefused('the driver profile behind a trip is not customer-readable',
  () => fs.getDoc(fs.doc(db(), 'driverProfiles', bookings.docs[0].data().assignedDriverUid)));
await expectRefused('the assignment record is not customer-readable',
  () => fs.getDoc(fs.doc(db(), 'bookings', bookings.docs[0].id, 'assignments', 'as-1')));
await expectRefused('another customer’s saved places are invisible',
  () => fs.getDocs(fs.query(fs.collection(customer.firestore, 'savedPlaces', other.uid, 'places'), fs.limit(20))));

console.log('\n4. Writes the customer app performs');
const placeId = `verify-${Date.now().toString(36)}`;
const sourcePlace = places.docs[0].data().place;
await fs.setDoc(fs.doc(db(), 'savedPlaces', customer.uid, 'places', placeId), {
  id: placeId,
  uid: customer.uid,
  label: 'other',
  name: 'Verification stop',
  place: { ...sourcePlace, source: 'saved_place' },
  createdAtMs: fs.serverTimestamp(),
  updatedAtMs: fs.serverTimestamp(),
});
const savedBack = await fs.getDoc(fs.doc(db(), 'savedPlaces', customer.uid, 'places', placeId));
check('useAddSavedPlace writes a real place', savedBack.exists(), placeId);
await fs.updateDoc(fs.doc(db(), 'savedPlaces', customer.uid, 'places', placeId), { name: 'Renamed stop' });
check('a saved place can be renamed by its owner',
  (await fs.getDoc(fs.doc(db(), 'savedPlaces', customer.uid, 'places', placeId))).data().name === 'Renamed stop');
await fs.deleteDoc(fs.doc(db(), 'savedPlaces', customer.uid, 'places', placeId));
check('useDeleteSavedPlace removes it again', !(await fs.getDoc(fs.doc(db(), 'savedPlaces', customer.uid, 'places', placeId))).exists());

await expectRefused('a place cannot be written into someone else’s folder',
  () => fs.setDoc(fs.doc(db(), 'savedPlaces', other.uid, 'places', 'sneak'), {
    id: 'sneak', uid: customer.uid, label: 'other', name: 'Their home', place: sourcePlace,
  }));

await fs.updateDoc(fs.doc(db(), 'customerProfiles', customer.uid), {
  fullName: profile.data().fullName,
  // The mutation stores what `emailSchema` returns, so the mixed-case value the
  // customer typed is normalised here rather than by Firestore.
  email: emailSchema.parse('  Verify@DrivX.Test  '),
  preferredTransmission: 'manual',
  emergencyContact: { name: 'Verify Contact', phoneE164: '+919000000007', sharesLiveLocation: false },
  'privacy.marketingOptIn': true,
});
const savedProfile = (await fs.getDoc(fs.doc(db(), 'customerProfiles', customer.uid))).data();
check('useUpdateProfile saves the fields it owns',
  savedProfile.preferredTransmission === 'manual' && savedProfile.emergencyContact.name === 'Verify Contact'
  && savedProfile.email === 'verify@drivx.test'
  && savedProfile.privacy.marketingOptIn === true);
check('server-owned aggregates survived that write untouched',
  savedProfile.lifetimeBookings === profile.data().lifetimeBookings && savedProfile.ratingAverage === profile.data().ratingAverage);
await expectRefused('the same write cannot include lifetimeBookings',
  () => fs.updateDoc(fs.doc(db(), 'customerProfiles', customer.uid), { lifetimeBookings: 9_999 }));
await expectRefused('precise location while idle stays off',
  () => fs.updateDoc(fs.doc(db(), 'customerProfiles', customer.uid), { 'privacy.preciseLocationWhileIdle': true }));

const unread = notifications.docs.find((row) => row.data().readAtMs == null) ?? notifications.docs[0];
await fs.updateDoc(fs.doc(db(), 'users', customer.uid, 'notifications', unread.id), { readAtMs: fs.serverTimestamp() });
check('useMarkNotificationRead sets the receipt',
  Boolean((await fs.getDoc(fs.doc(db(), 'users', customer.uid, 'notifications', unread.id))).data().readAtMs));
await expectRefused('a notification body is not client-editable',
  () => fs.updateDoc(fs.doc(db(), 'users', customer.uid, 'notifications', unread.id), { body: 'Rewritten by the client.' }));
await expectRefused('a client cannot inject a notification',
  () => fs.setDoc(fs.doc(db(), 'users', customer.uid, 'notifications', 'n-fake'), { uid: customer.uid, title: 'Fake' }));

const ticketId = `tk-verify-${Date.now().toString(36)}`;
await fs.setDoc(fs.doc(db(), 'supportTickets', ticketId), {
  id: ticketId,
  openedByUid: customer.uid,
  forRole: 'customer',
  bookingId: bookings.docs[0].id,
  category: 'trip_issue',
  subject: 'Verification ticket from the customer app',
  body: 'Created by scripts/verify-customer-paths.mjs to prove the support write path is allowed.',
  status: 'open',
  priority: 'normal',
  assignedAdminUid: null,
  lastCustomerReplyAtMs: null,
  resolvedAtMs: null,
  resolution: null,
  createdAtMs: fs.serverTimestamp(),
  updatedAtMs: fs.serverTimestamp(),
});
check('useCreateTicket opens a real ticket',
  (await fs.getDoc(fs.doc(db(), 'supportTickets', ticketId))).data().status === 'open', ticketId);
await fs.updateDoc(fs.doc(db(), 'supportTickets', ticketId), {
  body: 'Appended by useReplyTicket: the route question still stands.',
  lastCustomerReplyAtMs: fs.serverTimestamp(),
});
check('useReplyTicket appends to an open ticket',
  /Appended by useReplyTicket/.test((await fs.getDoc(fs.doc(db(), 'supportTickets', ticketId))).data().body));
await expectRefused('the opener cannot set status',
  () => fs.updateDoc(fs.doc(db(), 'supportTickets', ticketId), { status: 'resolved' }));
await expectRefused('the opener cannot assign a case owner',
  () => fs.updateDoc(fs.doc(db(), 'supportTickets', ticketId), { assignedAdminUid: admin.uid }));
await expectRefused('a ticket cannot be opened on someone else’s booking',
  () => fs.setDoc(fs.doc(db(), 'supportTickets', `${ticketId}-x`), {
    id: `${ticketId}-x`, openedByUid: customer.uid, forRole: 'customer', bookingId: othersBooking.id,
    category: 'trip_issue', subject: 'Not mine', body: 'This booking belongs to the other customer.',
    status: 'open', priority: 'normal', assignedAdminUid: null,
  }));
await fs.deleteDoc(fs.doc(admin.firestore, 'supportTickets', ticketId));
// Staff reads it back: a customer GET of a deleted document answers
// permission-denied rather than not-found, because the read rule runs against a
// null resource — which is why the trip screen has a denied state, not just an
// empty one.
check('cleanup: staff deleted the verification ticket',
  !(await fs.getDoc(fs.doc(admin.firestore, 'supportTickets', ticketId))).exists());

console.log('\n5. The booking composer: options, price and booking all come from the server');

const optionsCall = await fn.httpsCallable(customer.functions, 'bookingOptions')({});
const offered = optionsCall.data ?? {};
const services = offered.services ?? [];
const oneWay = services.find((row) => row.pricingModel === 'distance_slab');
const hourly = services.find((row) => row.pricingModel === 'hourly_package');

check('bookingOptions lists the enabled services', services.length >= 2,
  services.map((row) => row.id).join(', '));
check('a disabled cab service is a named absence with the operator’s reason',
  (offered.unavailable ?? []).every((row) => typeof row.reason === 'string' && row.reason.length > 8),
  JSON.stringify((offered.unavailable ?? []).map((row) => row.id)));
check('the hourly service carries the package tiers a customer picks from',
  (hourly?.tiers ?? []).length >= 2,
  (hourly?.tiers ?? []).map((tier) => `${tier.id}:${tier.hours}h/${tier.includedKilometers}km`).join(' '));
check('availability is a count, never positions or names',
  typeof oneWay?.driversOnline === 'number', `${oneWay?.driversOnline} online in ${oneWay?.zoneId}`);
check('the app is told whether distances are road kilometres',
  typeof offered.routingIsRoadDistance === 'boolean', String(offered.routingIsRoadDistance));
check('bookingOptions publishes the rate card the customer’s pricing sheet reads',
  services.every((row) => row.terms?.pricingRuleId && Number.isFinite(row.terms.gstRate) &&
    row.terms.estimateValidityMinutes > 0),
  JSON.stringify(services.map((row) => row.terms?.pricingRuleId ?? null)));
check('a package rule publishes no flat per-km rate and no chart, and each package its excess rates',
  hourly?.terms.perKmPaise === null && hourly?.terms.slabs.length === 0 &&
    (hourly?.tiers ?? []).every((tier) => tier.extraKmPaise > 0 && tier.extraHourPaise > 0),
  JSON.stringify(hourly?.tiers?.[0] ?? null));
check('the one-way rule publishes the distance chart and its overflow rate, not a flat per-km rate',
  oneWay?.terms.perKmPaise === null && oneWay?.terms.slabOverflowPerKmPaise > 0 &&
    oneWay.terms.slabs.length >= 2 &&
    oneWay.terms.slabs.every((slab, i) => i === 0 || slab.upToKilometers > oneWay.terms.slabs[i - 1].upToKilometers),
  oneWay?.terms.slabs.map((slab) => `${slab.upToKilometers}km:₹${slab.farePaise / 100}`).join(' '));
check('a night charge is the flat amount the card states, never a share of the fare',
  oneWay?.terms.nightSurcharge?.mode === 'flat' && oneWay.terms.nightSurcharge.flatPaise > 0,
  JSON.stringify(oneWay?.terms.nightSurcharge ?? null));
await expectRefused('the rule a price came from stays server-side',
  () => fs.getDoc(fs.doc(db(), 'pricingRules', oneWay.terms.pricingRuleId)));

const destination = places.docs[1]?.data().place ?? sourcePlace;
const quoteCall = fn.httpsCallable(customer.functions, 'quoteFare');
const quoted = (await quoteCall({
  serviceTypeId: oneWay.id, pickup: sourcePlace, destination, scheduledForMs: null,
})).data;
const itemised = quoted.breakdown.items.reduce((sum, item) => sum + item.amountPaise, 0);

check('quoteFare prices the trip from its own measurement',
  quoted.breakdown.totalPaise > 0 && quoted.distanceMeters > 0,
  `₹${(quoted.breakdown.totalPaise / 100).toFixed(2)} over ${quoted.distanceMeters} m (${quoted.distanceSource})`);
check('the fare lines add up to the subtotal it reports', itemised === quoted.breakdown.subtotalPaise,
  `${itemised} vs ${quoted.breakdown.subtotalPaise}`);
check('total is subtotal plus tax',
  quoted.breakdown.subtotalPaise + quoted.breakdown.taxPaise === quoted.breakdown.totalPaise);
check('the quote names the rule, so a dispute traces to one document',
  Boolean(quoted.pricingRuleId), `${quoted.pricingRuleId} @ ${quoted.breakdown.pricingSnapshotHash?.slice(0, 19)}`);
check('no drive time is invented when Routes is not configured',
  quoted.distanceSource === 'google_routes' || quoted.durationSeconds === null,
  `${quoted.distanceSource} / ${quoted.durationSeconds}`);

// The sheet a customer reads before booking has to be the arithmetic the server
// does afterwards, or it is marketing. These two checks are that promise.
check('the GST the rate card states is the GST this quote charged',
  Math.round((quoted.breakdown.taxPaise / quoted.breakdown.subtotalPaise) * 100) ===
    Math.round(oneWay.terms.gstRate * 100),
  `₹${quoted.breakdown.taxPaise} on ₹${quoted.breakdown.subtotalPaise}`);
check('the distance chart the card publishes is the band this fare was charged on',
  quoted.breakdown.items.some((item) => item.key === 'slab_fare' &&
    oneWay.terms.slabs.some((slab) => slab.farePaise === item.amountPaise)),
  JSON.stringify(quoted.breakdown.items.find((item) => item.key === 'slab_fare') ?? null));
// A flat allowance that quietly became a share of the fare would still add up, so
// this checks the amount against the card rather than the arithmetic.
const nightItem = quoted.breakdown.items.find((item) => item.key === 'night_surcharge');
check('a night line, when the trip starts in the published window, is the flat amount the card states',
  nightItem === undefined || nightItem.amountPaise === oneWay.terms.nightSurcharge.flatPaise,
  JSON.stringify(nightItem ?? { outOfWindowAt: new Date().toString() }));

const sameEndpointsCode = await callableCode(() =>
  quoteCall({ serviceTypeId: oneWay.id, pickup: sourcePlace, destination: sourcePlace, scheduledForMs: null }),
);
check('a zero-length trip is refused before it is priced', sameEndpointsCode === 'invalid-argument', sameEndpointsCode);

const noTierCode = await callableCode(() =>
  quoteCall({ serviceTypeId: hourly.id, pickup: sourcePlace, destination, scheduledForMs: null }),
);
check('the hourly service refuses a quote with no package chosen', noTierCode === 'invalid-argument', noTierCode);

const hourlyQuoted = (await quoteCall({
  serviceTypeId: hourly.id, pickup: sourcePlace, destination, scheduledForMs: null, packageTierId: hourly.tiers[0].id,
})).data;
check('an hourly trip prices against the chosen package',
  hourlyQuoted.breakdown.packageTierId === hourly.tiers[0].id && hourlyQuoted.breakdown.totalPaise > 0,
  `₹${(hourlyQuoted.breakdown.totalPaise / 100).toFixed(2)} on ${hourly.tiers[0].id}`);

console.log('\n5b. One way and round trip are priced by different rules');

// The composer only shows the switch for a service that answers with a
// round-trip package list, so this is the same list the customer taps.
const roundTrip = services.find(
  (row) => row.pricingModel === 'distance_slab' && (row.roundTripTiers ?? []).length > 0,
);
check('bookingOptions projects the packages a round trip sells on',
  Boolean(roundTrip),
  services.map((row) => `${row.id}:${row.roundTripTiers === null ? 'null' : row.roundTripTiers.length}`).join(' '));
check('a service with no round-trip price answers null, so the app hides a choice it would refuse',
  hourly?.roundTripTiers === null,
  JSON.stringify(hourly?.roundTripTiers));
check('a round trip carries the terms of the rule that prices it, not the one-way rule',
  roundTrip.roundTripTerms?.pricingRuleId !== roundTrip.terms.pricingRuleId &&
    roundTrip.roundTripTerms.perKmPaise === null,
  `${roundTrip.terms.pricingRuleId} vs ${roundTrip.roundTripTerms?.pricingRuleId}`);

const oneWayQuote = (await quoteCall({
  serviceTypeId: roundTrip.id, tripDirection: 'one_way', pickup: sourcePlace, destination, scheduledForMs: null,
})).data;
const legacyQuote = (await quoteCall({
  serviceTypeId: roundTrip.id, pickup: sourcePlace, destination, scheduledForMs: null,
})).data;
check('a one-way trip is priced on the distance chart, as before this field existed',
  oneWayQuote.tripDirection === 'one_way' && oneWayQuote.breakdown.packageTierId === null,
  `${oneWayQuote.pricingRuleId} → ₹${(oneWayQuote.breakdown.totalPaise / 100).toFixed(2)}`);
check('an older client that sends no trip direction is priced as one way',
  legacyQuote.tripDirection === 'one_way' && legacyQuote.breakdown.totalPaise === oneWayQuote.breakdown.totalPaise);

const roundQuote = (await quoteCall({
  serviceTypeId: roundTrip.id,
  tripDirection: 'round_trip',
  pickup: sourcePlace,
  destination,
  scheduledForMs: null,
  packageTierId: roundTrip.roundTripTiers[0].id,
})).data;
check('a round trip is priced by a different rule than the same drive one way',
  roundQuote.tripDirection === 'round_trip' && roundQuote.pricingRuleId !== oneWayQuote.pricingRuleId,
  `${oneWayQuote.pricingRuleId} vs ${roundQuote.pricingRuleId}`);
check('the round-trip fare is a package plus extras, not a per-kilometre line',
  roundQuote.breakdown.packageTierId === roundTrip.roundTripTiers[0].id
    && roundQuote.breakdown.items.some((item) => item.key === 'package'),
  roundQuote.breakdown.items.map((item) => `${item.key}:₹${(item.amountPaise / 100).toFixed(2)}`).join(' '));
check('a round trip still carries the tax the total is quoted with',
  roundQuote.breakdown.subtotalPaise + roundQuote.breakdown.taxPaise === roundQuote.breakdown.totalPaise,
  `₹${(roundQuote.breakdown.taxPaise / 100).toFixed(2)} GST of ₹${(roundQuote.breakdown.totalPaise / 100).toFixed(2)}`);

const roundNoTier = await callFailure(() =>
  quoteCall({ serviceTypeId: roundTrip.id, tripDirection: 'round_trip', pickup: sourcePlace, destination, scheduledForMs: null }),
);
check('a round trip with no package chosen is refused, not defaulted to a tier',
  roundNoTier.code === 'invalid-argument', roundNoTier.message);

const unpricedRoundTrip = await callFailure(() =>
  quoteCall({
    serviceTypeId: hourly.id, tripDirection: 'round_trip', pickup: sourcePlace, destination,
    scheduledForMs: null, packageTierId: hourly.tiers[0].id,
  }),
);
check('a round trip on a service with no round-trip price is refused outright',
  unpricedRoundTrip.code === 'failed-precondition', unpricedRoundTrip.code);
check('and the refusal names the round trip, so the customer is not told the service is broken',
  /round trip/i.test(unpricedRoundTrip.message), unpricedRoundTrip.message);

const bookingsBefore = bookings.size;
const idempotencyKey = randomUUID();
const payload = {
  serviceTypeId: oneWay.id,
  pickup: sourcePlace,
  destination,
  scheduledForMs: null,
  preferences: { transmission: 'either', carType: 'either', notes: 'Non-smoking driver' },
  idempotencyKey,
};
const booked = (await fn.httpsCallable(customer.functions, 'createBooking')(payload)).data;

check('createBooking writes the booking and returns its reference',
  booked.bookingId === `bk-${idempotencyKey}` && /^DRX-/.test(booked.reference ?? ''),
  `${booked.reference} · ${booked.status}`);
const storedBooking = await fs.getDoc(fs.doc(db(), 'bookings', booked.bookingId));
check('the customer reads that booking back under the rules',
  storedBooking.exists() && storedBooking.data().status === 'requested', booked.bookingId);
check('the fare stored on the booking is the one the callable priced',
  storedBooking.data().estimate.totalPaise === booked.breakdown.totalPaise,
  `${storedBooking.data().estimate.totalPaise} vs ${booked.breakdown.totalPaise}`);
check('the booking keeps the preference text a driver will read',
  storedBooking.data().customerPreferences.notes === 'Non-smoking driver');
const created = await fs.getDoc(fs.doc(db(), `bookings/${booked.bookingId}/events/ev-booking_created`));
check('the audit event records how the distance was measured',
  created.exists() && created.data().payload.distanceSource === booked.distanceSource,
  created.data()?.payload?.distanceSource ?? 'no event');

const replayed = (await fn.httpsCallable(customer.functions, 'createBooking')(payload)).data;
check('replaying the same request returns the same booking, not a second one',
  replayed.deduplicated === true && replayed.bookingId === booked.bookingId,
  `${replayed.reference} · ₹${(replayed.breakdown.totalPaise / 100).toFixed(2)}`);
check('a replay reports the stored fare rather than a freshly priced one',
  replayed.breakdown.totalPaise === storedBooking.data().estimate.totalPaise);
const bookingsAfter = await fs.getDocs(
  fs.query(fs.collection(db(), 'bookings'), fs.where('customerUid', '==', customer.uid), fs.limit(25)),
);
check('exactly one booking document was created for two calls',
  bookingsAfter.size === bookingsBefore + 1, `${bookingsBefore} → ${bookingsAfter.size}`);
check('a booking taken without a trip direction is stored as one way',
  storedBooking.data().tripDirection === 'one_way', storedBooking.data().tripDirection);

// The composer's Round trip segment: same two places, a different rule.
const roundTripKey = randomUUID();
const roundTripPayload = {
  serviceTypeId: roundTrip.id,
  tripDirection: 'round_trip',
  pickup: sourcePlace,
  destination,
  scheduledForMs: null,
  packageTierId: roundTrip.roundTripTiers[0].id,
  preferences: { transmission: 'either', carType: 'either', notes: null },
  idempotencyKey: roundTripKey,
};
const bookedRoundTrip = (await fn.httpsCallable(customer.functions, 'createBooking')(roundTripPayload)).data;
const storedRoundTrip = await fs.getDoc(fs.doc(db(), 'bookings', bookedRoundTrip.bookingId));
check('a round trip booking keeps the hourly rule the quote used',
  storedRoundTrip.data().tripDirection === 'round_trip'
    && storedRoundTrip.data().estimate.pricingRuleId === roundQuote.pricingRuleId,
  `${storedRoundTrip.data().tripDirection} · ${storedRoundTrip.data().estimate.pricingRuleId}`);
check('and it is priced from the package the customer picked',
  storedRoundTrip.data().estimate.packageTierId === roundTrip.roundTripTiers[0].id,
  `₹${(storedRoundTrip.data().estimate.totalPaise / 100).toFixed(2)} on ${storedRoundTrip.data().estimate.packageTierId}`);
const replayedRoundTrip = (await fn.httpsCallable(customer.functions, 'createBooking')(roundTripPayload)).data;
check('replaying a round trip keeps saying it was a round trip',
  replayedRoundTrip.deduplicated === true && replayedRoundTrip.tripDirection === 'round_trip',
  `${replayedRoundTrip.reference} · ${replayedRoundTrip.tripDirection}`);

// The customer gate is a claim check, not a hopeful comment: a signed-in, verified
// driver with a valid payload must be refused before anything is priced or written.
const driverClaims = driver.claims;
const driverCode = await callableCode(() =>
  fn.httpsCallable(driver.functions, 'createBooking')(payload),
);
check('a driver token cannot book a trip', driverCode === 'permission-denied',
  `${driverClaims?.role} → ${driverCode}`);
const bookingsForDriver = await fs.getDocs(
  // Read with the admin session: a customer or driver session cannot query
  // another account's bookings, so the count would come back empty either way.
  fs.query(fs.collection(admin.firestore, 'bookings'), fs.where('customerUid', '==', driver.uid), fs.limit(5)),
);
check('and the refused call left no booking behind', bookingsForDriver.size === 0,
  `${bookingsForDriver.size} booking(s) for the driver account`);

await expectRefused('and the client has no write path to bookings anyway',
  () => fs.setDoc(fs.doc(db(), 'bookings', 'bk-from-client'), { customerUid: customer.uid, status: 'requested' }));

// Cancellation, which is the customer's own and nobody else's. Every claim here
// is read back off the document rather than taken from the callable's reply,
// because the reply is what the screen shows and the document is what the next
// trip, the dispute and the driver's earnings are computed from.
console.log('\n5c. Cancelling — the customer’s own end, and only it');
const cancelled = (await fn.httpsCallable(customer.functions, 'cancelBooking')({
  bookingId: booked.bookingId,
  reasonCode: 'plan_changed',
})).data;
check('cancelBooking ends the customer’s own trip and says so',
  cancelled.status === 'cancelled' && cancelled.alreadyCancelled === false && cancelled.reference === booked.reference,
  `${cancelled.reference} · ${cancelled.status}`);
const cancelledDoc = (await fs.getDoc(fs.doc(db(), 'bookings', booked.bookingId))).data();
check('the booking on Firestore is cancelled by the customer, with the reason they picked',
  cancelledDoc.status === 'cancelled' && cancelledDoc.cancellation.by === 'customer'
    && cancelledDoc.cancellation.reasonCode === 'plan_changed',
  `${cancelledDoc.status} · ${cancelledDoc.cancellation?.by} · ${cancelledDoc.cancellation?.reasonCode}`);
check('nothing is charged to cancel, because nothing was collected to book',
  cancelledDoc.cancellation.feePaise === 0 && cancelled.feePaise === 0,
  `feePaise=${cancelledDoc.cancellation?.feePaise}`);
check('the state version moved, so a concurrent write cannot silently overwrite it',
  cancelledDoc.stateVersion === 2, `stateVersion=${cancelledDoc.stateVersion}`);
const cancelEvent = await fs.getDoc(fs.doc(db(), `bookings/${booked.bookingId}/events/ev-booking_cancelled`));
check('the audit trail records the move with the customer as its actor',
  cancelEvent.exists() && cancelEvent.data().toStatus === 'cancelled'
    && cancelEvent.data().actor.role === 'customer',
  cancelEvent.exists() ? `${cancelEvent.data().fromStatus} → ${cancelEvent.data().toStatus}` : 'no event written');

const secondCancel = (await fn.httpsCallable(customer.functions, 'cancelBooking')({
  bookingId: booked.bookingId,
  reasonCode: 'fare_too_high',
})).data;
check('tapping cancel twice reports the trip as already cancelled instead of failing',
  secondCancel.alreadyCancelled === true && secondCancel.status === 'cancelled',
  `alreadyCancelled=${secondCancel.alreadyCancelled}`);
check('and the first reason is the one that stays on the record',
  secondCancel.reasonCode === 'plan_changed'
    && (await fs.getDoc(fs.doc(db(), 'bookings', booked.bookingId))).data().cancellation.reasonCode === 'plan_changed',
  secondCancel.reasonCode);

const strangerCancel = await callFailure(() =>
  fn.httpsCallable(other.functions, 'cancelBooking')({ bookingId: booked.bookingId, reasonCode: 'other' }),
);
check('another customer cannot cancel this trip', strangerCancel.code === 'permission-denied',
  `${strangerCancel.code} — ${strangerCancel.message}`);
const driverCancel = await callFailure(() =>
  fn.httpsCallable(driver.functions, 'cancelBooking')({ bookingId: booked.bookingId, reasonCode: 'other' }),
);
check('nor can a driver, so a trip never ends from the wrong end',
  driverCancel.code === 'permission-denied', `${driverCancel.code} — ${driverCancel.message}`);

const terminalCancel = await callFailure(() =>
  fn.httpsCallable(customer.functions, 'cancelBooking')({ bookingId: 'bk-demo-2', reasonCode: 'other' }),
);
check('a finished trip is refused rather than re-opened into a cancellation',
  terminalCancel.code === 'failed-precondition', `${terminalCancel.code} — ${terminalCancel.message}`);
const badReason = await callFailure(() =>
  fn.httpsCallable(customer.functions, 'cancelBooking')({ bookingId: booked.bookingId, reasonCode: 'driver_was_late' }),
);
check('a reason the app does not offer is refused before anything is read',
  badReason.code === 'invalid-argument', badReason.code);

// A booking is immutable to every client, staff included, because a trip record
// is evidence. Undoing a verification write therefore needs the emulator's owner
// token — the same bypass scripts/seed.mjs uses, and one that answers nothing
// useful against a real project. The creation event goes with the document.
const cleared = await fetch(
  `http://${HOST}:${FIRESTORE_PORT}/v1/projects/${PROJECT_ID}/databases/(default)/documents:commit`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({
      writes: [booked.bookingId, bookedRoundTrip.bookingId].flatMap((id) => [
        { delete: `projects/${PROJECT_ID}/databases/(default)/documents/bookings/${id}` },
        { delete: `projects/${PROJECT_ID}/databases/(default)/documents/bookings/${id}/events/ev-booking_created` },
        { delete: `projects/${PROJECT_ID}/databases/(default)/documents/bookings/${id}/events/ev-booking_cancelled` },
      ]),
    }),
  },
);
check('cleanup: the verification bookings are removed from the emulator',
  cleared.ok, `HTTP ${cleared.status}`);

await Promise.all([
  deleteApp(customer.app),
  deleteApp(other.app),
  deleteApp(admin.app),
  deleteApp(driver.app),
]);

console.log(
  failures.length === 0
    ? '\nEvery customer screen path above was answered by the emulator with the rules enforced.\n'
    : `\n${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
