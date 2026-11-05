/**
 * Proves the address-search chain against the emulator, with rules on and real
 * Google behind it.
 *
 * Three callables and one consequence: `searchPlaces` returns ranked text from
 * Places (New), `resolvePlace` turns a tapped suggestion into a coordinate and a
 * full address, `reverseGeocode` names a position the device already has — and a
 * place that came out of that chain is then priced by `quoteFare` off a real road
 * distance. That last step is the point: an address nobody can book on is not a
 * feature.
 *
 * Nothing is mocked. Every Google call below is a live one, so this script also
 * fails loudly if the key is missing, restricted away from an API it needs, or
 * out of quota.
 *
 *   npm run emulators   # terminal 1 (needs Java 21+)
 *   npm run seed        # terminal 2
 *   node scripts/verify-places.mjs
 */
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
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
  PROJECT_ID =
    JSON.parse(readFileSync(path.join(root, '.firebaserc'), 'utf8')).projects?.default ?? PROJECT_ID;
} catch {
  /* the emulator's own default */
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

const [authUp, storeUp, fnUp] = await Promise.all([
  reachable(AUTH_PORT),
  reachable(FIRESTORE_PORT),
  reachable(FUNCTIONS_PORT),
]);
if (!authUp || !storeUp || !fnUp) {
  console.error(
    `Emulator not reachable (auth ${authUp ? 'ok' : 'DOWN'}, firestore ${storeUp ? 'ok' : 'DOWN'}, ` +
      `functions ${fnUp ? 'ok' : 'DOWN'}). Start \`npm run emulators\`, then \`npm run seed\`.`,
  );
  process.exit(1);
}

const app = initializeApp(CONFIG, 'verify-places');
const auth = authMod.getAuth(app);
authMod.connectAuthEmulator(auth, `http://${HOST}:${AUTH_PORT}`, { disableWarnings: true });
const firestore = fs.getFirestore(app);
fs.connectFirestoreEmulator(firestore, HOST, FIRESTORE_PORT);
const functions = fn.getFunctions(app, REGION);
fn.connectFunctionsEmulator(functions, HOST, FUNCTIONS_PORT);

const cred = await authMod.signInWithEmailAndPassword(auth, 'amit@example.test', PASSWORD);
const claims = (await cred.user.getIdTokenResult()).claims;
check('signed in as a seeded customer', claims?.role === 'customer', `uid=${cred.user.uid}`);

// httpsCallable wraps the payload as { data } itself; passing {data: …} here would
// send a request whose body is a box inside a box.
const call = (name, data) => fn.httpsCallable(functions, name)(data).then((r) => r.data);

console.log('\n1. Search — Places (New) autocomplete through the server');
const search = await call('searchPlaces', {
  query: 'IGI Airport Terminal 3',
  near: { lat: 28.4595, lng: 77.0266 },
});
check('the server says search is configured', search.configured === true);
check(
  'autocomplete returned ranked suggestions',
  Array.isArray(search.suggestions) && search.suggestions.length >= 2,
  `${search.suggestions?.length ?? 0} rows`,
);
check(
  'a suggestion is text only, never a coordinate',
  search.suggestions.every((row) => row.placeId && row.mainText && !('location' in row)),
  JSON.stringify(search.suggestions[0] ?? null),
);

console.log('\n2. Too short a query and an unconfigured path');
const short = await call('searchPlaces', { query: 'x', near: null }).catch((error) => error);
check(
  'one character is refused rather than sent to Google',
  short?.code === 'functions/invalid-argument' ||
    (Array.isArray(short?.suggestions) && short.suggestions.length === 0),
  short?.code ?? `${short?.suggestions?.length ?? 0} rows`,
);

console.log('\n3. Resolution — one tapped suggestion becomes a bookable address');
const picked = search.suggestions[0];
const resolved = await call('resolvePlace', { placeId: picked.placeId });
const place = resolved.place;
check('the resolved place carries a real coordinate', typeof place?.location?.lat === 'number', JSON.stringify(place?.location));
check(
  'it carries the fields the booking schema demands',
  Boolean(place?.label && place?.addressLine1 && place?.city && place?.state),
  `${place?.addressLine1} · ${place?.city}, ${place?.state} ${place?.pincode ?? ''}`.trim(),
);
check('its source says it came from autocomplete', place?.source === 'places_autocomplete', place?.source);
check('the place id round-trips, so a dispute traces to one Google place', place?.placeId === picked.placeId);

console.log('\n4. Current location — reverse geocoding a position the device has');
const mine = await call('reverseGeocode', { lat: 28.4595, lng: 77.0266 });
check(
  'a Gurugram coordinate becomes an address, not an invented one',
  Boolean(mine.place?.label) && mine.place.source === 'reverse_geocode',
  mine.place?.label,
);
check(
  'the coordinate stays the device’s own',
  mine.place?.location?.lat === 28.4595 && mine.place?.location?.lng === 77.0266,
  JSON.stringify(mine.place?.location),
);

console.log('\n5. The consequence — a searched address is priced off a real road');
const destination = await call('resolvePlace', {
  placeId: (await call('searchPlaces', { query: 'Cyber Hub Gurugram', near: { lat: 28.45, lng: 77.03 }, })).suggestions[0].placeId,
}).then((r) => r.place);

const quote = await call('quoteFare', {
  serviceTypeId: 'chauffeur_own_car',
  pickup: place,
  destination,
  scheduledForMs: null,
});
check(
  'the fare came from Google Roads, not a straight line',
  quote.distanceSource === 'google_routes',
  `${quote.distanceSource} · ${quote.distanceMeters} m`,
);
check('drive time is measured, not guessed', typeof quote.durationSeconds === 'number', `${quote.durationSeconds}s`);
check(
  'the searched addresses are the ones priced',
  quote.breakdown.totalPaise > 0 && Boolean(quote.pricingRuleId),
  `₹${(quote.breakdown.totalPaise / 100).toFixed(2)} on ${quote.pricingRuleId}`,
);

console.log('\n6. Booking it writes the searched places');
const booked = await call('createBooking', {
  serviceTypeId: 'chauffeur_own_car',
  pickup: place,
  destination,
  scheduledForMs: null,
  preferences: { transmission: 'either', carType: 'either', notes: null },
  idempotencyKey: randomUUID(),
});
check('booking created with the searched pickup', booked.status === 'requested', booked.reference);
const bookingDoc = await fs.getDoc(fs.doc(firestore, 'bookings', booked.bookingId));
check(
  'the stored pickup is the resolved Google address',
  bookingDoc.data()?.pickup?.addressLine1 === place.addressLine1,
  bookingDoc.data()?.pickup?.addressLine1,
);

console.log('\n7. Cost guard — the spend counter exists, admin sees it, customers do not');
const day = new Date().toISOString().slice(0, 10);
const counterKey = `maps-${day}`;

// Admin reads it: the owner has to be able to see what Maps is costing.
const adminApp = initializeApp(CONFIG, 'verify-places-admin');
const adminAuth = authMod.getAuth(adminApp);
authMod.connectAuthEmulator(adminAuth, `http://${HOST}:${AUTH_PORT}`, { disableWarnings: true });
const adminStore = fs.getFirestore(adminApp);
fs.connectFirestoreEmulator(adminStore, HOST, FIRESTORE_PORT);
await authMod.signInWithEmailAndPassword(adminAuth, 'admin@drivx.test', PASSWORD);
const counter = await fs.getDoc(fs.doc(adminStore, 'usage', counterKey));
const skus = Object.keys(counter.data()?.calls ?? {});
check(
  'the functions layer recorded today’s Maps calls',
  counter.exists() && skus.length >= 3,
  skus.map((sku) => `${sku}=${counter.data().calls[sku]}`).join(' · '),
);
try {
  const asCustomer = await fs.getDoc(fs.doc(firestore, 'usage', counterKey));
  check('a customer cannot read the spend counter', false, asCustomer.exists() ? 'it was readable' : 'read allowed');
} catch (error) {
  check('a customer cannot read the spend counter', error?.code === 'permission-denied', error?.code);
}
await deleteApp(adminApp);

await deleteApp(app);

console.log(
  failures.length === 0
    ? '\nAddress search works end to end: searched, resolved, booked and priced off real roads.\n'
    : `\n${failures.length} check(s) failed:\n - ${failures.join('\n - ')}\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
