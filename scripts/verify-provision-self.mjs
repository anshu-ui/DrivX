/**
 * Proves `provisionSelf` — the callable a brand-new signup depends on.
 *
 * On the live project the `provisionNewAccount` auth trigger never fired, so an
 * account arrived with no `users/{uid}` row and no role claim, and the rules
 * refused the profile the app tried to write. This script puts an emulator
 * account into exactly that state (row deleted, claims wiped) and checks the
 * callable rebuilds it, refuses callers it should refuse, and never overwrites
 * a decision an administrator already made.
 *
 * Requires `npm run emulators`.
 *   node scripts/verify-provision-self.mjs
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HOST = process.env.FIREBASE_EMULATOR_HOST ?? '127.0.0.1';
const AUTH_PORT = Number(process.env.AUTH_EMULATOR_PORT ?? 9099);
const FIRESTORE_PORT = Number(process.env.FIRESTORE_EMULATOR_PORT ?? 8080);
const FUNCTIONS_PORT = Number(process.env.FUNCTIONS_EMULATOR_PORT ?? 5001);
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID ?? 'drivx-local';
const REGION = process.env.DRIVX_FUNCTION_REGION ?? 'asia-south1';

const AUTH_BASE = `http://${HOST}:${AUTH_PORT}`;
const DOCS_BASE = `http://${HOST}:${FIRESTORE_PORT}/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const CALLABLE = (name) => `http://${HOST}:${FUNCTIONS_PORT}/${PROJECT_ID}/${REGION}/${name}`;

const failures = [];
function check(label, ok, detail) {
  console.log(`${ok ? 'ok   ' : 'FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The Firebase JS SDK build Metro resolves for apps/mobile. */
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
  'verify-provision-self',
);
const auth = rnAuth.initializeAuth(app, { persistence: rnAuth.inMemoryPersistence });
rnAuth.connectAuthEmulator(auth, AUTH_BASE, { disableWarnings: true });

/** Stand-in for the reCAPTCHA widget; the Auth emulator ignores the token. */
const emulatorVerifier = {
  type: 'recaptcha',
  render: async () => 1,
  verify: async () => 'emulator-token',
  clear: () => {},
  _reset: () => {},
};

/** Admin SDK in emulator mode: used to wipe and read claims like an operator would. */
process.env.FIREBASE_AUTH_EMULATOR_HOST = `${HOST}:${AUTH_PORT}`;
const { initializeApp: initAdmin } = await import('firebase-admin/app');
const { getAuth } = await import('firebase-admin/auth');
initAdmin({ projectId: PROJECT_ID });
const adminAuth = getAuth();

/** The emulator can stall; a hung read must not stall the whole proof. */
const timeout = () => AbortSignal.timeout(15_000);

async function readDocument(collection, id) {
  const res = await fetch(`${DOCS_BASE}/${collection}/${id}`, {
    headers: { Authorization: 'Bearer owner' },
    signal: timeout(),
  });
  return res.ok ? res.json() : null;
}

async function deleteDocument(collection, id) {
  await fetch(`${DOCS_BASE}:commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({
      writes: [{ delete: `projects/${PROJECT_ID}/databases/(default)/documents/${collection}/${id}` }],
    }),
  });
}

function fieldText(doc, name) {
  const value = doc?.fields?.[name];
  if (!value) return undefined;
  return value.stringValue ?? value.integerValue ?? value.booleanValue ?? value.nullValue ?? undefined;
}

/** Calls the callable the way the SDK does, and keeps the status + decoded body. */
async function callProvisionSelf(idToken) {
  const res = await fetch(CALLABLE('provisionSelf'), {
    method: 'POST',
    signal: timeout(),
    headers: {
      'Content-Type': 'application/json',
      ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
    },
    body: JSON.stringify({ data: {} }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, result: body.result ?? null, error: body.error?.status ?? null };
}

async function signInWithPhone(phone) {
  const result = await rnAuth.signInWithPhoneNumber(auth, phone, emulatorVerifier);
  const codes = await fetch(`${AUTH_BASE}/emulator/v1/projects/${PROJECT_ID}/verificationCodes`).then((r) => r.json());
  const code = (codes.verificationCodes ?? []).find((e) => e.sessionInfo === result.verificationId)?.code;
  if (!code) throw new Error(`emulator has no pending code for ${phone}`);
  return (await result.confirm(code)).user;
}

const phone = `+919000000${String(Date.now()).slice(-6)}`;

console.log(`\n1. A brand-new number signs in and is left unprovisioned (${phone})`);
const user = await signInWithPhone(phone);
for (let attempt = 0; attempt < 12 && !(await readDocument('users', user.uid)); attempt += 1) {
  await sleep(1000); // let the auth trigger finish, if it fires at all
}
await deleteDocument('users', user.uid);
await deleteDocument('customerProfiles', user.uid);
await adminAuth.setCustomUserClaims(user.uid, {});
const bare = await user.getIdTokenResult(true);
const bareToken = bare.token;
check(
  'account is in the live failure state: no row, no role',
  (await readDocument('users', user.uid)) === null && !bare.claims?.role,
);

console.log('\n2. provisionSelf rebuilds it');
const provisioned = await callProvisionSelf(bareToken);
check('callable answers OK', provisioned.status === 200 && provisioned.result?.outcome === 'provisioned', JSON.stringify(provisioned));

const userRow = await readDocument('users', user.uid);
const profileRow = await readDocument('customerProfiles', user.uid);
check('users/{uid} exists with role customer', fieldText(userRow, 'role') === 'customer');
check('users/{uid} carries the verified number', fieldText(userRow, 'phoneNumberE164') === phone, String(fieldText(userRow, 'phoneNumberE164')));
check('customerProfiles/{uid} exists', profileRow !== null);
check('profile phone comes from the token, not the caller', fieldText(profileRow, 'contactPhoneE164') === phone);

const afterClaims = await user.getIdTokenResult(true);
check('role claim reached the ID token', afterClaims.claims?.role === 'customer');
check('no privilege on a fresh account', afterClaims.claims?.admin !== true && afterClaims.claims?.ops !== true);

console.log('\n3. It is idempotent and never overwrites an administrator');
await adminAuth.setCustomUserClaims(user.uid, { role: 'admin', admin: true });
const adminWrite = await adminAuth.getUser(user.uid);
check(
  'the admin claim really landed first',
  adminWrite.customClaims?.role === 'admin',
  JSON.stringify(adminWrite.customClaims),
);
// An admin's decision plus whatever the customer typed into their profile: a
// second provisioning run must leave both exactly as they are.
await fetch(`${DOCS_BASE}:commit`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
  body: JSON.stringify({
    writes: [
      {
        update: {
          name: `projects/${PROJECT_ID}/databases/(default)/documents/customerProfiles/${user.uid}`,
          fields: { fullName: { stringValue: 'Amit Edited By Hand' } },
        },
        updateMask: { fieldPaths: ['fullName'] },
      },
    ],
  }),
}).then((r) => r.json());
const edited = await readDocument('customerProfiles', user.uid);
check('profile edit landed', fieldText(edited, 'fullName') === 'Amit Edited By Hand');

const second = await callProvisionSelf(await user.getIdToken(true));
check('second run reports already_provisioned', second.result?.outcome === 'already_provisioned', JSON.stringify(second));
const claimsAfter = (await adminAuth.getUser(user.uid)).customClaims;
check('claims left as an admin set them', claimsAfter?.role === 'admin', JSON.stringify(claimsAfter));
check(
  'profile untouched',
  fieldText(await readDocument('customerProfiles', user.uid), 'fullName') === 'Amit Edited By Hand',
);

console.log('\n4. Callers it must refuse');
const anonymous = await callProvisionSelf(null);
check('no token → refused', anonymous.status === 401 || anonymous.status === 403, `HTTP ${anonymous.status} ${anonymous.error ?? ''}`);

const noPhoneEmail = `no-phone-${Date.now()}@example.com`;
const emailAccount = await adminAuth.createUser({ email: noPhoneEmail, password: 'drivx-verify-only' });
const emailUser = await rnAuth.signInWithEmailAndPassword(auth, noPhoneEmail, 'drivx-verify-only');
const emailRefusal = await callProvisionSelf(await emailUser.user.getIdToken(true));
check('a number-less account → refused', emailRefusal.error === 'PERMISSION_DENIED', JSON.stringify(emailRefusal));
check('no row written for the refused account', (await readDocument('users', emailAccount.uid)) === null);
await adminAuth.deleteUser(emailAccount.uid);

console.log(
  failures.length === 0
    ? '\nprovisionSelf verified against the emulator.\n'
    : `\n${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
