#!/usr/bin/env node
/**
 * Empties the local DrivX emulator: every document, subcollection, Auth account
 * and uploaded file, then verifies nothing is left.
 *
 * The owner's rule is that the product is worked on with real data, so the
 * seeded demo ledger — the in-progress booking, the demo drivers, their dues and
 * document rows — must be clearable in one command rather than left in front of
 * him while he tests. `npm run seed` puts the demo dataset back if it is ever
 * needed for a verifier.
 *
 *   npm run emulators   # terminal 1
 *   npm run wipe        # this script, once the emulator answers
 *
 * Emulator-only by construction. It refuses any project id that is not the
 * local one, and refuses to run unless the Firestore port is a loopback address,
 * because wiping a live ledger would delete real trips, real drivers and real
 * money records with no way back.
 */

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID ?? 'drivx-local';
const HOST = process.env.FIREBASE_EMULATOR_HOST ?? '127.0.0.1';
const FIRESTORE_PORT = Number(process.env.FIRESTORE_EMULATOR_PORT ?? 8080);
const AUTH_PORT = Number(process.env.AUTH_EMULATOR_PORT ?? 9099);
const STORAGE_PORT = Number(process.env.STORAGE_EMULATOR_PORT ?? 9199);

if (PROJECT_ID !== 'drivx-local') {
  throw new Error(
    `Refusing to wipe project "${PROJECT_ID}". This script is for the local emulator ` +
      `(drivx-local) only — a live ledger holds real trips, real drivers and real dues.`,
  );
}
if (!['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
  throw new Error(`Refusing to wipe a non-loopback emulator host "${HOST}".`);
}

process.env.FIRESTORE_EMULATOR_HOST = `${HOST}:${FIRESTORE_PORT}`;
process.env.FIREBASE_AUTH_EMULATOR_HOST = `${HOST}:${AUTH_PORT}`;
process.env.STORAGE_EMULATOR_HOST = `http://${HOST}:${STORAGE_PORT}`;
process.env.GCLOUD_PROJECT = PROJECT_ID;

const { initializeApp } = await import('firebase-admin/app');
const { getFirestore } = await import('firebase-admin/firestore');
const { getAuth } = await import('firebase-admin/auth');
const { getStorage } = await import('firebase-admin/storage');

initializeApp({ projectId: PROJECT_ID });
const db = getFirestore();
const auth = getAuth();

/** Deletes a document's whole subtree before the document itself. */
async function deleteSubtree(ref, depth = 0) {
  if (depth > 12) throw new Error(`Deeper than 12 levels under ${ref.path} — stopping.`);
  for (const child of await ref.listCollections()) {
    for (const doc of (await child.limit(400).get()).docs) await deleteSubtree(doc.ref, depth + 1);
  }
  await ref.delete();
}

/** Counts what is there, then removes it, and reports the rows that were left. */
async function wipeCollection(name) {
  const before = (await db.collection(name).limit(500).get()).size;
  for (const doc of (await db.collection(name).limit(500).get()).docs) await deleteSubtree(doc.ref);
  const after = (await db.collection(name).limit(500).get()).size;
  console.log(`  ${name.padEnd(18)} ${String(before).padStart(4)} → ${after}`);
  return { before, after };
}

async function ping() {
  try {
    return (await fetch(`http://${HOST}:${FIRESTORE_PORT}/`)).ok;
  } catch {
    return false;
  }
}

if (!(await ping())) {
  throw new Error(
    `The Firestore emulator is not answering on ${HOST}:${FIRESTORE_PORT}. Start it with \`npm run emulators\` first.`,
  );
}

console.log(`Wiping the local emulator (${PROJECT_ID} @ ${HOST})\n`);

const names = new Set();
for (const collection of await db.listCollections()) names.add(collection.id);
// The seed's own roots, so a half-started emulator still reports them as empty.
for (const name of [
  'bookings', 'users', 'drivers', 'driverProfiles', 'serviceTypes', 'zones', 'pricingRules',
  'appConfig', 'adminAuditLogs', 'supportTickets', 'ratings', 'coupons', 'vehicles',
]) {
  names.add(name);
}

const results = [];
for (const name of [...names].sort()) results.push({ name, ...(await wipeCollection(name)) });

const accounts = await auth.listUsers(1000);
for (const account of accounts.users) await auth.deleteUser(account.uid);
console.log(`  ${'auth users'.padEnd(18)} ${String(accounts.users.length).padStart(4)} → 0`);

try {
  const bucket = getStorage().bucket(`${PROJECT_ID}.appspot.com`);
  const [files] = await bucket.getFiles();
  for (const file of files) await file.delete({ ignoreNotFound: true });
  console.log(`  ${'storage files'.padEnd(18)} ${String(files.length).padStart(4)} → 0`);
} catch (error) {
  console.log(`  storage files: not reachable (${String(error).slice(0, 90)})`);
}

console.log('');
const survivors = results.filter((row) => row.after > 0);
const left = (await auth.listUsers(10)).users.length;
if (survivors.length > 0 || left > 0) {
  console.error(
    `Not empty: ${survivors.map((row) => `${row.name} ${row.after}`).join(', ')}` +
      (left > 0 ? `, ${left} auth accounts` : ''),
  );
  process.exit(1);
}
console.log('The emulator is empty. `npm run seed` restores the demo dataset, `npm run emulators` starts fresh.');
