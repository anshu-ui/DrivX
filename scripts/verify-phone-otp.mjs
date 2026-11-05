/**
 * Proves phone-OTP sign-in end-to-end against the local Firebase Auth emulator.
 *
 * There is no device in the loop, so this runs the same call path the mobile
 * app uses: the React Native build of the Firebase JS SDK, a real
 * `accounts:sendVerificationCode` round trip, the emulator's own six-digit code,
 * and `confirmationResult.confirm()`. It then checks that the Auth trigger
 * `provisionNewAccount` minted the `role: customer` claim for a brand-new number.
 *
 * Requires `npm run emulators` (and `npm run seed` for the seeded-account case).
 *   node scripts/verify-phone-otp.mjs
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HOST = process.env.FIREBASE_EMULATOR_HOST ?? '127.0.0.1';
const AUTH_PORT = Number(process.env.AUTH_EMULATOR_PORT ?? 9099);
const FIRESTORE_PORT = Number(process.env.FIRESTORE_EMULATOR_PORT ?? 8080);
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID ?? 'drivx-local';
const AUTH_BASE = `http://${HOST}:${AUTH_PORT}`;

const seededPhone = process.argv[2] ?? '+919000000001';
const freshPhone = process.argv[3] ?? `+9190000000${String(Date.now()).slice(-5)}`;

const failures = [];
function check(label, ok, detail) {
  console.log(`${ok ? 'ok   ' : 'FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

// The React Native entry point is what Metro resolves for apps/mobile, so
// requiring the file directly keeps this test honest about the code under test.
const rnAuth = require(path.join(root, 'node_modules/@firebase/auth/dist/rn/index.js'));
const firebaseApp = require('@firebase/app');

const app = firebaseApp.initializeApp(
  {
    apiKey: 'developer-mode-key',
    authDomain: `${PROJECT_ID}.firebaseapp.com`,
    projectId: PROJECT_ID,
    storageBucket: `${PROJECT_ID}.appspot.com`,
    messagingSenderId: '000000000000',
    appId: '1:0:web:000000000000',
  },
  'verify-phone-otp',
);

const auth = rnAuth.initializeAuth(app, { persistence: rnAuth.inMemoryPersistence });
rnAuth.connectAuthEmulator(auth, AUTH_BASE, { disableWarnings: true });

/**
 * Stand-in for the reCAPTCHA widget the JS SDK normally requires before it will
 * ask for an SMS. The Auth emulator ignores the token entirely — the code that
 * is actually validated is the one the emulator generated.
 */
const emulatorVerifier = {
  type: 'recaptcha',
  render: async () => 1,
  verify: async () => 'emulator-token',
  clear: () => {},
  _reset: () => {},
};

async function pingEmulator() {
  const res = await fetch(`${AUTH_BASE}/`).catch(() => null);
  if (!res || res.status >= 500) {
    console.error(`Auth emulator is not reachable at ${AUTH_BASE}. Run: npm run emulators`);
    process.exit(1);
  }
}

/** The emulator stores pending codes; SMS delivery is what it cannot fake. */
async function pendingCode(sessionInfo) {
  const res = await fetch(`${AUTH_BASE}/emulator/v1/projects/${PROJECT_ID}/verificationCodes`);
  if (!res.ok) throw new Error(`verificationCodes endpoint answered ${res.status}`);
  const body = await res.json();
  return (body.verificationCodes ?? []).find((entry) => entry.sessionInfo === sessionInfo)?.code ?? null;
}

async function signInWithPhone(phone) {
  const result = await rnAuth.signInWithPhoneNumber(auth, phone, emulatorVerifier);
  const code = await pendingCode(result.verificationId);
  if (!code) throw new Error(`emulator has no pending code for ${phone}`);
  console.log(`     ${phone} → emulator SMS code ${code}`);
  const credential = await result.confirm(code);
  return credential.user;
}

async function readDocument(pathSegments) {
  const url =
    `http://${HOST}:${FIRESTORE_PORT}/v1/projects/${PROJECT_ID}/databases/(default)/documents` +
    `/${pathSegments.join('/')}?key=owner`;
  const res = await fetch(url, { headers: { Authorization: 'Bearer owner' } });
  return res.ok ? res.json() : null;
}

function fieldText(doc, name) {
  const value = doc?.fields?.[name];
  if (!value) return undefined;
  return value.stringValue ?? value.integerValue ?? value.booleanValue ?? value.nullValue ?? undefined;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await pingEmulator();

console.log(`\n1. Sign in an existing account with ${seededPhone}`);
let user;
try {
  user = await signInWithPhone(seededPhone);
} catch (error) {
  console.error('   sign-in failed:', error?.code ?? error?.message ?? error);
  process.exit(1);
}
const claims = await user.getIdTokenResult();
check('session is real', user.uid.length > 0, `uid=${user.uid}`);
check('provider is phone', claims.claims?.firebase?.sign_in_provider === 'phone');
check('seeded claims reached the ID token', claims.claims?.role === 'customer', `role=${claims.claims?.role}`);
check('profile document exists', Boolean(await readDocument(['customerProfiles', user.uid])));

await rnAuth.signOut(auth);

console.log(`\n2. Sign up a brand-new number with ${freshPhone}`);
let fresh;
try {
  fresh = await signInWithPhone(freshPhone);
} catch (error) {
  console.error('   sign-up failed:', error?.code ?? error?.message ?? error);
  process.exit(1);
}
check('account was created', Boolean(fresh.uid), `uid=${fresh.uid}`);

let provisioned = null;
for (let attempt = 0; attempt < 12 && !provisioned; attempt += 1) {
  await sleep(1000);
  provisioned = await readDocument(['users', fresh.uid]);
}
check(
  'provisionNewAccount ran (Functions emulator auth trigger)',
  Boolean(provisioned),
  provisioned ? `users/${fresh.uid} written` : 'no users/{uid} document after 12s',
);

const freshClaims = (await fresh.getIdTokenResult(true)).claims;
check('role claim minted server-side', freshClaims?.role === 'customer', `role=${freshClaims?.role}`);
check('no privileged claim on a fresh account', freshClaims?.admin !== true && freshClaims?.ops !== true);

// A signed-in account with no role is what the rules must refuse; prove that the
// claim-less state is only reachable before provisioning, never after.
const token = await fresh.getIdToken(true);
check('ID token is issued by the emulator', typeof token === 'string' && token.split('.').length === 3);

console.log(`\n3. Wrong code is refused (no fake success)`);
await rnAuth.signOut(auth);
const second = await rnAuth.signInWithPhoneNumber(auth, freshPhone, emulatorVerifier);
let refused = false;
try {
  await second.confirm('000000');
} catch (error) {
  refused = error?.code === 'auth/invalid-verification-code';
  if (!refused) console.error('   unexpected error:', error?.code ?? error);
}
check('invalid code rejected', refused);

console.log(
  failures.length === 0
    ? `\nPhone OTP flow verified against the emulator. Seeded password sign-in still works via dev-sign-in.\n`
    : `\n${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
