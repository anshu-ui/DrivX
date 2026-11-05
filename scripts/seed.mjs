#!/usr/bin/env node
/**
 * Seeds the Firebase Auth and Firestore emulators with a realistic DrivX
 * dataset: accounts with minted custom claims, profiles, a service catalogue,
 * pricing rules, launch config and one in-progress booking.
 *
 * Emulator-only by design. Against a live project this would need the Admin SDK
 * and service-account credentials, which never belong in a repository; role
 * changes in production go through the `setRole` Cloud Function instead.
 *
 *   npm run emulators     # terminal 1 (needs Java 21+)
 *   npm run seed          # terminal 2
 *
 * Every document below follows the record types in @drivx/domain, and `*Ms`
 * fields are written as native Firestore Timestamps, which is how Cloud
 * Functions store them (see packages/firebase-client/src/serialize.ts).
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';

import { computeFare } from '../packages/domain/src/pricing.ts';
import { launchCatalogue } from './lib/launch-catalogue.mjs';
import {
  COMMISSION_TERMS,
  commissionDueId,
  commissionSnapshotFor,
  commissionTitleFor,
} from '../packages/domain/src/records-identity.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function readProjectId() {
  try {
    const rc = JSON.parse(readFileSync(`${ROOT}.firebaserc`, 'utf8'));
    return rc.projects?.default ?? 'drivx-local';
  } catch {
    return 'drivx-local';
  }
}

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID ?? readProjectId();
const HOST = process.env.FIREBASE_EMULATOR_HOST ?? '127.0.0.1';
const AUTH_PORT = Number(process.env.AUTH_EMULATOR_PORT ?? 9099);
const FIRESTORE_PORT = Number(process.env.FIRESTORE_EMULATOR_PORT ?? 8080);
const FIRESTORE_BASE = `http://${HOST}:${FIRESTORE_PORT}/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

const PASSWORD = 'drivx-dev-password';
/**
 * Fixed tail on every seeded uid. `uidSchema` in the privileged Cloud Functions
 * refuses an id under twenty characters, so a bare alias like `drv-1` cannot be
 * approved, rejected or billed — the verification console would be holding demo
 * drivers it is forbidden to act on.
 */
const SEED_UID_TAIL = 'drivx-local-seed';
const seedUidFor = (alias) => `${alias}-${SEED_UID_TAIL}`;

/**
 * Accounts go through the Admin SDK, not raw Identity Toolkit REST calls: the
 * Auth emulator does not implement `accounts:update`, and its admin endpoints are
 * only reachable through the SDK's emulator transport. No credentials are needed
 * because `FIREBASE_AUTH_EMULATOR_HOST` puts the SDK in emulator mode.
 */
async function createAuthClient() {
  process.env.FIREBASE_AUTH_EMULATOR_HOST = `${HOST}:${AUTH_PORT}`;
  const { initializeApp } = await import('firebase-admin/app');
  const { getAuth } = await import('firebase-admin/auth');
  initializeApp({ projectId: PROJECT_ID });
  return getAuth();
}

function reachable(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: HOST, port });
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => resolve(false));
    socket.once('error', () => resolve(false));
  });
}

/**
 * Lists the ids currently in a collection. `Bearer owner` bypasses the rules the
 * same way a write does; against a real project this returns nothing useful,
 * which is another reason the sweep below is limited to seed-owned collections.
 */
async function listDocumentIds(collection) {
  const response = await fetch(
    `${FIRESTORE_BASE}/${collection}?pageSize=300`,
    { headers: { Authorization: 'Bearer owner' } },
  );
  const json = await assertOk(response, `list ${collection}`);
  return (json.documents ?? []).map((doc) => doc.name.split('/').pop());
}

async function deleteDocument(path) {
  await fetch(`${FIRESTORE_BASE}:commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({
      writes: [{ delete: `projects/${PROJECT_ID}/databases/(default)/documents/${path}` }],
    }),
  }).then((r) => assertOk(r, `delete ${path}`));
}

/**
 * Deletes documents in a collection this file owns completely, so a fixture
 * removed here cannot keep being served from an earlier seed. A retired pricing
 * rule is the case that matters: `createBooking` walks `pricingRules`, and a
 * leftover from the pre-engine catalogue has no `pricingModel` at all, so the
 * demo would fail on data the repository no longer describes.
 *
 * Only collections listed at `SEED_OWNED_COLLECTIONS` are swept — bookings,
 * profiles and support tickets are demo history that a partial edit should not
 * erase.
 */
async function sweepOwnedCollection(collection, keepIds) {
  const stale = (await listDocumentIds(collection)).filter((id) => !keepIds.has(id));
  for (const id of stale) {
    await deleteDocument(`${collection}/${id}`);
    console.log(`  removed stale ${collection}/${id}`);
  }
  return stale.length;
}

/** A `*Ms` value stored as a native Timestamp, offset in minutes from now. */
const stamp = (minutesFromNow = 0) => ({ __ts: new Date(Date.now() + minutesFromNow * 60_000).toISOString() });

const DAY = 1440;

function toFieldValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (value.__ts) return { timestampValue: value.__ts };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toFieldValue) } };
  if (typeof value === 'object') {
    return {
      mapValue: { fields: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toFieldValue(v)])) },
    };
  }
  throw new Error(`Cannot encode ${typeof value} for Firestore`);
}

async function assertOk(response, label) {
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} failed with ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

/**
 * Writes one document through the emulator's Firestore REST API.
 *
 * `:commit` rather than the `?documentId=` create endpoint, because a create
 * fails with ALREADY_EXISTS on the second run — a seed has to be re-runnable, and
 * an update in a commit replaces the whole document, so fields removed from a
 * fixture disappear instead of lingering from an older seed.
 *
 * `Bearer owner` is the emulator's magic token: it bypasses the security rules,
 * which is the point of a seed, and it has no effect against a real project.
 */
async function writeDocument(path, body) {
  const url = `${FIRESTORE_BASE}:commit`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({
      writes: [
        {
          update: {
            name: `projects/${PROJECT_ID}/databases/(default)/documents/${path}`,
            fields: Object.fromEntries(Object.entries(body).map(([k, v]) => [k, toFieldValue(v)])),
          },
        },
      ],
    }),
  }).then((r) => assertOk(r, `write ${path}`));
}

/**
 * Creates the account, or repairs an existing one, and always re-mints its
 * claims. `createUser` accepts `customClaims` but the emulator only applies them
 * reliably through `setCustomUserClaims`, and a re-run has to pick up any claim
 * changes made in this file since the last seed.
 *
 * The uid is the alias plus a fixed tail, so the dataset is byte-for-byte
 * reproducible across runs *and* the length looks like a real one. The tail
 * matters: `uidSchema` in Cloud Functions refuses an id under twenty characters,
 * and an id like `drv-1` made every seeded driver un-actionable in the
 * verification console — the operator pressed "Money collected" and got a
 * validation error about the shape of a uid they did not type.
 */
async function upsertAccount(auth, { alias, email, phoneE164, claims }) {
  const fields = {
    email,
    emailVerified: true,
    password: PASSWORD,
    displayName: claims.displayName,
    phoneNumber: phoneE164,
  };
  const uid = seedUidFor(alias);

  // Resolve identity before writing, so a re-run updates rather than tripping over
  // whichever conflict a blind create raises: uid, email and phone each have one.
  // An account found under another uid — the bare alias an older seed used, or a
  // random one the Auth emulator minted before that — is retired rather than
  // adopted, because the fixture's documents have to end up under one id.
  const existing =
    (await auth.getUser(uid).catch(() => null)) ??
    (await auth.getUserByEmail(email).catch(() => null));

  if (existing && existing.uid !== uid) {
    await retireAccount(auth, existing.uid);
  }

  if (await auth.getUser(uid).catch(() => null)) {
    await auth.updateUser(uid, fields);
  } else {
    await auth.createUser({ uid, ...fields });
  }

  await auth.setCustomUserClaims(uid, claims.custom);
  return uid;
}

/**
 * Deletes everything the previous seed wrote for one uid, then the account.
 * Only the per-person collections are keyed by uid, so those are the paths that
 * would otherwise be left pointing at a user who no longer exists — a stale
 * `driverProfiles` row keeps showing up in the review queue.
 */
async function retireAccount(auth, oldUid) {
  const subcollections = [
    'driverProfiles/documents',
    'driverProfiles/dues',
    'savedPlaces/places',
    'users/notifications',
  ];
  for (const pair of subcollections) {
    const [collection, sub] = pair.split('/');
    const parent = `${collection}/${oldUid}`;
    const ids = await listDocumentIds(`${parent}/${sub}`).catch(() => []);
    for (const id of ids) await deleteDocument(`${parent}/${sub}/${id}`);
  }
  for (const path of [`driverProfiles/${oldUid}`, `customerProfiles/${oldUid}`, `users/${oldUid}`]) {
    await deleteDocument(path);
  }
  await auth.deleteUser(oldUid).catch(() => null);
  console.log(`  retired seed account ${oldUid}`);
}

/**
 * Relational fixtures below refer to people by short aliases (`cust-1`,
 * `drv-1`). The Auth emulator mints a random uid per account, so those aliases
 * are replaced with the real uids as the documents are written — otherwise the
 * seeded booking would point at a customer who does not exist, and the security
 * rules would (correctly) refuse to let the seeded customer read it.
 */
const uidAliases = {};
const ALIAS_PATTERN = /\b(?:cust|drv|admin|ops)-\d+\b/g;

function resolveAliases(text) {
  return text.replace(ALIAS_PATTERN, (alias) => {
    const uid = uidAliases[alias];
    if (!uid) {
      throw new Error(
        `Seed fixture references "${alias}", which no seeded account claims. ` +
          'Add the alias to that account or fix the reference.',
      );
    }
    return uid;
  });
}

/** Deep walk so an alias is replaced wherever it appears, including in paths. */
function resolveIds(value) {
  if (typeof value === 'string') return resolveAliases(value);
  if (Array.isArray(value)) return value.map(resolveIds);
  if (value && typeof value === 'object' && !value.__ts) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveIds(v)]));
  }
  return value;
}

const ACCOUNTS = [
  {
    alias: 'cust-1',
    email: 'amit@example.test',
    phoneE164: '+919000000001',
    claims: {
      displayName: 'Amit Chauhan',
      custom: {
        role: 'customer', roles: ['customer'], admin: false, ops: false, driverVerified: false,
        zoneId: 'zone-ggn-1', serviceTypeIds: ['chauffeur_own_car', 'chauffeur_hourly'], testAccount: true,
      },
    },
  },
  {
    alias: 'cust-2',
    email: 'priya@example.test',
    phoneE164: '+919000000002',
    claims: {
      displayName: 'Priya Nair',
      custom: {
        role: 'customer', roles: ['customer'], admin: false, ops: false, driverVerified: false,
        zoneId: 'zone-del-1', serviceTypeIds: ['chauffeur_own_car'], testAccount: true,
      },
    },
  },
  {
    alias: 'drv-1',
    email: 'rakesh@example.test',
    phoneE164: '+919000000011',
    claims: {
      displayName: 'Rakesh Yadav',
      custom: {
        role: 'driver', roles: ['driver'], admin: false, ops: false, driverVerified: true,
        zoneId: 'zone-ggn-1', serviceTypeIds: ['chauffeur_own_car', 'chauffeur_hourly', 'chauffeur_outstation'], testAccount: true,
      },
    },
  },
  {
    alias: 'drv-2',
    email: 'suna@example.test',
    phoneE164: '+919000000012',
    claims: {
      displayName: 'Suna Verma',
      custom: {
        role: 'driver', roles: ['driver'], admin: false, ops: false, driverVerified: false,
        zoneId: 'zone-ggn-1', serviceTypeIds: [], testAccount: true,
      },
    },
  },
  {
    alias: 'ops-1',
    email: 'ops@drivx.test',
    phoneE164: '+919000000021',
    claims: {
      displayName: 'Ops Desk',
      custom: {
        role: 'ops', roles: ['ops'], admin: false, ops: true, driverVerified: false,
        zoneId: 'zone-ggn-1', serviceTypeIds: ['chauffeur_own_car'], testAccount: true,
      },
    },
  },
  {
    alias: 'admin-1',
    email: 'admin@drivx.test',
    phoneE164: '+919000000099',
    claims: {
      displayName: 'Platform Admin',
      custom: {
        role: 'admin', roles: ['admin'], admin: true, ops: false, driverVerified: false,
        zoneId: null, serviceTypeIds: ['chauffeur_own_car', 'chauffeur_hourly'], testAccount: true,
      },
    },
  },
];

const PLACE_HOME = {
  label: 'Sector 56 residence',
  addressLine1: 'Sector 56 Main Road',
  addressLine2: 'Block C',
  city: 'Gurugram',
  state: 'Haryana',
  pincode: '122015',
  location: { lat: 28.4512, lng: 77.0211 },
  source: 'saved_place',
};

const PLACE_CP = {
  label: 'Connaught Place',
  addressLine1: 'Barakhamba Road',
  city: 'New Delhi',
  state: 'Delhi',
  pincode: '110001',
  location: { lat: 28.6315, lng: 77.2167 },
  placeId: 'ChIJi7xJQWU9DDi5wZqntDOVamY',
  source: 'places_autocomplete',
};

/** users/{uid} and the role profile, keyed by phone for readability. */
const PROFILE_DOCUMENTS = {
  '+919000000001': [
    ['customerProfiles', {
      fullName: 'Amit Chauhan',
      email: 'amit@example.test',
      defaultPickup: PLACE_HOME,
      preferredTransmission: 'automatic',
      preferredCarTypes: ['sedan', 'ev'],
      contactPhoneE164: '+919000000001',
      privacy: { shareTripWithContact: true, marketingOptIn: false, preciseLocationWhileIdle: false },
      emergencyContact: { name: 'Neelu Chauhan', phoneE164: '+919000000005', sharesLiveLocation: true },
      ratingAverage: 4.8,
      ratingCount: 12,
      lifetimeBookings: 3,
    }],
  ],
  '+919000000002': [
    ['customerProfiles', {
      fullName: 'Priya Nair',
      email: 'priya@example.test',
      defaultPickup: null,
      preferredTransmission: 'either',
      preferredCarTypes: ['hatchback'],
      contactPhoneE164: '+919000000002',
      privacy: { shareTripWithContact: false, marketingOptIn: true, preciseLocationWhileIdle: false },
      emergencyContact: { name: null, phoneE164: null, sharesLiveLocation: false },
      ratingAverage: 4.5,
      ratingCount: 4,
      lifetimeBookings: 1,
    }],
  ],
  '+919000000011': [
    ['driverProfiles', {
      fullName: 'Rakesh Yadav',
      phoneE164: '+919000000011',
      photoUrl: null,
      languages: ['hi', 'en', 'pa'],
      zoneId: 'zone-ggn-1',
      serviceAreas: [{ center: { lat: 28.45, lng: 77.02 }, radiusMeters: 12_000, kind: 'pickup' }],
      vehicleMake: null,
      vehicleModel: null,
      vehiclePlate: null,
      serviceTypeIds: ['chauffeur_own_car', 'chauffeur_hourly', 'chauffeur_outstation'],
      verificationStatus: 'approved',
      verifiedAtMs: stamp(-60 * DAY),
      verifiedByUid: 'admin-1',
      rejectionReason: null,
      // Minted by `setDriverVerification` on approval; a seeded approved driver
      // carries the id they would have been given.
      driverId: 'DRV-K7M2XQ',
      documentsExpiringBeforeMs: stamp(700 * DAY),
      // Offline, and that is the honest reading on both surfaces. Nothing in
      // Phase 1 writes presence — the switch lives in Realtime Database with
      // dispatch (Phase 3) — so the app shows "offline" and this Firestore
      // mirror is what the `/dues` console reads. It used to say `online`,
      // which put a driver beside his ₹337.15 money hold in the state the dues
      // gate exists to make unreachable.
      availabilityState: 'offline',
      availabilitySinceMs: stamp(-40),
      ratingAverage: 4.9,
      ratingCount: 80,
      lifetimeTrips: 120,
      onTimeArrivalRate: 0.94,
      acceptanceRate: 0.88,
    }],
  ],
  '+919000000012': [
    ['driverProfiles', {
      fullName: 'Suna Verma',
      phoneE164: '+919000000012',
      photoUrl: null,
      languages: ['hi'],
      zoneId: 'zone-ggn-1',
      serviceAreas: [],
      // Not invented. The customer's driver card shows the car recorded here, so
      // an empty field reads on the trip screen as "not recorded" rather than as
      // a made-up model with a made-up plate.
      vehicleMake: null,
      vehicleModel: null,
      vehiclePlate: null,
      serviceTypeIds: [],
      verificationStatus: 'pending_review',
      verifiedAtMs: null,
      verifiedByUid: null,
      rejectionReason: null,
      driverId: null,
      documentsExpiringBeforeMs: null,
      availabilityState: 'offline',
      availabilitySinceMs: stamp(-3 * DAY),
      ratingAverage: 0,
      ratingCount: 0,
      lifetimeTrips: 0,
      onTimeArrivalRate: null,
      acceptanceRate: null,
    }],
  ],
};

/**
 * The seeded bookings are dated relative to now, so the demo always shows a trip
 * in progress rather than one from whenever this file was last edited.
 */
const NOW_MS = Date.now();
const MINUTE_MS = 60_000;
const DAY_MS = DAY * MINUTE_MS;

/**
 * The launch service catalogue and pricing rules come from
 * `scripts/lib/launch-catalogue.mjs`, which `scripts/provision-live.mjs` also
 * writes into the live project. Keeping one copy means the emulator can never
 * quote a trip at a different ₹ than production does.
 */
const { pricingRules: PRICING_RULES, serviceTypes: SERVICE_TYPES } = launchCatalogue(NOW_MS);

const ruleById = (id) => {
  const found = PRICING_RULES.find((rule) => rule.id === id);
  if (!found) throw new Error(`seed references an unknown pricing rule "${id}"`);
  return found;
};

/**
 * Every fare below is *computed* by the domain engine from the rules above, so
 * the seeded receipts are the same numbers `createBooking` will produce. A
 * hand-typed fare drifts the moment either side changes, and a demo receipt that
 * contradicts the engine is worse than no receipt.
 */
const snapshotHash = (canonical) => `sha256:${createHash('sha256').update(canonical).digest('hex')}`;

const quoteFare = (ruleId, overrides) =>
  computeFare({
    rule: ruleById(ruleId),
    zoneId: ruleById(ruleId).zoneId,
    distanceMeters: 0,
    durationSeconds: 0,
    waitingMinutes: 0,
    localStartHour: 14,
    surgeMultiplier: 1,
    packageTierId: null,
    kind: 'estimate',
    nowMs: NOW_MS,
    hash: snapshotHash,
    ...overrides,
  });

/** The in-flight booking: quoted 21.4 km, four minutes ago, still inside its TTL. */
const FARE_ESTIMATE = quoteFare('ggn-city-one-way', {
  distanceMeters: 21_400,
  durationSeconds: 2_700,
  nowMs: NOW_MS - 4 * MINUTE_MS,
});

/** bk-demo-2 — quoted at 21.4 km, driven 22.1 km, and waited 20 minutes at pickup. */
const FARE_2_ESTIMATE = quoteFare('ggn-city-one-way', {
  distanceMeters: 21_400,
  durationSeconds: 2_700,
  nowMs: NOW_MS - 7 * DAY_MS,
});
// The bill keeps the band the trip was sold in and meters only the kilometres
// past its ceiling, so it carries the quoted distance the callable would read.
const FARE_FINAL = quoteFare('ggn-city-one-way', {
  distanceMeters: 22_100,
  quotedDistanceMeters: 21_400,
  durationSeconds: 4_320,
  waitingMinutes: 20,
  kind: 'final',
  nowMs: NOW_MS - 7 * DAY_MS + 90 * MINUTE_MS,
});

/** bk-demo-3 — the Delhi chart: same bands, its own rule document and zone. */
const FARE_3_ESTIMATE = quoteFare('del-city-one-way', {
  distanceMeters: 21_400,
  durationSeconds: 2_700,
  nowMs: NOW_MS - 2 * DAY_MS,
});
const FARE_3_FINAL = quoteFare('del-city-one-way', {
  distanceMeters: 20_800,
  quotedDistanceMeters: 21_400,
  durationSeconds: 3_360,
  waitingMinutes: 12,
  kind: 'final',
  nowMs: NOW_MS - 2 * DAY_MS + 72 * MINUTE_MS,
});

/** An 8-hour package used for 11 hours and 142.3 km, so both overage lines appear. */
const HOURLY_TRIP = {
  packageTierId: 'h8',
  distanceMeters: 142_300,
  durationSeconds: 11 * 3_600,
};
const FARE_HOURLY = quoteFare('ggn-chauffeur-hourly', {
  ...HOURLY_TRIP,
  nowMs: NOW_MS - 3 * DAY_MS,
});
const FARE_HOURLY_FINAL = quoteFare('ggn-chauffeur-hourly', {
  ...HOURLY_TRIP,
  kind: 'final',
  nowMs: NOW_MS - 3 * DAY_MS + 672 * MINUTE_MS,
});

/** `*Ms` fields cross the persistence boundary as Timestamps, not integers. */
function toTimestamps(record) {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      key.endsWith('Ms') && typeof value === 'number' ? { __ts: new Date(value).toISOString() } : value,
    ]),
  );
}

const ALL_REFERENCE_DATA = [
  ...SERVICE_TYPES.map((svc) => [`serviceTypes/${svc.id}`, toTimestamps(svc)]),

  ...PRICING_RULES.map((rule) => [`pricingRules/${rule.id}`, toTimestamps(rule)]),


  ['bookings/bk-demo-1', {
    id: 'bk-demo-1',
    reference: 'DRX-7K3QD2',
    customerUid: 'cust-1',
    assignedDriverUid: 'drv-1',
    serviceTypeId: 'chauffeur_own_car',
    zoneId: 'zone-ggn-1',
    status: 'driver_en_route',
    paymentStatus: 'pending',
    pickup: PLACE_HOME,
    destination: PLACE_CP,
    pickupGeofence: { center: PLACE_HOME.location, radiusMeters: 120 },
    destinationGeofence: { center: PLACE_CP.location, radiusMeters: 80 },
    scheduledForMs: null,
    driverEnRouteEta: {
      minutes: 7,
      calculatedAtMs: stamp(-4),
      distanceMeters: 2_900,
      source: 'google_routes',
      trafficAware: true,
    },
    arrivalConfirmedAtMs: null,
    arrivalConfirmedManually: false,
    tripStartedAtMs: null,
    destinationDetectedAtMs: null,
    completedAtMs: null,
    completionConfirmedManually: false,
    estimate: FARE_ESTIMATE,
    finalFare: null,
    customerPreferences: { transmission: 'automatic', carType: 'sedan', notes: 'Please wait at the gate.' },
    cancellation: {
      by: null, reasonCode: null, reasonText: null, atMs: null, feePaise: 0, refundEligible: false,
    },
    idempotencyKey: 'seed-demo-1',
    routeGeometryRef: null,
    estimatedDistanceMeters: 21_400,
    estimatedDurationSeconds: 2_700,
    stateVersion: 3,
    supportHold: false,
    createdAtMs: stamp(-25),
    updatedAtMs: stamp(-4),
  }],

  ['bookings/bk-demo-1/assignments/as-1', {
    id: 'as-1',
    bookingId: 'bk-demo-1',
    driverUid: 'drv-1',
    attempt: 1,
    status: 'accepted',
    offeredAtMs: stamp(-20),
    expiresAtMs: stamp(-17),
    respondedAtMs: stamp(-19),
    declineReason: null,
    distanceToPickupMeters: 2_400,
    etaToPickupMinutes: 9,
    strategy: 'auto_dispatch',
    assignedByUid: null,
  }],

  ['bookings/bk-demo-1/events/ev-booking_created', {
    id: 'ev-booking_created',
    bookingId: 'bk-demo-1',
    type: 'booking_created',
    atMs: stamp(-25),
    actor: { uid: 'cust-1', role: 'customer' },
    location: null,
    geofenceKind: null,
    fromStatus: null,
    toStatus: 'requested',
    payload: { source: 'seed' },
    requestId: 'seed-request-1',
  }],
  ['bookings/bk-demo-1/events/ev-driver_assigned', {
    id: 'ev-driver_assigned',
    bookingId: 'bk-demo-1',
    type: 'driver_assigned',
    atMs: stamp(-19),
    actor: { uid: null, role: 'system' },
    location: null,
    geofenceKind: null,
    fromStatus: 'searching_driver',
    toStatus: 'assigned',
    payload: { driverUid: 'drv-1', attempt: 1 },
    requestId: 'seed-request-2',
  }],

  ['tripSummaries/bk-demo-1', {
    bookingId: 'bk-demo-1',
    customerUid: 'cust-1',
    driverUid: 'drv-1',
    serviceTypeId: 'chauffeur_own_car',
    startedAtMs: null,
    completedAtMs: null,
    durationSeconds: null,
    distanceMeters: null,
    distanceSource: 'unavailable',
    traceRef: null,
    pickupAddressSummary: 'Sector 56 Main Road, Gurugram',
    destinationAddressSummary: 'Connaught Place, New Delhi',
    finalFarePaise: null,
    waitingMinutes: null,
    cancellationFeePaise: null,
    paymentMethod: null,
    customerRating: null,
    driverRating: null,
    arrivedLateSeconds: null,
    createdAtMs: stamp(-19),
  }],

  ['payments/pay-demo-1', {
    id: 'pay-demo-1',
    bookingId: 'bk-demo-1',
    customerUid: 'cust-1',
    amountPaise: FARE_ESTIMATE.totalPaise,
    currency: 'INR',
    method: null,
    status: 'estimated',
    provider: null,
    providerOrderId: null,
    providerPaymentId: null,
    providerSignatureRef: null,
    verifiedAtMs: null,
    failureReason: null,
    createdAtMs: stamp(-25),
    updatedAtMs: stamp(-25),
  }],

  ['ratings/rate-demo-1', {
    id: 'rate-demo-1',
    bookingId: 'bk-demo-1',
    raterUid: 'cust-1',
    ratedUid: 'drv-1',
    direction: 'customer_to_driver',
    score: 5,
    tags: ['safe_driving', 'clean_car'],
    comment: 'Clean car, calm driving.',
    createdAtMs: stamp(-26 * DAY),
  }],

  ['users/cust-1/notifications/n-1', {
    id: 'n-1',
    uid: 'cust-1',
    type: 'driver_assigned',
    title: 'Rakesh is on the way',
    body: 'Your chauffeur is about 7 minutes from Sector 56.',
    route: '/booking/bk-demo-1/tracking',
    bookingId: 'bk-demo-1',
    data: { driverName: 'Rakesh Yadav' },
    readAtMs: null,
    dedupeKey: 'bk-demo-1:driver_assigned:1',
    // Server-managed TTL marker consumed by Firestore TTL, not by the client.
    expiresAtMs: stamp(7 * DAY),
    createdAtMs: stamp(-19),
  }],

  ['savedPlaces/cust-1/places/home', {
    id: 'home',
    uid: 'cust-1',
    label: 'home',
    name: 'Home',
    place: PLACE_HOME,
    updatedAtMs: stamp(-80 * DAY),
  }],
  ['savedPlaces/cust-1/places/work', {
    id: 'work',
    uid: 'cust-1',
    label: 'work',
    name: 'Office',
    place: PLACE_CP,
    updatedAtMs: stamp(-12 * DAY),
  }],

  /**
   * The id is the document *type*, because that is the path the app writes to
   * (`documents/{type}`) and the one the rules rebuild `storagePath` from. A
   * fixture under any other id is invisible to the driver's checklist, which is
   * how "with the office" here used to read "not uploaded" on screen.
   */
  ['driverProfiles/drv-1/documents/driving_licence', {
    id: 'driving_licence',
    driverUid: 'drv-1',
    type: 'driving_licence',
    storagePath: 'drivers/drv-1/driving_licence',
    sha256: '9b7f4d0c1e2a3b5c',
    status: 'approved',
    numberMasked: 'DL-****-4471',
    issuedBy: 'Haryana RTO',
    validFromMs: stamp(-400 * DAY),
    validUntilMs: stamp(700 * DAY),
    uploadedAtMs: stamp(-62 * DAY),
    reviewedAtMs: stamp(-60 * DAY),
    reviewedByUid: 'admin-1',
    rejectionNote: null,
  }],
  ['driverProfiles/drv-2/documents/driving_licence', {
    id: 'driving_licence',
    driverUid: 'drv-2',
    type: 'driving_licence',
    storagePath: 'drivers/drv-2/driving_licence',
    sha256: null,
    status: 'pending_review',
    numberMasked: 'DL-****-9025',
    issuedBy: 'Haryana RTO',
    validFromMs: stamp(-200 * DAY),
    validUntilMs: stamp(900 * DAY),
    uploadedAtMs: stamp(-3 * DAY),
    reviewedAtMs: null,
    reviewedByUid: null,
    rejectionNote: null,
  }],

  /**
   * The one-time onboarding fee, ₹500 plus 5% GST.
   * Rakesh cleared his before approval; Suna has not, which is the state that
   * makes `setDriverVerification` refuse to activate her. Recorded as cash by an
   * admin. Production payment settlement is handled by the Cashfree webhook.
   */
  ['driverProfiles/drv-1/dues/onboarding_fee', {
    id: 'onboarding_fee',
    driverUid: 'drv-1',
    kind: 'onboarding_fee',
    title: 'One-time onboarding fee',
    currency: 'INR',
    basePaise: 50_000,
    gstRate: 0.05,
    gstPaise: 2_500,
    totalPaise: 52_500,
    status: 'paid',
    method: 'cash',
    reference: 'Office receipt 118',
    recordedByUid: 'admin-1',
    recordedAtMs: stamp(-61 * DAY),
    createdAtMs: stamp(-62 * DAY),
    updatedAtMs: stamp(-61 * DAY),
  }],
  ['driverProfiles/drv-2/dues/onboarding_fee', {
    id: 'onboarding_fee',
    driverUid: 'drv-2',
    kind: 'onboarding_fee',
    title: 'One-time onboarding fee',
    currency: 'INR',
    basePaise: 50_000,
    gstRate: 0.05,
    gstPaise: 2_500,
    totalPaise: 52_500,
    status: 'unpaid',
    method: null,
    reference: null,
    recordedByUid: null,
    createdAtMs: stamp(-3 * DAY),
    updatedAtMs: stamp(-3 * DAY),
  }],

  /**
   * A finished journey, so the Trips screen has real history and the detail
   * screen can show an itemised *final* fare next to the original estimate.
   * `paymentStatus` stays pending on purpose: nothing counts as collected until
   * the provider verification lands in Phase 4, and a seed must not fake one.
   */
  ['bookings/bk-demo-2', {
    id: 'bk-demo-2',
    reference: 'DRX-2B9KQ7',
    customerUid: 'cust-1',
    assignedDriverUid: 'drv-1',
    serviceTypeId: 'chauffeur_own_car',
    zoneId: 'zone-ggn-1',
    status: 'completed',
    paymentStatus: 'pending',
    pickup: PLACE_CP,
    destination: PLACE_HOME,
    pickupGeofence: { center: PLACE_CP.location, radiusMeters: 120 },
    destinationGeofence: { center: PLACE_HOME.location, radiusMeters: 80 },
    scheduledForMs: null,
    driverEnRouteEta: null,
    arrivalConfirmedAtMs: stamp(-7 * DAY + 12),
    arrivalConfirmedManually: false,
    tripStartedAtMs: stamp(-7 * DAY + 18),
    destinationDetectedAtMs: stamp(-7 * DAY + 88),
    completedAtMs: stamp(-7 * DAY + 90),
    completionConfirmedManually: false,
    estimate: FARE_2_ESTIMATE,
    finalFare: FARE_FINAL,
    customerPreferences: { transmission: 'automatic', carType: 'sedan', notes: null },
    cancellation: {
      by: null, reasonCode: null, reasonText: null, atMs: null, feePaise: 0, refundEligible: false,
    },
    idempotencyKey: 'seed-demo-2',
    routeGeometryRef: null,
    estimatedDistanceMeters: 21_400,
    estimatedDurationSeconds: 2_700,
    stateVersion: 9,
    supportHold: false,
    createdAtMs: stamp(-7 * DAY),
    updatedAtMs: stamp(-7 * DAY + 90),
  }],
  ['bookings/bk-demo-2/events/ev-trip_started', {
    id: 'ev-trip_started',
    bookingId: 'bk-demo-2',
    type: 'trip_started',
    atMs: stamp(-7 * DAY + 18),
    actor: { uid: 'drv-1', role: 'driver' },
    location: null,
    geofenceKind: 'pickup',
    fromStatus: 'driver_arrived',
    toStatus: 'trip_started',
    payload: { otpChecked: true },
    requestId: 'seed-request-3',
  }],
  ['bookings/bk-demo-2/events/ev-trip_completed', {
    id: 'ev-trip_completed',
    bookingId: 'bk-demo-2',
    type: 'trip_completed',
    atMs: stamp(-7 * DAY + 90),
    actor: { uid: null, role: 'system' },
    location: null,
    geofenceKind: 'destination',
    fromStatus: 'destination_reached',
    toStatus: 'completed',
    payload: { distanceMeters: 22_100 },
    requestId: 'seed-request-4',
  }],
  ['tripSummaries/bk-demo-2', {
    bookingId: 'bk-demo-2',
    customerUid: 'cust-1',
    driverUid: 'drv-1',
    serviceTypeId: 'chauffeur_own_car',
    startedAtMs: stamp(-7 * DAY + 18),
    completedAtMs: stamp(-7 * DAY + 90),
    durationSeconds: 4_320,
    distanceMeters: 22_100,
    distanceSource: 'gps_trace',
    traceRef: 'trip-traces/bk-demo-2/trace.json',
    pickupAddressSummary: 'Connaught Place, New Delhi',
    destinationAddressSummary: 'Sector 56 Main Road, Gurugram',
    finalFarePaise: FARE_FINAL.totalPaise,
    waitingMinutes: 20,
    cancellationFeePaise: null,
    paymentMethod: null,
    customerRating: 5,
    driverRating: null,
    arrivedLateSeconds: 240,
    createdAtMs: stamp(-7 * DAY + 90),
  }],

  /**
   * One booking belonging to the *other* customer. Cross-account privacy is a
   * rule worth demonstrating, and a second customer with no data proves nothing.
   */
  ['bookings/bk-demo-3', {
    id: 'bk-demo-3',
    reference: 'DRX-4T8MRP',
    customerUid: 'cust-2',
    assignedDriverUid: 'drv-1',
    serviceTypeId: 'chauffeur_own_car',
    zoneId: 'zone-del-1',
    status: 'completed',
    paymentStatus: 'pending',
    pickup: PLACE_CP,
    destination: PLACE_HOME,
    pickupGeofence: { center: PLACE_CP.location, radiusMeters: 120 },
    destinationGeofence: { center: PLACE_HOME.location, radiusMeters: 80 },
    scheduledForMs: null,
    driverEnRouteEta: null,
    arrivalConfirmedAtMs: stamp(-2 * DAY + 10),
    arrivalConfirmedManually: false,
    tripStartedAtMs: stamp(-2 * DAY + 16),
    destinationDetectedAtMs: stamp(-2 * DAY + 70),
    completedAtMs: stamp(-2 * DAY + 72),
    completionConfirmedManually: false,
    estimate: FARE_3_ESTIMATE,
    finalFare: FARE_3_FINAL,
    customerPreferences: { transmission: 'either', carType: 'hatchback', notes: null },
    cancellation: {
      by: null, reasonCode: null, reasonText: null, atMs: null, feePaise: 0, refundEligible: false,
    },
    idempotencyKey: 'seed-demo-3',
    routeGeometryRef: null,
    estimatedDistanceMeters: 21_400,
    estimatedDurationSeconds: 2_700,
    stateVersion: 8,
    supportHold: false,
    createdAtMs: stamp(-2 * DAY),
    updatedAtMs: stamp(-2 * DAY + 72),
  }],
  ['bookings/bk-demo-3/events/ev-trip_started', {
    id: 'ev-trip_started',
    bookingId: 'bk-demo-3',
    type: 'trip_started',
    atMs: stamp(-2 * DAY + 16),
    actor: { uid: 'drv-1', role: 'driver' },
    location: null,
    geofenceKind: 'pickup',
    fromStatus: 'driver_arrived',
    toStatus: 'trip_started',
    payload: { otpChecked: true },
    requestId: 'seed-request-7',
  }],
  ['bookings/bk-demo-3/events/ev-trip_completed', {
    id: 'ev-trip_completed',
    bookingId: 'bk-demo-3',
    type: 'trip_completed',
    atMs: stamp(-2 * DAY + 72),
    actor: { uid: null, role: 'system' },
    location: null,
    geofenceKind: 'destination',
    fromStatus: 'destination_reached',
    toStatus: 'completed',
    payload: { distanceMeters: 20_800 },
    requestId: 'seed-request-8',
  }],
  ['tripSummaries/bk-demo-3', {
    bookingId: 'bk-demo-3',
    customerUid: 'cust-2',
    driverUid: 'drv-1',
    serviceTypeId: 'chauffeur_own_car',
    startedAtMs: stamp(-2 * DAY + 16),
    completedAtMs: stamp(-2 * DAY + 72),
    durationSeconds: 3_360,
    distanceMeters: 20_800,
    distanceSource: 'gps_trace',
    traceRef: 'trip-traces/bk-demo-3/trace.json',
    pickupAddressSummary: 'Connaught Place, New Delhi',
    destinationAddressSummary: 'Sector 56 Main Road, Gurugram',
    finalFarePaise: FARE_3_FINAL.totalPaise,
    waitingMinutes: 12,
    cancellationFeePaise: null,
    paymentMethod: null,
    customerRating: 4,
    driverRating: null,
    arrivedLateSeconds: null,
    createdAtMs: stamp(-2 * DAY + 72),
  }],

  /**
   * A day hire, so the hourly package model has a booking behind it. The fare
   * carries the 8-hour tier price plus both overage lines — 142.3 km against a
   * 60 km allowance, and 11 hours against 8 — which is the part of the pricing
   * the point-to-point bookings never exercise.
   */
  ['bookings/bk-demo-4', {
    id: 'bk-demo-4',
    reference: 'DRX-9HD4W1',
    customerUid: 'cust-1',
    assignedDriverUid: 'drv-1',
    serviceTypeId: 'chauffeur_hourly',
    zoneId: 'zone-ggn-1',
    status: 'completed',
    paymentStatus: 'pending',
    pickup: PLACE_CP,
    destination: PLACE_HOME,
    pickupGeofence: { center: PLACE_CP.location, radiusMeters: 150 },
    destinationGeofence: { center: PLACE_HOME.location, radiusMeters: 150 },
    scheduledForMs: null,
    driverEnRouteEta: null,
    arrivalConfirmedAtMs: stamp(-3 * DAY + 8),
    arrivalConfirmedManually: false,
    tripStartedAtMs: stamp(-3 * DAY + 14),
    destinationDetectedAtMs: stamp(-3 * DAY + 668),
    completedAtMs: stamp(-3 * DAY + 672),
    completionConfirmedManually: false,
    estimate: FARE_HOURLY,
    finalFare: FARE_HOURLY_FINAL,
    customerPreferences: {
      transmission: 'automatic',
      carType: 'suv',
      notes: 'Airport drop, two city errands, then home.',
    },
    cancellation: {
      by: null, reasonCode: null, reasonText: null, atMs: null, feePaise: 0, refundEligible: false,
    },
    idempotencyKey: 'seed-demo-4',
    routeGeometryRef: null,
    estimatedDistanceMeters: 142_300,
    estimatedDurationSeconds: 39_600,
    stateVersion: 9,
    supportHold: false,
    createdAtMs: stamp(-3 * DAY),
    updatedAtMs: stamp(-3 * DAY + 672),
  }],
  ['bookings/bk-demo-4/events/ev-trip_started', {
    id: 'ev-trip_started',
    bookingId: 'bk-demo-4',
    type: 'trip_started',
    atMs: stamp(-3 * DAY + 14),
    actor: { uid: 'drv-1', role: 'driver' },
    location: null,
    geofenceKind: 'pickup',
    fromStatus: 'driver_arrived',
    toStatus: 'trip_started',
    payload: { otpChecked: true },
    requestId: 'seed-request-5',
  }],
  ['bookings/bk-demo-4/events/ev-trip_completed', {
    id: 'ev-trip_completed',
    bookingId: 'bk-demo-4',
    type: 'trip_completed',
    atMs: stamp(-3 * DAY + 672),
    actor: { uid: null, role: 'system' },
    location: null,
    geofenceKind: 'destination',
    fromStatus: 'destination_reached',
    toStatus: 'completed',
    payload: { distanceMeters: 142_300 },
    requestId: 'seed-request-6',
  }],
  ['tripSummaries/bk-demo-4', {
    bookingId: 'bk-demo-4',
    customerUid: 'cust-1',
    driverUid: 'drv-1',
    serviceTypeId: 'chauffeur_hourly',
    startedAtMs: stamp(-3 * DAY + 14),
    completedAtMs: stamp(-3 * DAY + 672),
    durationSeconds: 39_600,
    distanceMeters: 142_300,
    distanceSource: 'gps_trace',
    traceRef: 'trip-traces/bk-demo-4/trace.json',
    pickupAddressSummary: 'Connaught Place, New Delhi',
    destinationAddressSummary: 'Sector 56 Main Road, Gurugram',
    finalFarePaise: FARE_HOURLY_FINAL.totalPaise,
    waitingMinutes: 0,
    cancellationFeePaise: null,
    paymentMethod: null,
    customerRating: 5,
    driverRating: 4,
    arrivedLateSeconds: null,
    createdAtMs: stamp(-3 * DAY + 672),
  }],

  ['supportTickets/tk-demo-1', {
    id: 'tk-demo-1',
    openedByUid: 'cust-1',
    bookingId: 'bk-demo-1',
    forRole: 'customer',
    category: 'fare_dispute',
    subject: 'Route question',
    body: 'Is the NH-48 route included in the estimate?',
    status: 'open',
    priority: 'normal',
    assignedAdminUid: null,
    lastCustomerReplyAtMs: null,
    resolvedAtMs: null,
    resolution: null,
    createdAtMs: stamp(-6),
    updatedAtMs: stamp(-6),
  }],

  ['adminAuditLogs/audit-role-granted', {
    id: 'audit-role-granted',
    actorUid: 'admin-1',
    actorRole: 'admin',
    action: 'role_granted',
    targetType: 'driver',
    targetId: 'drv-1',
    before: { driverVerified: false },
    after: { driverVerified: true },
    reason: 'Driving licence and police verification approved.',
    ipAddress: null,
    atMs: stamp(-60 * DAY),
  }],

  ['appConfig/public', {
    launchCity: 'Gurugram',
    country: 'IN',
    currency: 'INR',
    enabledServiceTypeIds: ['chauffeur_own_car', 'chauffeur_hourly', 'chauffeur_outstation'],
    cabBookingEnabled: false,
    supportPhoneNumber: '+919000000100',
    emergencyPhoneNumber: '+919000000111',
    updatedAtMs: stamp(-1),
  }],
  ['appConfig/dispatch', {
    searchRadiusMetersSteps: [1500, 3000, 6000],
    maxDriverOfferAttempts: 3,
    offerTimeoutSeconds: 25,
    requireVerifiedDriver: true,
    maxAccuracyMetersForArrival: 30,
    sustainedFixesForArrival: 3,
    updatedByUid: 'admin-1',
    updatedAtMs: stamp(-1),
  }],
  // The office's cut of a trip. Seeded at the domain default so the document and
  // the code agree until the owner sets another; `createBooking` reads this and
  // writes the rate onto every booking it takes.
  ['appConfig/commission', {
    rate: COMMISSION_TERMS.rate,
    gstRate: COMMISSION_TERMS.gstRate,
    updatedByUid: 'admin-1',
    updatedAtMs: stamp(-1),
  }],
];

/**
 * `npm run seed:catalogue` writes the configuration only — the service catalogue,
 * the price chart, the office's cut, and the developer sign-ins — and none of the
 * demo trips, receipts, ratings or tickets below.
 *
 * The owner's standing instruction is that he works on real data, and a seeded
 * `bk-demo-*` booking in the ledger is not decoration: it gets dispatched, its
 * fare is counted on the money screens, and a completed one bills a commission no
 * driver earned. The full seed stays available for the rules tests and the
 * screens that need history to point at.
 */
const CATALOGUE_ONLY = process.argv.includes('--catalogue');
const CATALOGUE_PATHS = ['serviceTypes/', 'pricingRules/', 'appConfig/'];
const REFERENCE_DATA = CATALOGUE_ONLY
  ? ALL_REFERENCE_DATA.filter(([path]) => CATALOGUE_PATHS.some((prefix) => path.startsWith(prefix)))
  : ALL_REFERENCE_DATA;

/**
 * The platform's share of every trip this file marks completed.
 *
 * These are the same rows `chargeCommissionOnCompletion` writes when a booking
 * flips to `completed`: the id is `commission_{bookingId}`, and the amount comes
 * from `commissionSnapshotFor` on the booking's own final fare, which is also
 * written onto the booking as its `commission` block. Deriving them from the
 * booking fixtures instead of typing them out means the demo ledger and the live
 * one cannot disagree, and a pricing change moves the seeded dues with the seeded
 * receipts.
 *
 * They are left unpaid deliberately. Rakesh cleared his one-time fee and then
 * drove three trips, which is exactly the state the owner described: a working
 * driver who has to settle commission before the office sends him another
 * booking. What gates him is in the app and on `/dues`.
 *
 * `verify:driver-dues` proves the trigger by completing a fresh booking; this
 * block only fixes the starting state.
 */
for (const [path, body] of [...REFERENCE_DATA]) {
  if (!path.startsWith('bookings/') || body.status !== 'completed') continue;
  const fare = body.finalFare ?? body.estimate;
  if (typeof fare?.subtotalPaise !== 'number' || fare.subtotalPaise <= 0) continue;

  // The booking keeps the terms it was billed at, exactly as `createBooking`
  // writes them, so the demo ledger, the driver's earnings screen and the office
  // read the same numbers instead of three recomputations of a rate.
  const terms = commissionSnapshotFor(fare, COMMISSION_TERMS.rate);
  body.commission = terms;

  const dueId = commissionDueId(body.id);
  REFERENCE_DATA.push([
    `driverProfiles/${body.assignedDriverUid}/dues/${dueId}`,
    {
      id: dueId,
      driverUid: body.assignedDriverUid,
      kind: COMMISSION_TERMS.kind,
      title: commissionTitleFor(body.reference),
      bookingId: body.id,
      currency: 'INR',
      basePaise: terms.basePaise,
      rate: terms.rate,
      commissionablePaise: terms.commissionablePaise,
      gstRate: terms.gstRate,
      gstPaise: terms.gstPaise,
      totalPaise: terms.totalPaise,
      status: 'unpaid',
      method: null,
      reference: null,
      recordedByUid: null,
      createdAtMs: body.completedAtMs,
      updatedAtMs: body.completedAtMs,
    },
  ]);
}

/**
 * Catalogue collections this file is the source of truth for. Bookings, trip
 * summaries, payments and tickets are demo *history* and are never swept.
 */
const SEED_OWNED_COLLECTIONS = ['pricingRules', 'serviceTypes'];

async function main() {
  const [authUp, firestoreUp] = await Promise.all([reachable(AUTH_PORT), reachable(FIRESTORE_PORT)]);
  if (!authUp || !firestoreUp) {
    console.error(
      `Emulator not reachable (auth ${HOST}:${AUTH_PORT} ${authUp ? 'ok' : 'DOWN'}, ` +
        `firestore ${HOST}:${FIRESTORE_PORT} ${firestoreUp ? 'ok' : 'DOWN'}).`,
    );
    console.error(
      'Start it first with `npm run emulators`. The Firebase Emulator Suite needs a JDK; firebase-tools 15 requires Java 21 or newer.',
    );
    process.exit(1);
  }

  console.log(`Seeding project "${PROJECT_ID}" against ${HOST}\n`);

  // Accounts first, so every alias exists before any fixture references one.
  const auth = await createAuthClient();
  const created = [];
  for (const account of ACCOUNTS) {
    const uid = await upsertAccount(auth, account);
    uidAliases[account.alias] = uid;
    const role = account.claims.custom.role;
    await writeDocument(`users/${uid}`, {
      uid,
      phoneNumberE164: account.phoneE164,
      email: account.email,
      displayName: account.claims.displayName,
      role,
      accountStatus: 'active',
      localeTag: 'en-IN',
      timeZone: 'Asia/Kolkata',
      fcmToken: null,
      deletionScheduledAtMs: null,
      createdAtMs: stamp(-100 * DAY),
      lastSignInAtMs: stamp(0),
    });
    created.push({ uid, alias: account.alias, role, email: account.email, name: account.claims.displayName });
  }

  // Driver licences, customer addresses and saved places belong to the demo
  // history, so a catalogue-only run leaves them out and a real account's own
  // profile untouched.
  if (!CATALOGUE_ONLY) {
    for (const account of ACCOUNTS) {
      const uid = uidAliases[account.alias];
      for (const [collection, body] of PROFILE_DOCUMENTS[account.phoneE164] ?? []) {
        await writeDocument(
          `${collection}/${uid}`,
          resolveIds({ uid, ...body, createdAtMs: stamp(-90 * DAY), updatedAtMs: stamp(-1) }),
        );
      }
    }
  }

  for (const [path, body] of REFERENCE_DATA) {
    await writeDocument(resolveAliases(path), resolveIds(body));
  }

  const keptByCollection = Object.fromEntries(
    SEED_OWNED_COLLECTIONS.map((collection) => [
      collection,
      new Set(
        REFERENCE_DATA.map(([path]) => resolveAliases(path))
          .filter((path) => path.startsWith(`${collection}/`))
          .map((path) => path.slice(collection.length + 1)),
      ),
    ]),
  );
  let swept = 0;
  for (const [collection, keepIds] of Object.entries(keptByCollection)) {
    swept += await sweepOwnedCollection(collection, keepIds);
  }

  // The catalogue sweep only reaches top-level collections, and these two
  // drivers' documents are the seed's own fixtures. `dl-1` is the id this file
  // used before the document id became the type; a leftover would put a second
  // licence in the admin's queue that the driver's checklist never shows.
  for (const path of ['driverProfiles/drv-1/documents/dl-1', 'driverProfiles/drv-2/documents/dl-1']) {
    await deleteDocument(resolveAliases(path));
  }

  console.log(
    `Wrote ${created.length} accounts and ${REFERENCE_DATA.length} records` +
      `${CATALOGUE_ONLY ? ' (catalogue only — no demo trips)' : ''}` +
      `${swept ? `, removed ${swept} stale catalogue document${swept === 1 ? '' : 's'}` : ''}.\n`,
  );
  console.log('Developer sign-in (apps/mobile → "Developer sign-in (emulator only)"):');
  console.log(`  ${'role'.padEnd(9)}${'email'.padEnd(24)}${'alias'.padEnd(9)}name`);
  for (const account of created) {
    console.log(`  ${account.role.padEnd(9)}${account.email.padEnd(24)}${account.alias.padEnd(9)}${account.name}`);
  }
  console.log(`\n  password for every seeded account: ${PASSWORD}`);
  console.log('\nRealtime Database is left empty on purpose: driver locations and the');
  console.log('authorization mirror are written by dispatch, which lands in Phase 3.');
  console.log(
    'Cloud Storage holds nothing: upload is live in the driver app, but this seed writes\n' +
      'metadata only, so a seeded document row points at a file that is not there. Opening\n' +
      'one reports that plainly instead of showing a picture.',
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
