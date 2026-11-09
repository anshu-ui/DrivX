#!/usr/bin/env node
/**
 * One-off provisioning against the live Firebase project.
 *
 * The emulator gets its data from `scripts/seed.mjs`, which talks to the
 * emulator's unauthenticated admin endpoints. None of that works against
 * `drivx-116de`, and it must not: production writes need the Admin SDK, and the
 * two things production needs before a phone can sign in — the pricing catalogue
 * and a staff account — are exactly the two things security rules deliberately
 * forbid any client from writing.
 *
 *   node scripts/provision-live.mjs --check
 *   node scripts/provision-live.mjs --catalogue
 *   node scripts/provision-live.mjs --staff you@example.com "Your name" [--role ops]
 *   node scripts/provision-live.mjs --customer +918510840825
 *   node scripts/provision-live.mjs --driver +918510840825   # second account on the same number
 *   STAFF_PASSWORD=… node scripts/provision-live.mjs --staff …    # otherwise one is printed once.
 *                                                                  # When the account already
 *                                                                  # exists, this replaces its
 *                                                                  # password instead of skipping.
 *
 * It creates accounts and reference data only. It never writes a demo booking, a
 * demo driver or a document upload, because a fake trip in the production ledger
 * would be billed, dispatched and reported on for real.
 */

import { launchCatalogue } from './lib/launch-catalogue.mjs';
import { liveRefreshCredential } from './lib/live-credentials.mjs';

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID ?? 'drivx-116de';

if (PROJECT_ID === 'drivx-local') {
  throw new Error('Refusing to run against the emulator project — use `npm run seed`.');
}

const argv = process.argv.slice(2);
const flag = (name) => argv.indexOf(name) !== -1;
const after = (name, offset = 1) => argv[argv.indexOf(name) + offset];

const { initializeApp, refreshToken } = await import('firebase-admin/app');
const { getAuth } = await import('firebase-admin/auth');
const { Firestore, Timestamp } = await import('@google-cloud/firestore');

const { account, credential } = liveRefreshCredential();
initializeApp({ projectId: PROJECT_ID, credential: refreshToken(credential) });
const auth = getAuth();

// `firebase-admin` refuses to build a Firestore client from a refresh-token
// credential — it wants a service-account certificate — even though the same
// credential authorizes every Auth call. The underlying Firestore client takes
// the authorized-user JSON directly, so it is opened through that.
const db = new Firestore({ projectId: PROJECT_ID, credentials: credential });

/** `*Ms` fields are integers in the domain types and Timestamps in Firestore. */
function toFirestore(record) {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      key.endsWith('Ms') && typeof value === 'number' ? Timestamp.fromDate(new Date(value)) : value,
    ]),
  );
}

async function check() {
  console.log(`project: ${PROJECT_ID}   credential: ${account}\n`);

  const users = await auth.listUsers(100);
  console.log(`auth users: ${users.users.length}`);
  for (const user of users.users) {
    const claims = user.customClaims ?? {};
    console.log(
      `  ${user.uid}  ${user.phoneNumber ?? user.email ?? '(no provider)'}  ` +
        `role=${claims.role ?? '-'} admin=${claims.admin ?? '-'} ops=${claims.ops ?? '-'}`,
    );
  }

  for (const collection of ['serviceTypes', 'pricingRules', 'users', 'driverProfiles', 'bookings']) {
    const snapshot = await db.collection(collection).limit(100).get();
    console.log(`${collection}: ${snapshot.size}`);
  }
}

/** Read the public fare catalogue only; deliberately omit user and booking data. */
async function pricing() {
  console.log(`project: ${PROJECT_ID}   credential: ${account}\n`);
  const [services, rules] = await Promise.all([
    db.collection('serviceTypes').limit(100).get(),
    db.collection('pricingRules').limit(100).get(),
  ]);
  const byId = new Map(rules.docs.map((row) => [row.id, row.data()]));
  for (const row of services.docs) {
    const service = row.data();
    const ruleId = service.pricingRuleId;
    const rule = byId.get(ruleId) ?? {};
    const fare = rule.pricingModel === 'distance_slab'
      ? rule.slabs?.map((slab) => `≤${slab.upToKilometers}km ₹${slab.farePaise / 100}`).join(' | ')
        + ` | overflow ₹${(rule.slabOverflowPerKmPaise ?? 0) / 100}/km`
      : rule.pricingModel === 'hourly_package'
        ? rule.packages?.map((tier) => `${tier.label}: ₹${tier.packagePricePaise / 100}`).join(' | ')
        : `base ₹${(rule.baseFarePaise ?? 0) / 100} + ₹${(rule.perKmPaise ?? 0) / 100}/km`;
    console.log(`${row.id}: enabled=${Boolean(service.enabled)} rule=${ruleId ?? '-'} model=${rule.pricingModel ?? '-'} active=${Boolean(rule.active)} ${fare ?? ''}`);
  }
}

async function catalogue() {
  const { pricingRules, serviceTypes } = launchCatalogue(Date.now());
  for (const rule of pricingRules) {
    await db.collection('pricingRules').doc(rule.id).set(toFirestore(rule));
    const price =
      rule.pricingModel === 'distance_slab'
        ? `${rule.slabs.length} bands to ${rule.slabs.at(-1)?.upToKilometers} km, then ₹${(rule.slabOverflowPerKmPaise ?? 0) / 100}/km`
        : rule.pricingModel === 'hourly_package'
          ? `${rule.packages.length} packages ₹${rule.packages.map((tier) => tier.packagePricePaise / 100).join('/')} with ₹${(rule.packages[0]?.extraKmPaise ?? 0) / 100}/km extra`
          : `₹${rule.perKmPaise / 100}/km`;
    console.log(`✓ pricingRules/${rule.id} — ${price}`);
  }
  for (const svc of serviceTypes) {
    await db.collection('serviceTypes').doc(svc.id).set(toFirestore(svc));
    console.log(`✓ serviceTypes/${svc.id} — ${svc.name}, rule ${svc.pricingRuleId}`);
  }
  const readBack = await Promise.all([
    db.collection('pricingRules').count().get(),
    db.collection('serviceTypes').count().get(),
  ]);
  console.log(`live counts — pricingRules: ${readBack[0].data().count}, serviceTypes: ${readBack[1].data().count}`);
}

/** Update only approved pricing fields and the onboarding fee in production. */
async function pricingOnly() {
  const { pricingRules } = launchCatalogue(Date.now());
  const pricingFields = [
    ['ggn-outstation-per-km', ['pricingModel', 'baseFarePaise', 'perKmPaise', 'slabs', 'slabOverflowPerKmPaise', 'nightSurcharge', 'distanceRounding', 'estimateValidityMinutes', 'active']],
    ['ggn-outstation-round-trip', ['pricingModel', 'packages', 'overtimeGraceMinutes', 'nightSurcharge', 'distanceRounding', 'estimateValidityMinutes', 'active']],
  ];
  for (const [id, fields] of pricingFields) {
    const rule = pricingRules.find((item) => item.id === id);
    if (!rule) throw new Error(`Missing live pricing rule ${id}`);
    const ref = db.collection('pricingRules').doc(id);
    const snapshot = await ref.get();
    if (!snapshot.exists && id === 'ggn-outstation-round-trip') {
      await ref.set(toFirestore(rule));
      console.log(`✓ pricingRules/${id} created from the outstation day-package catalogue`);
      continue;
    }
    if (!snapshot.exists) throw new Error(`Live pricing rule ${id} does not exist; refusing partial catalogue creation.`);
    const current = snapshot.data();
    const update = Object.fromEntries(fields.map((field) => [field, rule[field]]));
    update.pricingVersion = Number(current.pricingVersion ?? 1) + 1;
    update.updatedAtMs = Timestamp.now();
    await ref.update(update);
    console.log(`✓ pricingRules/${id} updated (version ${update.pricingVersion})`);
  }
  await db.collection('serviceTypes').doc('chauffeur_outstation').update({
    enabled: true,
    description: 'One-way distance packages through 3,000 km; extra odometer distance is ₹10/km. Round trips use the 1–30 day packages and do not bill kilometres separately.',
    roundTripPricingRuleId: 'ggn-outstation-round-trip',
    updatedAtMs: Timestamp.now(),
  });
  console.log(`✓ serviceTypes/chauffeur_outstation — enabled (one-way and round-trip packages through 3,000 km / 30 days)`);
  console.log('✓ Updated only the two outstation pricing rules; local pricing and night-charge settings were left untouched');
}

async function staff(email, displayName, role) {
  if (!email || !displayName) {
    throw new Error('--staff needs an email and a display name, e.g. --staff you@example.com "Amit"');
  }
  const password = process.env.STAFF_PASSWORD ?? generatePassword();
  const claims =
    role === 'ops'
      ? { role: 'ops', roles: ['ops'], admin: false, ops: true, driverVerified: false, zoneId: null, serviceTypeIds: [] }
      : { role: 'admin', roles: ['admin'], admin: true, ops: false, driverVerified: false, zoneId: null, serviceTypeIds: [] };

  let uid;
  try {
    const created = await auth.createUser({
      email,
      emailVerified: true,
      password,
      displayName,
    });
    uid = created.uid;
    console.log(`✓ created ${email} (uid ${uid})`);
  } catch (error) {
    if (error?.code !== 'auth/email-already-exists') throw error;
    const existing = await auth.getUserByEmail(email);
    uid = existing.uid;
    // An account the Console already holds is usually one the owner made by
    // hand, so the password is only replaced when it was passed in deliberately.
    if (!process.env.STAFF_PASSWORD) {
      console.log(`• ${email} already exists (uid ${uid}); password left untouched`);
    } else {
      await auth.updateUser(uid, { password, displayName });
      console.log(`✓ password set for ${email} (uid ${uid})`);
    }
  }

  await auth.setCustomUserClaims(uid, claims);
  await db
    .collection('users')
    .doc(uid)
    .set(
      toFirestore({
        uid,
        phoneNumberE164: null,
        email,
        displayName,
        role: claims.role,
        accountStatus: 'active',
        localeTag: 'en-IN',
        timeZone: 'Asia/Kolkata',
        fcmToken: null,
        deletionScheduledAtMs: null,
        createdAtMs: Date.now(),
        lastSignInAtMs: null,
      }),
      { merge: true },
    );

  const readBack = await auth.getUser(uid);
  console.log(`✓ claims: ${JSON.stringify(readBack.customClaims)}`);
  if (!process.env.STAFF_PASSWORD) {
    console.log(`\n  sign-in password (shown once, not stored anywhere): ${password}\n`);
  }
}

/**
 * The provisioning that `provisionSelf` would perform, run by the project owner
 * instead of by the app.
 *
 * No callable on this project is reachable from a browser while the
 * `referralme.in` organisation policy refuses `allUsers` on Cloud Run, so a
 * freshly verified number cannot mint its own `role: customer` claim and stops
 * at "Your name and email" — which means nothing in the app can be tested live.
 * This writes exactly what that callable writes: the `users/{uid}` row, the
 * default `customerProfiles/{uid}` row, and the customer claim. The number must
 * already have signed in through OTP, so the phone is verified by Firebase and
 * not asserted here.
 *
 * It cannot escalate anyone: `customer` is the only role it ever writes, and an
 * account that already has a `users/{uid}` row keeps whatever claims an
 * administrator set on it.
 */
async function customer(phone) {
  if (!/^\+[1-9]\d{7,14}$/.test(phone ?? '')) {
    throw new Error('--customer needs an E.164 number, e.g. --customer +918510840825');
  }

  let user;
  try {
    user = await auth.getUserByPhoneNumber(phone);
  } catch (error) {
    if (error?.code === 'auth/user-not-found') {
      throw new Error(
        `No live account has verified ${phone} yet. Sign in with that number once, then run this.`,
      );
    }
    throw error;
  }

  const userRef = db.collection('users').doc(user.uid);
  const profileRef = db.collection('customerProfiles').doc(user.uid);
  const [existingUser, existingProfile] = await Promise.all([userRef.get(), profileRef.get()]);
  const email = user.email ?? null;

  if (existingUser.exists) {
    console.log(`• ${phone} already has users/${user.uid}; nothing written`);
  } else {
    await userRef.set(
      toFirestore({
        uid: user.uid,
        phoneNumberE164: phone,
        email,
        displayName: user.displayName ?? null,
        role: 'customer',
        accountStatus: 'active',
        localeTag: 'en-IN',
        timeZone: 'Asia/Kolkata',
        fcmToken: null,
        deletionScheduledAtMs: null,
        createdAtMs: Date.now(),
        lastSignInAtMs: user.metadata?.lastSignInTime
          ? Date.parse(user.metadata.lastSignInTime)
          : Date.now(),
      }),
    );
    if (!existingProfile.exists) {
      await profileRef.set(
        toFirestore({
          uid: user.uid,
          fullName: user.displayName ?? '',
          email,
          defaultPickup: null,
          preferredTransmission: 'either',
          preferredCarTypes: [],
          contactPhoneE164: phone,
          privacy: {
            shareTripWithContact: false,
            marketingOptIn: false,
            preciseLocationWhileIdle: false,
          },
          emergencyContact: { name: null, phoneE164: null, sharesLiveLocation: false },
          ratingAverage: null,
          ratingCount: 0,
          lifetimeBookings: 0,
          createdAtMs: Date.now(),
          updatedAtMs: Date.now(),
        }),
      );
    }
    await auth.setCustomUserClaims(user.uid, {
      role: 'customer',
      roles: ['customer'],
      admin: false,
      ops: false,
      driverVerified: false,
      zoneId: null,
      serviceTypeIds: [],
    });
    console.log(
      `✓ users/${user.uid}${existingProfile.exists ? ' (profile kept as-is)' : ''} + customer claim`,
    );
  }

  const [readBack, profile] = await Promise.all([auth.getUser(user.uid), profileRef.get()]);
  console.log(`  claims:  ${JSON.stringify(readBack.customClaims ?? {})}`);
  console.log(
    `  profile: ${profile.exists ? 'exists' : 'MISSING'}, ` +
      `fullName ${JSON.stringify(profile.data()?.fullName ?? '')} — the app asks for it when empty`,
  );
}

/**
 * The second account on the same number.
 *
 * One phone number is allowed to be both a customer and a driver, so this only
 * ever *adds*: the driver role joins whatever `roles` the account already holds,
 * the existing customer profile is left completely alone, and the default
 * surface stays where an administrator put it. The driver app is then reachable
 * from the switch on the customer Account screen.
 *
 * It writes the same starting `driverProfiles/{uid}` document the app's own
 * first-run step would, with `verificationStatus: not_started` — approval still
 * has to come from the admin console, which is the only thing that sets
 * `driverVerified`. Nothing here unlocks work on its own.
 */
async function driver(phone) {
  if (!/^\+[1-9]\d{7,14}$/.test(phone ?? '')) {
    throw new Error('--driver needs an E.164 number, e.g. --driver +918510840825');
  }

  let user;
  try {
    user = await auth.getUserByPhoneNumber(phone);
  } catch (error) {
    if (error?.code === 'auth/user-not-found') {
      throw new Error(
        `No live account has verified ${phone} yet. Sign in with that number once, then run this.`,
      );
    }
    throw error;
  }

  const claims = user.customClaims ?? {};
  const roles = [...new Set([...(Array.isArray(claims.roles) ? claims.roles : []), 'driver'])];
  const profileRef = db.collection('driverProfiles').doc(user.uid);
  const existing = await profileRef.get();

  if (existing.exists) {
    console.log(`• driverProfiles/${user.uid} already exists; nothing written`);
  } else {
    const customerProfile = await db.collection('customerProfiles').doc(user.uid).get();
    await profileRef.set(
      toFirestore({
        uid: user.uid,
        fullName: customerProfile.data()?.fullName ?? user.displayName ?? '',
        phoneE164: phone,
        photoUrl: null,
        languages: ['en'],
        zoneId: claims.zoneId ?? 'delhi-ncr',
        serviceAreas: [],
        // No car on file until the driver or the office enters one; the
        // customer's driver card then says so instead of inventing a plate.
        vehicleMake: null,
        vehicleModel: null,
        vehiclePlate: null,
        serviceTypeIds: [],
        verificationStatus: 'not_started',
        verifiedAtMs: null,
        verifiedByUid: null,
        rejectionReason: null,
        documentsExpiringBeforeMs: null,
        availabilityState: 'offline',
        availabilitySinceMs: null,
        ratingAverage: 0,
        ratingCount: 0,
        lifetimeTrips: 0,
        onTimeArrivalRate: null,
        acceptanceRate: null,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      }),
    );
  }

  await auth.setCustomUserClaims(user.uid, { ...claims, roles });

  const readBack = await auth.getUser(user.uid);
  console.log(`✓ ${phone} is now a driver too (driverProfiles/${user.uid})`);
  console.log(`  claims: ${JSON.stringify(readBack.customClaims ?? {})}`);
  console.log(
    '  The driver app opens from the switch at the bottom of the customer Account tab.',
  );
}

/** Readable over the phone, long enough that Auth's strength meter accepts it. */
function generatePassword() {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

try {
  if (flag('--catalogue')) await catalogue();
  else if (flag('--pricing-only')) await pricingOnly();
  else if (flag('--pricing')) await pricing();
  else if (flag('--staff'))
    await staff(after('--staff'), after('--staff', 2), flag('--role') ? after('--role') : 'admin');
  else if (flag('--customer')) await customer(after('--customer'));
  else if (flag('--driver')) await driver(after('--driver'));
  else await check();
} catch (error) {
  console.error(`\n✗ ${error?.message ?? error}`);
  if (error?.errorInfo) console.error(JSON.stringify(error.errorInfo));
  process.exit(1);
}
