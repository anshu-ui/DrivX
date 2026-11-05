import { ref, set as rtdbSet } from 'firebase/database';
import { doc, setDoc } from 'firebase/firestore';
import { ref as storageRef, uploadString } from 'firebase/storage';
import type { RulesTestContext } from '@firebase/rules-unit-testing';
import {
  type DocPath,
  ADMIN_UID,
  BOOKING_ONE,
  BOOKING_TWO,
  BUCKET_URL,
  CUSTOMER_ONE,
  CUSTOMER_TWO,
  DRIVER_ONE,
  DRIVER_TWO,
  OPS_UID,
} from './helpers';

const now = 1_760_000_000_000;

/**
 * Server-side fixtures. Written through the rules-disabled context, which is the
 * same bypass Cloud Functions hold, so the assertions below only ever measure
 * what a client can do.
 *
 * Shapes follow `@drivx/domain` exactly — a `Place` with a `location`, a fare
 * as a `FareBreakdown`, timestamps as `*Ms` — because the mobile app reads these
 * documents field by field. Fixtures that drifted from the model would let the
 * rules suite pass while the screens showed empty values.
 */
export async function seedFirestore(ctx: RulesTestContext): Promise<void> {
  const db = ctx.firestore();
  const put = (path: DocPath, data: Record<string, unknown>) =>
    setDoc(doc(db, ...path), { ...data, createdAtMs: now, updatedAtMs: now });

  const place = (
    label: string,
    addressLine1: string,
    city: string,
    location: { lat: number; lng: number },
  ) => ({
    label,
    addressLine1,
    city,
    state: 'Haryana',
    pincode: '122003',
    location,
    placeId: `place-${label.toLowerCase().replace(/[^a-z0-9]/g, '-')}`,
    source: 'places_autocomplete',
  });

  const gurugram = place('Home', 'Sector 56, Gurugram', 'Gurugram', { lat: 28.45, lng: 77.02 });
  const cp = place('Connaught Place', 'Connaught Place, New Delhi', 'New Delhi', {
    lat: 28.63,
    lng: 77.22,
  });
  const nehru = place('Nehru Place', 'Nehru Place, New Delhi', 'New Delhi', {
    lat: 28.61,
    lng: 77.22,
  });

  /** A server-produced estimate: nothing here is a charged amount. */
  const estimate = (totalPaise: number) => ({
    currency: 'INR',
    items: [
      { key: 'base_fare', label: 'Base fare', amountPaise: 12_000 },
      {
        key: 'distance',
        label: 'Distance',
        amountPaise: totalPaise - 12_000 - 3_000,
        detail: '12.4 km x Rs 18/km',
      },
      { key: 'gst', label: 'GST', amountPaise: 3_000 },
    ],
    subtotalPaise: totalPaise - 3_000,
    taxPaise: 3_000,
    totalPaise,
    pricingRuleId: 'price-base',
    pricingSnapshotHash: 'sha256:estimate',
    generatedAtMs: now,
    expiresAtMs: now + 900_000,
    kind: 'estimate',
  });

  await Promise.all([
    put(['users', CUSTOMER_ONE], { uid: CUSTOMER_ONE, role: 'customer', phoneE164: '+919000000001' }),
    put(['users', DRIVER_ONE], { uid: DRIVER_ONE, role: 'driver', phoneE164: '+919000000011' }),

    put(['customerProfiles', CUSTOMER_ONE], {
      uid: CUSTOMER_ONE,
      fullName: 'Amit',
      email: 'amit@example.test',
      defaultPickup: gurugram,
      preferredTransmission: 'automatic',
      preferredCarTypes: ['sedan'],
      contactPhoneE164: '+919000000001',
      privacy: {
        shareTripWithContact: false,
        marketingOptIn: false,
        preciseLocationWhileIdle: false,
      },
      emergencyContact: { name: null, phoneE164: null, sharesLiveLocation: false },
      ratingAverage: 4.8,
      ratingCount: 12,
      lifetimeBookings: 3,
    }),
    put(['customerProfiles', CUSTOMER_TWO], {
      uid: CUSTOMER_TWO,
      fullName: 'Priya',
      defaultPickup: null,
      preferredTransmission: 'either',
      preferredCarTypes: [],
      contactPhoneE164: '+919000000002',
      privacy: {
        shareTripWithContact: false,
        marketingOptIn: true,
        preciseLocationWhileIdle: false,
      },
      emergencyContact: { name: null, phoneE164: null, sharesLiveLocation: false },
      ratingAverage: 4.5,
      ratingCount: 4,
      lifetimeBookings: 1,
    }),

    put(['driverProfiles', DRIVER_ONE], {
      uid: DRIVER_ONE,
      fullName: 'Rakesh',
      verificationStatus: 'approved',
      verifiedAtMs: now,
      verifiedByUid: ADMIN_UID,
      driverId: 'DRV-K7M2XQ',
      availabilityState: 'online',
      ratingAverage: 4.9,
      ratingCount: 80,
      lifetimeTrips: 120,
      onTimeArrivalRate: 0.94,
      acceptanceRate: 0.88,
      documentsExpiringBeforeMs: now + 90 * 86_400_000,
    }),
    put(['driverProfiles', DRIVER_TWO], {
      uid: DRIVER_TWO,
      fullName: 'Suna',
      verificationStatus: 'pending_review',
      verifiedAtMs: null,
      verifiedByUid: null,
      driverId: null,
      availabilityState: 'offline',
      ratingAverage: 0,
      ratingCount: 0,
      lifetimeTrips: 0,
      onTimeArrivalRate: 0,
      acceptanceRate: 0,
      documentsExpiringBeforeMs: null,
    }),
    // An approved driver has already cleared the one-time fee; a pending one has
    // not, which is the state the admin gate is written for.
    put(['driverProfiles', DRIVER_ONE, 'dues', 'onboarding_fee'], {
      driverUid: DRIVER_ONE,
      kind: 'onboarding_fee',
      title: 'One-time onboarding fee',
      currency: 'INR',
      basePaise: 1_000,
      gstRate: 0,
      gstPaise: 0,
      totalPaise: 1_000,
      status: 'paid',
      method: 'cash',
      reference: 'receipt-118',
      recordedByUid: ADMIN_UID,
      createdAtMs: now,
    }),
    put(['driverProfiles', DRIVER_TWO, 'dues', 'onboarding_fee'], {
      driverUid: DRIVER_TWO,
      kind: 'onboarding_fee',
      title: 'One-time onboarding fee',
      currency: 'INR',
      basePaise: 1_000,
      gstRate: 0,
      gstPaise: 0,
      totalPaise: 1_000,
      status: 'unpaid',
      method: null,
      reference: null,
      recordedByUid: null,
      createdAtMs: now,
    }),
    // The platform's share of the trip this driver finished: the office's 13% of
    // BOOKING_TWO's ₹305.00 pre-GST fare plus 5% GST on it. Id is
    // `commission_{bookingId}`, the same the completion trigger mints, so one trip
    // can never be billed twice.
    put(['driverProfiles', DRIVER_TWO, 'dues', `commission_${BOOKING_TWO}`], {
      driverUid: DRIVER_TWO,
      kind: 'commission',
      title: 'Commission on trip DRX-7K3QD3',
      bookingId: BOOKING_TWO,
      currency: 'INR',
      basePaise: 3_965,
      gstRate: 0.05,
      gstPaise: 198,
      totalPaise: 4_163,
      status: 'unpaid',
      method: null,
      reference: null,
      recordedByUid: null,
      createdAtMs: now,
    }),
    put(['driverProfiles', DRIVER_ONE, 'documents', 'doc-1'], {
      driverUid: DRIVER_ONE,
      type: 'driving_licence',
      status: 'rejected',
      storagePath: `drivers/${DRIVER_ONE}/doc-1`,
      reviewedByUid: ADMIN_UID,
      reviewedAtMs: now,
    }),

    put(['bookings', BOOKING_ONE], {
      id: BOOKING_ONE,
      reference: 'DRX-7K3QD2',
      customerUid: CUSTOMER_ONE,
      assignedDriverUid: DRIVER_ONE,
      serviceTypeId: 'svc-home',
      zoneId: 'zone-ggn-1',
      status: 'in_progress',
      paymentStatus: 'pending',
      pickup: gurugram,
      destination: cp,
      pickupGeofence: { center: gurugram.location, radiusMeters: 150 },
      destinationGeofence: { center: cp.location, radiusMeters: 200 },
      scheduledForMs: now,
      tripStartedAtMs: now,
      driverEnRouteEta: {
        minutes: 6,
        calculatedAtMs: now,
        distanceMeters: 2_100,
        source: 'google_routes',
        trafficAware: true,
      },
      estimate: estimate(45_000),
      finalFare: null,
      customerPreferences: { transmission: 'automatic', carType: 'sedan', notes: null },
      cancellation: {
        by: null,
        reasonCode: null,
        reasonText: null,
        atMs: null,
        feePaise: 0,
        refundEligible: false,
      },
      idempotencyKey: 'req-cust1-1',
      estimatedDistanceMeters: 14_200,
      estimatedDurationSeconds: 2_400,
      stateVersion: 4,
    }),
    put(['bookings', BOOKING_TWO], {
      id: BOOKING_TWO,
      reference: 'DRX-7K3QD3',
      customerUid: CUSTOMER_TWO,
      assignedDriverUid: DRIVER_TWO,
      serviceTypeId: 'svc-home',
      zoneId: 'zone-ggn-1',
      status: 'completed',
      paymentStatus: 'captured',
      pickup: nehru,
      destination: cp,
      pickupGeofence: { center: nehru.location, radiusMeters: 150 },
      destinationGeofence: { center: cp.location, radiusMeters: 200 },
      scheduledForMs: now - 86_400_000,
      tripStartedAtMs: now - 86_400_000,
      completedAtMs: now - 82_800_000,
      driverEnRouteEta: null,
      estimate: estimate(32_000),
      finalFare: { ...estimate(33_500), kind: 'final', expiresAtMs: null },
      customerPreferences: { transmission: 'either', carType: 'either', notes: null },
      cancellation: {
        by: null,
        reasonCode: null,
        reasonText: null,
        atMs: null,
        feePaise: 0,
        refundEligible: false,
      },
      idempotencyKey: 'req-cust2-1',
      estimatedDistanceMeters: 9_800,
      estimatedDurationSeconds: 1_900,
      stateVersion: 7,
    }),
    put(['bookings', BOOKING_ONE, 'events', 'ev-1'], {
      id: 'ev-1',
      bookingId: BOOKING_ONE,
      type: 'trip_started',
      atMs: now,
      actor: { uid: DRIVER_ONE, role: 'driver' },
      location: null,
      geofenceKind: 'pickup',
      fromStatus: 'driver_arrived',
      toStatus: 'trip_started',
    }),
    put(['bookings', BOOKING_ONE, 'events', 'ev-2'], {
      id: 'ev-2',
      bookingId: BOOKING_ONE,
      type: 'driver_assigned',
      atMs: now - 300_000,
      actor: { uid: null, role: 'system' },
      location: null,
      geofenceKind: null,
      fromStatus: 'searching_driver',
      toStatus: 'assigned',
    }),
    put(['bookings', BOOKING_ONE, 'assignments', 'as-1'], {
      bookingId: BOOKING_ONE,
      driverUid: DRIVER_ONE,
      state: 'accepted',
      offeredAtMs: now,
    }),
    put(['bookings', BOOKING_TWO, 'assignments', 'as-2'], {
      bookingId: BOOKING_TWO,
      driverUid: DRIVER_TWO,
      state: 'accepted',
      offeredAtMs: now,
    }),

    put(['tripSummaries', BOOKING_ONE], {
      bookingId: BOOKING_ONE,
      customerUid: CUSTOMER_ONE,
      driverUid: DRIVER_ONE,
      serviceTypeId: 'svc-home',
      startedAtMs: now,
      completedAtMs: null,
      durationSeconds: null,
      distanceMeters: 14_200,
      distanceSource: 'google_routes_actual',
      traceRef: `trip-traces/${BOOKING_ONE}/trace.json`,
      pickupAddressSummary: gurugram.label,
      destinationAddressSummary: cp.label,
      finalFarePaise: 46_500,
      waitingMinutes: 0,
      cancellationFeePaise: null,
      paymentMethod: 'upi',
      customerRating: null,
      driverRating: null,
      arrivedLateSeconds: null,
    }),
    put(['tripSummaries', BOOKING_TWO], {
      bookingId: BOOKING_TWO,
      customerUid: CUSTOMER_TWO,
      driverUid: DRIVER_TWO,
      serviceTypeId: 'svc-home',
      startedAtMs: now - 86_400_000,
      completedAtMs: now - 82_800_000,
      durationSeconds: 3_600,
      distanceMeters: 9_800,
      distanceSource: 'gps_trace',
      traceRef: `trip-traces/${BOOKING_TWO}/trace.json`,
      pickupAddressSummary: nehru.label,
      destinationAddressSummary: cp.label,
      finalFarePaise: 32_000,
      waitingMinutes: 4,
      cancellationFeePaise: null,
      paymentMethod: 'card',
      customerRating: 5,
      driverRating: 5,
      arrivedLateSeconds: 90,
    }),

    put(['serviceTypes', 'svc-home'], { enabled: true, name: 'Self-car chauffeur', requiresCabLicence: false }),
    put(['serviceTypes', 'svc-cab'], { enabled: false, name: 'Cab', requiresCabLicence: true }),

    put(['pricingRules', 'price-base'], {
      zoneId: 'zone-ggn-1',
      serviceTypeId: 'svc-home',
      basePaise: 12_000,
      perKmPaise: 1_600,
      enabled: true,
    }),

    put(['payments', 'pay-1'], {
      customerUid: CUSTOMER_ONE,
      bookingId: BOOKING_ONE,
      amountPaise: 46_500,
      status: 'created',
      provider: null,
    }),
    put(['payments', 'pay-2'], {
      customerUid: CUSTOMER_TWO,
      bookingId: BOOKING_TWO,
      amountPaise: 32_000,
      status: 'succeeded',
      provider: 'cashfree',
    }),
    put(['refunds', 'ref-1'], { bookingId: BOOKING_ONE, amountPaise: 5_000, status: 'requested' }),
    put(['ratings', 'rate-1'], {
      id: 'rate-1',
      bookingId: BOOKING_ONE,
      bookingReference: 'DRX-7K3QD2',
      raterUid: CUSTOMER_ONE,
      ratedUid: DRIVER_ONE,
      direction: 'customer_to_driver',
      score: 5,
      tags: ['knew_the_route'],
      comment: 'Reached early.',
    }),

    put(['savedPlaces', CUSTOMER_ONE, 'places', 'home'], {
      id: 'home',
      uid: CUSTOMER_ONE,
      label: 'home',
      name: 'Home',
      place: gurugram,
    }),
    put(['savedPlaces', CUSTOMER_TWO, 'places', 'work'], {
      id: 'work',
      uid: CUSTOMER_TWO,
      label: 'work',
      name: 'Office',
      place: nehru,
    }),

    put(['users', CUSTOMER_ONE, 'notifications', 'n-1'], {
      id: 'n-1',
      uid: CUSTOMER_ONE,
      type: 'driver_arrived',
      title: 'Driver arrived',
      body: 'Rakesh has reached the pickup point.',
      bookingId: BOOKING_ONE,
      readAtMs: null,
      expiresAtMs: now + 86_400_000,
    }),

    put(['supportTickets', 'tk-1'], {
      id: 'tk-1',
      openedByUid: CUSTOMER_ONE,
      forRole: 'customer',
      bookingId: BOOKING_ONE,
      category: 'trip_issue',
      subject: 'Route question',
      body: 'The driver took a longer route.',
      status: 'open',
      priority: 'normal',
      assignedAdminUid: null,
      lastCustomerReplyAtMs: null,
      resolvedAtMs: null,
      resolution: null,
    }),
    put(['supportTickets', 'tk-2'], {
      id: 'tk-2',
      openedByUid: CUSTOMER_TWO,
      forRole: 'customer',
      bookingId: BOOKING_TWO,
      category: 'fare_dispute',
      subject: 'Waiting charge',
      body: 'I was not waiting that long.',
      status: 'closed',
      priority: 'high',
      assignedAdminUid: ADMIN_UID,
      lastCustomerReplyAtMs: null,
      resolvedAtMs: now,
      resolution: 'Waiting minutes re-checked against the GPS trace.',
    }),

    put(['adminAuditLogs', 'log-1'], { actorUid: ADMIN_UID, action: 'setRole', targetUid: DRIVER_ONE }),

    put(['otpCodes', 'otp-1'], { purpose: 'trip_start', codeHash: 'sha256:deadbeef', expiresAtMs: now + 600_000 }),

    put(['appConfig', 'public'], { launchCity: 'Gurugram', enabledServiceTypeIds: ['svc-home'] }),
    put(['appConfig', 'internal'], { dispatchRadiusMeters: 4000 }),
  ]);
}

/** Realtime Database fixtures: the authorization mirror plus live location. */
export async function seedDatabase(ctx: RulesTestContext): Promise<void> {
  const db = ctx.database();
  const trackingOn = {
    bookingId: BOOKING_ONE,
    customerUid: CUSTOMER_ONE,
    driverUid: DRIVER_ONE,
    trackingEnabled: true,
    sharedWith: { [OPS_UID]: true },
  };
  const trackingOff = {
    bookingId: BOOKING_TWO,
    customerUid: CUSTOMER_TWO,
    driverUid: DRIVER_TWO,
    trackingEnabled: false,
    sharedWith: {},
  };

  await Promise.all([
    rtdbSet(ref(db, `authz/${BOOKING_ONE}`), trackingOn),
    rtdbSet(ref(db, `authz/${BOOKING_TWO}`), trackingOff),
    rtdbSet(ref(db, `driverLocations/${DRIVER_ONE}`), {
      bookingId: BOOKING_ONE,
      lat: 28.4512,
      lng: 77.0211,
      accuracyMeters: 9,
      fixTimeMs: Date.now(),
      receivedAtMs: Date.now(),
    }),
    rtdbSet(ref(db, `driverLocations/${DRIVER_TWO}`), {
      bookingId: BOOKING_TWO,
      lat: 28.6101,
      lng: 77.2101,
      accuracyMeters: 12,
      fixTimeMs: Date.now(),
      receivedAtMs: Date.now(),
    }),
    rtdbSet(ref(db, `activeBookings/${BOOKING_ONE}`), {
      bookingId: BOOKING_ONE,
      driverUid: DRIVER_ONE,
      status: 'in_progress',
      expiresAtMs: Date.now() + 3_600_000,
    }),
    rtdbSet(ref(db, `activeBookings/${BOOKING_TWO}`), {
      bookingId: BOOKING_TWO,
      driverUid: DRIVER_TWO,
      status: 'completed',
      expiresAtMs: Date.now() - 60_000,
    }),
    rtdbSet(ref(db, `presence/${DRIVER_ONE}`), { state: 'on_trip', updatedAtMs: Date.now() }),
    rtdbSet(ref(db, `dispatchGrid/zone-ggn-1/${DRIVER_ONE}`), { lat: 28.45, lng: 77.02 }),
  ]);
}

/** Private driver paperwork, a public avatar and a retained GPS trace. */
export async function seedStorage(ctx: RulesTestContext): Promise<void> {
  const storage = ctx.storage(BUCKET_URL);
  const upload = (path: string, contentType: string) =>
    uploadString(storageRef(storage, path), 'ZmFrZS1ieXRlcy1mb3ItcmVhdGluZw==', 'base64', { contentType });

  await Promise.all([
    upload(`drivers/${DRIVER_ONE}/doc-1`, 'application/pdf'),
    upload(`avatars/${DRIVER_ONE}/photo.png`, 'image/png'),
    upload(`trip-traces/${BOOKING_ONE}/trace.json`, 'application/json'),
  ]);
}

