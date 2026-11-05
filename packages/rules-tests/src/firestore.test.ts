import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  collection,
  collectionGroup,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import type { RulesTestContext, RulesTestEnvironment } from '@firebase/rules-unit-testing';
import {
  type DocPath,
  ADMIN_UID,
  BOOKING_ONE,
  BOOKING_TWO,
  CUSTOMER_ONE,
  CUSTOMER_TWO,
  DRIVER_ONE,
  DRIVER_TWO,
  OPS_UID,
  createTestEnvironment,
  ctxFor,
  expectAllowed,
  expectDenied,
  purgeRunData,
  seedViaServer,
  runId,
} from './helpers';
import { seedFirestore } from './seed';

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await createTestEnvironment();
  await seedViaServer(env, seedFirestore);
});

afterAll(async () => {
  // beforeAll throws when the emulator is absent, leaving env unset.
  if (!env) return;
  // Left behind, fixtures from earlier runs pile up until a list query reads rows
  // this suite never wrote.
  await purgeRunData();
  await env.cleanup();
});

describe('bookings', () => {
  it('lets the booking customer read their own booking', async () => {
    const ctx = ctxFor(env, CUSTOMER_ONE, 'customer');
    const snap = await expectAllowed(getDoc(doc(ctx.firestore(), 'bookings', BOOKING_ONE)));
    expect(snap.exists()).toBe(true);
    expect(snap.data()?.status).toBe('in_progress');
  });

  it('lets the assigned driver read the same booking', async () => {
    const ctx = ctxFor(env, DRIVER_ONE, 'driver');
    const snap = await expectAllowed(getDoc(doc(ctx.firestore(), 'bookings', BOOKING_ONE)));
    expect(snap.data()?.customerUid).toBe(CUSTOMER_ONE);
  });

  it('denies an unrelated customer reading someone else’s booking', async () => {
    const ctx = ctxFor(env, CUSTOMER_TWO, 'customer');
    await expectDenied(getDoc(doc(ctx.firestore(), 'bookings', BOOKING_ONE)));
  });

  it('denies a driver who is not assigned to the booking', async () => {
    const ctx = ctxFor(env, DRIVER_TWO, 'driver');
    await expectDenied(getDoc(doc(ctx.firestore(), 'bookings', BOOKING_ONE)));
  });

  it('denies an anonymous reader', async () => {
    const ctx = env.unauthenticatedContext();
    await expectDenied(getDoc(doc(ctx.firestore(), 'bookings', BOOKING_ONE)));
  });

  it('refuses every client write path, because transitions live in Cloud Functions', async () => {
    const ctx = ctxFor(env, CUSTOMER_ONE, 'customer');
    const db = ctx.firestore();
    await expectDenied(setDoc(doc(db, 'bookings', 'bk-new'), {
      customerUid: CUSTOMER_ONE,
      assignedDriverUid: DRIVER_ONE,
      status: 'requested',
      estimate: { currency: 'INR', totalPaise: 1 },
    }));
    await expectDenied(updateDoc(doc(db, 'bookings', BOOKING_ONE), { status: 'completed' }));
    await expectDenied(updateDoc(doc(db, 'bookings', BOOKING_ONE), { 'estimate.totalPaise': 100 }));
    await expectDenied(setDoc(doc(db, 'bookings', BOOKING_ONE), { customerUid: CUSTOMER_ONE }));
  });

  it('refuses a driver cancelling the trip they are on', async () => {
    // The state machine gives a driver no edge to `cancelled`, and the rules give
    // them no write at all, so a cancellation can only arrive through the
    // customer's own callable. This is the second half of that guarantee: nothing
    // a client can do to the document reaches the same result.
    const ctx = ctxFor(env, DRIVER_ONE, 'driver');
    await expectDenied(
      updateDoc(doc(ctx.firestore(), 'bookings', BOOKING_ONE), {
        status: 'cancelled',
        cancellation: {
          by: 'driver',
          reasonCode: 'unavailable',
          reasonText: null,
          atMs: new Date(),
          feePaise: 0,
          refundEligible: false,
        },
      }),
    );
  });

  it('lets a customer list only their own bookings', async () => {
    const ctx = ctxFor(env, CUSTOMER_ONE, 'customer');
    const rows = await expectAllowed(
      getDocs(query(collection(ctx.firestore(), 'bookings'), where('customerUid', '==', CUSTOMER_ONE), limit(50))),
    );
    expect(rows.docs.map((row) => row.id)).toEqual([BOOKING_ONE]);
  });

  it('refuses to list another customer’s bookings', async () => {
    const ctx = ctxFor(env, CUSTOMER_ONE, 'customer');
    await expectDenied(
      getDocs(query(collection(ctx.firestore(), 'bookings'), where('customerUid', '==', CUSTOMER_TWO), limit(50))),
    );
  });

  it('lets operations staff list the whole board', async () => {
    const ctx = ctxFor(env, OPS_UID, 'ops');
    const rows = await expectAllowed(getDocs(query(collection(ctx.firestore(), 'bookings'), limit(50))));
    const ids = rows.docs.map((row) => row.id);
    // The security property is an unfiltered read, not a row count: staff see
    // every booking, including ones this suite did not write.
    expect(ids).toEqual(expect.arrayContaining([BOOKING_ONE, BOOKING_TWO]));
  });
});

describe('trip events', () => {
  const eventPath: DocPath = ['bookings', BOOKING_ONE, 'events', 'ev-1'];

  it('is readable by both participants', async () => {
    for (const [uid, role] of [
      [CUSTOMER_ONE, 'customer'],
      [DRIVER_ONE, 'driver'],
    ] as const) {
      const ctx = ctxFor(env, uid, role);
      const snap = await expectAllowed(getDoc(doc(ctx.firestore(), ...eventPath)));
      expect(snap.data()?.type).toBe('trip_started');
    }
  });

  it('is invisible to a stranger', async () => {
    const ctx = ctxFor(env, CUSTOMER_TWO, 'customer');
    await expectDenied(getDoc(doc(ctx.firestore(), ...eventPath)));
  });

  it('is append-only for clients: no create, no edit, no delete', async () => {
    const ctx = ctxFor(env, CUSTOMER_ONE, 'customer');
    const db = ctx.firestore();
    await expectDenied(setDoc(doc(db, ...eventPath), { type: 'trip_started', atMs: 1 }));
    await expectDenied(updateDoc(doc(db, ...eventPath), { type: 'booking_cancelled' }));
    await expectDenied(setDoc(doc(db, ...eventPath), { type: 'trip_completed' }, { merge: true }));
  });
});

describe('driver assignments', () => {
  it('shows an offer only to the offered driver and to staff', async () => {
    const offered = ctxFor(env, DRIVER_ONE, 'driver');
    expect(
      (await expectAllowed(getDoc(doc(offered.firestore(), 'bookings', BOOKING_ONE, 'assignments', 'as-1'))))
        .exists(),
    ).toBe(true);

    const stranger = ctxFor(env, CUSTOMER_ONE, 'customer');
    await expectDenied(getDoc(doc(stranger.firestore(), 'bookings', BOOKING_ONE, 'assignments', 'as-1')));
  });

  it('refuses client writes to assignments', async () => {
    const ctx = ctxFor(env, DRIVER_ONE, 'driver');
    await expectDenied(
      updateDoc(doc(ctx.firestore(), 'bookings', BOOKING_ONE, 'assignments', 'as-1'), { state: 'accepted' }),
    );
  });
});

describe('profiles', () => {
  it('lets a customer open their own profile and nobody else’s', async () => {
    const own = ctxFor(env, CUSTOMER_ONE, 'customer');
    expect((await expectAllowed(getDoc(doc(own.firestore(), 'customerProfiles', CUSTOMER_ONE)))).exists()).toBe(true);

    const other = ctxFor(env, CUSTOMER_TWO, 'customer');
    await expectDenied(getDoc(doc(other.firestore(), 'customerProfiles', CUSTOMER_ONE)));
  });

  it('lets a customer edit contact details but not server-owned aggregates', async () => {
    const ctx = ctxFor(env, CUSTOMER_ONE, 'customer');
    const db = ctx.firestore();
    await expectAllowed(updateDoc(doc(db, 'customerProfiles', CUSTOMER_ONE), { fullName: 'Amit C' }));
    await expectDenied(updateDoc(doc(db, 'customerProfiles', CUSTOMER_ONE), { ratingAverage: 5 }));
    await expectDenied(updateDoc(doc(db, 'customerProfiles', CUSTOMER_ONE), { lifetimeBookings: 99 }));
    await expectDenied(updateDoc(doc(db, 'customerProfiles', CUSTOMER_ONE), { createdAtMs: 1 }));
  });

  it('refuses a customer creating a driver profile, or approving themselves', async () => {
    const asCustomer = ctxFor(env, CUSTOMER_ONE, 'customer');
    const fresh = runId('drv-3');
    await expectDenied(
      setDoc(doc(asCustomer.firestore(), 'driverProfiles', fresh), {
        uid: fresh,
        verificationStatus: 'not_started',
        availabilityState: 'offline',
        ratingCount: 0,
      }),
    );

    const driver = ctxFor(env, DRIVER_TWO, 'driver');
    await expectDenied(
      setDoc(doc(driver.firestore(), 'driverProfiles', fresh), {
        uid: fresh,
        verificationStatus: 'approved',
        availabilityState: 'offline',
        ratingCount: 0,
      }),
    );
    await expectDenied(
      setDoc(doc(driver.firestore(), 'driverProfiles', fresh), {
        uid: fresh,
        verificationStatus: 'not_started',
        availabilityState: 'online',
        ratingCount: 0,
      }),
    );
  });

  it('lets a driver open a profile that starts unverified and offline', async () => {
    // A brand-new driver opening their own row: the uid in the path has to be the
    // caller's, otherwise this is just another escalation case.
    const fresh = runId('drv-3');
    const driver = ctxFor(env, fresh, 'driver');
    await expectAllowed(
      setDoc(doc(driver.firestore(), 'driverProfiles', fresh), {
        uid: fresh,
        verificationStatus: 'not_started',
        availabilityState: 'offline',
        ratingCount: 0,
      }),
    );
  });

  it('lets one number hold both accounts, each reaching its own profile', async () => {
    // The owner's rule: a person may book a car and drive a car on the same
    // phone number. Checking the single `role` claim instead of `roles` is what
    // would strand them in one half of their own data, so both writes below have
    // to pass for the same caller, and the driver-side guards still apply.
    const uid = runId('dual-1');
    const ctx = ctxFor(env, uid, 'dual');
    const db = ctx.firestore();

    await expectAllowed(
      setDoc(doc(db, 'customerProfiles', uid), { uid, fullName: 'Amit C', lifetimeBookings: 0 }),
    );
    await expectAllowed(
      setDoc(doc(db, 'driverProfiles', uid), {
        uid,
        verificationStatus: 'not_started',
        availabilityState: 'offline',
        ratingCount: 0,
      }),
    );
    await expectAllowed(updateDoc(doc(db, 'customerProfiles', uid), { preferredTransmission: 'manual' }));
    await expectDenied(updateDoc(doc(db, 'driverProfiles', uid), { availabilityState: 'break' }));
    await expectDenied(updateDoc(doc(db, 'driverProfiles', uid), { verificationStatus: 'approved' }));
  });

  it('blocks a driver from self-approving, self-rating or claiming an assignment', async () => {
    // drv-2 is the pending driver: every field below is a real change, so a
    // no-op write could not slip through the diff-based guards.
    const ctx = ctxFor(env, DRIVER_TWO, 'driver');
    const db = ctx.firestore();
    await expectDenied(updateDoc(doc(db, 'driverProfiles', DRIVER_TWO), { verificationStatus: 'approved' }));
    await expectDenied(updateDoc(doc(db, 'driverProfiles', DRIVER_TWO), { verifiedByUid: DRIVER_TWO }));
    await expectDenied(updateDoc(doc(db, 'driverProfiles', DRIVER_TWO), { ratingCount: 500 }));
    await expectDenied(updateDoc(doc(db, 'driverProfiles', DRIVER_TWO), { availabilityState: 'on_assignment' }));
    await expectDenied(updateDoc(doc(db, 'driverProfiles', DRIVER_TWO), { availabilityState: 'on_trip' }));
  });

  it('keeps the duty agreement and the queue server-owned', async () => {
    // The owner's gate: "term agree karne ke baad hi uske paas vo booking aaegi".
    // It only holds if an acceptance is something the server witnessed, so the
    // field is closed to the driver and `acceptDutyTerms` writes it. Availability
    // is on the same list because `setAvailability` gates it on approval, terms
    // and dues — and because `availabilitySinceMs` *is* the waiting order, so a
    // driver who could type an old timestamp would own the front of the queue.
    const ctx = ctxFor(env, DRIVER_ONE, 'driver');
    const db = ctx.firestore();
    await expectDenied(updateDoc(doc(db, 'driverProfiles', DRIVER_ONE), { dutyTermsVersion: 'drivx-duty-v1' }));
    await expectDenied(
      updateDoc(doc(db, 'driverProfiles', DRIVER_ONE), {
        dutyTermsVersion: 'drivx-duty-v1',
        dutyTermsAcceptedAtMs: 1,
      }),
    );
    await expectDenied(updateDoc(doc(db, 'driverProfiles', DRIVER_ONE), { availabilityState: 'online' }));
    await expectDenied(updateDoc(doc(db, 'driverProfiles', DRIVER_ONE), { availabilityState: 'break' }));
    await expectDenied(updateDoc(doc(db, 'driverProfiles', DRIVER_ONE), { availabilitySinceMs: 1000 }));
    // Reading their own row is untouched — the Duty screen shows the state the
    // server left there.
    await expectAllowed(getDoc(doc(db, 'driverProfiles', DRIVER_ONE)));
  });

  it('lets a driver edit the Account fields and nothing server-owned', async () => {
    // The driver Account screen writes exactly these five fields. The car is the
    // driver's to describe whenever the office has not recorded it, and the
    // languages they speak are always theirs.
    const ctx = ctxFor(env, DRIVER_ONE, 'driver');
    const db = ctx.firestore();
    await expectAllowed(
      updateDoc(doc(db, 'driverProfiles', DRIVER_ONE), {
        fullName: 'Rakesh Yadav',
        vehicleMake: 'Maruti Swift',
        vehicleModel: 'ZXI',
        vehiclePlate: 'HR 26 AB 1234',
        languages: ['hi', 'en'],
      }),
    );
    // A self-stamped updatedAtMs is how a client forges the audit trail of its
    // own edit, so the diff guard refuses it even beside an honest change.
    await expectDenied(
      updateDoc(doc(db, 'driverProfiles', DRIVER_ONE), { fullName: 'Rakesh Y.', updatedAtMs: 1 }),
    );
    // Pointing driverId at another driver would redirect the dispatcher, the
    // customer's driver card and the dues ledger.
    await expectDenied(
      updateDoc(doc(db, 'driverProfiles', DRIVER_ONE), { vehiclePlate: 'DL 01 CF 0000', driverId: 'DRV-HACKED' }),
    );
  });

  it('deletes profiles only for administrators', async () => {
    await seedViaServer(env, async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'customerProfiles', 'cust-9'), { uid: 'cust-9', fullName: 'Ghost' });
    });

    const customer = ctxFor(env, CUSTOMER_ONE, 'customer');
    // Account deletion is an audited, function-driven flow, so not even the
    // owner has a client-side delete path.
    await expectDenied(deleteDoc(doc(customer.firestore(), 'customerProfiles', CUSTOMER_ONE)));
    await expectDenied(deleteDoc(doc(customer.firestore(), 'customerProfiles', 'cust-9')));

    const admin = ctxFor(env, ADMIN_UID, 'admin');
    await expectAllowed(deleteDoc(doc(admin.firestore(), 'customerProfiles', 'cust-9')));
  });
});

describe('driver documents', () => {
  it('accepts an upload pointer only on the driver’s own private path', async () => {
    const ctx = ctxFor(env, DRIVER_ONE, 'driver');
    await expectAllowed(
      setDoc(doc(ctx.firestore(), 'driverProfiles', DRIVER_ONE, 'documents', 'doc-9'), {
        driverUid: DRIVER_ONE,
        type: 'driving_licence',
        status: 'pending_review',
        reviewedByUid: null,
        storagePath: `drivers/${DRIVER_ONE}/doc-9`,
      }),
    );
  });

  it('rejects a forged path, a stranger’s driver id, and a self-granted approval', async () => {
    const ctx = ctxFor(env, DRIVER_ONE, 'driver');
    const db = ctx.firestore();
    await expectDenied(
      setDoc(doc(db, 'driverProfiles', DRIVER_ONE, 'documents', 'doc-8'), {
        driverUid: DRIVER_ONE,
        status: 'pending_review',
        reviewedByUid: null,
        storagePath: `drivers/${DRIVER_TWO}/doc-8`,
      }),
    );
    await expectDenied(
      setDoc(doc(db, 'driverProfiles', DRIVER_ONE, 'documents', 'doc-7'), {
        driverUid: DRIVER_TWO,
        status: 'pending_review',
        reviewedByUid: null,
        storagePath: `drivers/${DRIVER_TWO}/doc-7`,
      }),
    );
    await expectDenied(
      setDoc(doc(db, 'driverProfiles', DRIVER_ONE, 'documents', 'doc-6'), {
        driverUid: DRIVER_ONE,
        status: 'approved',
        reviewedByUid: null,
        storagePath: `drivers/${DRIVER_ONE}/doc-6`,
      }),
    );
  });

  it('keeps review outcomes out of the driver’s hands', async () => {
    const ctx = ctxFor(env, DRIVER_ONE, 'driver');
    await expectDenied(
      updateDoc(doc(ctx.firestore(), 'driverProfiles', DRIVER_ONE, 'documents', 'doc-1'), {
        status: 'approved',
      }),
    );
    await expectDenied(
      updateDoc(doc(ctx.firestore(), 'driverProfiles', DRIVER_ONE, 'documents', 'doc-1'), {
        reviewedByUid: DRIVER_ONE,
      }),
    );
  });

  it('lets a rejected document be resubmitted for review', async () => {
    const ctx = ctxFor(env, DRIVER_ONE, 'driver');
    await expectAllowed(
      updateDoc(doc(ctx.firestore(), 'driverProfiles', DRIVER_ONE, 'documents', 'doc-1'), {
        status: 'pending_review',
      }),
    );
  });

  it('keeps documents private to the owner and to staff', async () => {
    const other = ctxFor(env, DRIVER_TWO, 'driver');
    await expectDenied(getDoc(doc(other.firestore(), 'driverProfiles', DRIVER_ONE, 'documents', 'doc-1')));

    const ops = ctxFor(env, OPS_UID, 'ops');
    expect(
      (await expectAllowed(getDoc(doc(ops.firestore(), 'driverProfiles', DRIVER_ONE, 'documents', 'doc-1')))).exists(),
    ).toBe(true);
  });
});

describe('driver dues', () => {
  it('shows a driver their own bill and nobody else’s', async () => {
    const owing = ctxFor(env, DRIVER_TWO, 'driver');
    const own = await expectAllowed(
      getDoc(doc(owing.firestore(), 'driverProfiles', DRIVER_TWO, 'dues', 'onboarding_fee')),
    );
    // The number the app quotes has to be the number on the record, so the test
    // reads it back rather than trusting the fixture.
    expect(own.exists()).toBe(true);
    expect(own.data()?.totalPaise).toBe(1_000);
    expect(own.data()?.status).toBe('unpaid');

    const cleared = ctxFor(env, DRIVER_ONE, 'driver');
    await expectDenied(getDoc(doc(cleared.firestore(), 'driverProfiles', DRIVER_TWO, 'dues', 'onboarding_fee')));

    const customer = ctxFor(env, CUSTOMER_ONE, 'customer');
    await expectDenied(getDoc(doc(customer.firestore(), 'driverProfiles', DRIVER_TWO, 'dues', 'onboarding_fee')));
  });

  it('lets staff see who has not paid', async () => {
    const admin = ctxFor(env, ADMIN_UID, 'admin');
    expect(
      (await expectAllowed(getDoc(doc(admin.firestore(), 'driverProfiles', DRIVER_TWO, 'dues', 'onboarding_fee')))).exists(),
    ).toBe(true);
  });

  it('refuses every client write, including a driver clearing their own fee', async () => {
    const owing = ctxFor(env, DRIVER_TWO, 'driver');
    const db = owing.firestore();
    await expectDenied(
      updateDoc(doc(db, 'driverProfiles', DRIVER_TWO, 'dues', 'onboarding_fee'), { status: 'paid' }),
    );
    await expectDenied(
      setDoc(doc(db, 'driverProfiles', DRIVER_TWO, 'dues', 'onboarding_fee'), {
        status: 'paid',
        totalPaise: 0,
        driverUid: DRIVER_TWO,
      }),
    );
    await expectDenied(deleteDoc(doc(db, 'driverProfiles', DRIVER_TWO, 'dues', 'onboarding_fee')));

    // Even an administrator has no client-side write: clearing a fee is the
    // audited `recordDriverDuePayment` call, not an edit in the console.
    const admin = ctxFor(env, ADMIN_UID, 'admin');
    await expectDenied(
      updateDoc(doc(admin.firestore(), 'driverProfiles', DRIVER_TWO, 'dues', 'onboarding_fee'), {
        status: 'paid',
      }),
    );
  });

  it('holds the minted driver id out of the driver’s hands', async () => {
    const pending = ctxFor(env, DRIVER_TWO, 'driver');
    await expectDenied(
      updateDoc(doc(pending.firestore(), 'driverProfiles', DRIVER_TWO), { driverId: 'DRV-SELFMADE' }),
    );
  });

  it('shows a driver the commission owed on their own trip only', async () => {
    const owing = ctxFor(env, DRIVER_TWO, 'driver');
    const row = await expectAllowed(
      getDoc(doc(owing.firestore(), 'driverProfiles', DRIVER_TWO, 'dues', `commission_${BOOKING_TWO}`)),
    );
    expect(row.data()?.kind).toBe('commission');
    expect(row.data()?.bookingId).toBe(BOOKING_TWO);
    // The office's 13% of this trip's ₹305.00 pre-GST fare, plus 5% GST on that.
    expect(row.data()?.basePaise).toBe(3_965);
    expect(row.data()?.totalPaise).toBe(4_163);

    const other = ctxFor(env, DRIVER_ONE, 'driver');
    await expectDenied(
      getDoc(doc(other.firestore(), 'driverProfiles', DRIVER_TWO, 'dues', `commission_${BOOKING_TWO}`)),
    );
    await expectDenied(
      updateDoc(doc(owing.firestore(), 'driverProfiles', DRIVER_TWO, 'dues', `commission_${BOOKING_TWO}`), {
        status: 'paid',
      }),
    );
  });

  it('serves the console’s outstanding list to staff and to nobody else', async () => {
    // A collection-group query is checked by the `/{path=**}/dues/{dueId}` rule
    // alone, so this is the only place that grant is measured. Other tests in this
    // file write their own dues rows, so the assertions name this run's paths
    // rather than an exact set — what must never appear is a row that is paid.
    const unpaid = (ctx: RulesTestContext) => {
      const db = ctx.firestore();
      return getDocs(query(collectionGroup(db, 'dues'), where('status', '==', 'unpaid')));
    };

    const admin = await expectAllowed(unpaid(ctxFor(env, ADMIN_UID, 'admin')));
    const owed = admin.docs.map((row) => row.ref.path);
    expect(owed).toContain(`driverProfiles/${DRIVER_TWO}/dues/onboarding_fee`);
    expect(owed).toContain(`driverProfiles/${DRIVER_TWO}/dues/commission_${BOOKING_TWO}`);
    expect(admin.docs.some((row) => row.data().status === 'paid')).toBe(false);
    await expectAllowed(unpaid(ctxFor(env, OPS_UID, 'ops')));

    // A driver and a customer are refused the whole query, not filtered down to
    // their own rows: one driver's balance must never be readable by another.
    await expectDenied(unpaid(ctxFor(env, DRIVER_TWO, 'driver')));
    await expectDenied(unpaid(ctxFor(env, CUSTOMER_ONE, 'customer')));
    await expectDenied(unpaid(env.unauthenticatedContext()));
  });
});

describe('catalogue and pricing', () => {
  it('hides disabled cab services from customers but shows them to staff', async () => {
    const customer = ctxFor(env, CUSTOMER_ONE, 'customer');
    expect(
      (await expectAllowed(getDoc(doc(customer.firestore(), 'serviceTypes', 'svc-home')))).exists(),
    ).toBe(true);
    await expectDenied(getDoc(doc(customer.firestore(), 'serviceTypes', 'svc-cab')));

    const ops = ctxFor(env, OPS_UID, 'ops');
    expect((await expectAllowed(getDoc(doc(ops.firestore(), 'serviceTypes', 'svc-cab')))).exists()).toBe(true);
  });

  it('only answers a service query that stays inside the enabled set', async () => {
    const customer = ctxFor(env, CUSTOMER_ONE, 'customer');
    const rows = await expectAllowed(
      getDocs(query(collection(customer.firestore(), 'serviceTypes'), where('enabled', '==', true), limit(25))),
    );
    const ids = rows.docs.map((row) => row.id);
    // Checked by membership rather than an exact set: a customer's enabled query
    // legitimately returns the catalogue the apps seed here too. `cab_standard`
    // is seeded disabled by the app itself, so its absence is the rule working
    // against real data rather than only against this suite's fixture.
    expect(ids).toContain('svc-home');
    expect(ids).not.toContain('svc-cab');
    expect(ids).not.toContain('cab_standard');

    const nosy = ctxFor(env, CUSTOMER_ONE, 'customer');
    await expectDenied(getDocs(query(collection(nosy.firestore(), 'serviceTypes'), limit(25))));
  });

  it('never exposes raw pricing rules to a client, and never lets a price be self-set', async () => {
    const customer = ctxFor(env, CUSTOMER_ONE, 'customer');
    await expectDenied(getDoc(doc(customer.firestore(), 'pricingRules', 'price-base')));

    const driver = ctxFor(env, DRIVER_ONE, 'driver');
    await expectDenied(setDoc(doc(driver.firestore(), 'pricingRules', 'price-base'), { basePaise: 1 }));

    const admin = ctxFor(env, ADMIN_UID, 'admin');
    expect((await expectAllowed(getDoc(doc(admin.firestore(), 'pricingRules', 'price-base')))).exists()).toBe(true);
  });

  it('keeps the service catalogue under function control', async () => {
    const admin = ctxFor(env, ADMIN_UID, 'admin');
    await expectDenied(setDoc(doc(admin.firestore(), 'serviceTypes', 'svc-x'), { enabled: true }));
  });
});

describe('money and reputation', () => {
  it('shows a payment to its customer and to staff only', async () => {
    const owner = ctxFor(env, CUSTOMER_ONE, 'customer');
    expect((await expectAllowed(getDoc(doc(owner.firestore(), 'payments', 'pay-1')))).exists()).toBe(true);

    const stranger = ctxFor(env, CUSTOMER_TWO, 'customer');
    await expectDenied(getDoc(doc(stranger.firestore(), 'payments', 'pay-1')));

    const driver = ctxFor(env, DRIVER_ONE, 'driver');
    await expectDenied(getDoc(doc(driver.firestore(), 'payments', 'pay-1')));
  });

  it('refuses any client write to payments, refunds and ratings', async () => {
    const ctx = ctxFor(env, CUSTOMER_ONE, 'customer');
    const db = ctx.firestore();
    await expectDenied(setDoc(doc(db, 'payments', 'pay-9'), { customerUid: CUSTOMER_ONE, status: 'succeeded' }));
    await expectDenied(updateDoc(doc(db, 'payments', 'pay-1'), { status: 'succeeded' }));
    await expectDenied(setDoc(doc(db, 'refunds', 'ref-9'), { bookingId: BOOKING_ONE, amountPaise: 1 }));
    await expectDenied(setDoc(doc(db, 'ratings', 'rate-9'), { bookingId: BOOKING_ONE, score: 1 }));
  });

  it('shares a refund only with its booking customer and staff', async () => {
    const owner = ctxFor(env, CUSTOMER_ONE, 'customer');
    expect((await expectAllowed(getDoc(doc(owner.firestore(), 'refunds', 'ref-1')))).exists()).toBe(true);
    await expectDenied(getDoc(doc(ctxFor(env, CUSTOMER_TWO, 'customer').firestore(), 'refunds', 'ref-1')));
  });

  it('shows a rating to the two people it involves', async () => {
    // The customer who gave it reads their own line back — the trip receipt does
    // not need `rateTrip`'s answer to survive a reload. The driver it is about
    // reads it too, which is what the Account list runs on, and the office sees
    // every row. Nobody else has any business reading it.
    const rated = ctxFor(env, DRIVER_ONE, 'driver').firestore();
    expect((await expectAllowed(getDoc(doc(rated, 'ratings', 'rate-1')))).exists()).toBe(true);
    expect(
      (await expectAllowed(getDoc(doc(ctxFor(env, CUSTOMER_ONE, 'customer').firestore(), 'ratings', 'rate-1')))).exists(),
    ).toBe(true);
    expect(
      (await expectAllowed(getDoc(doc(ctxFor(env, ADMIN_UID, 'admin').firestore(), 'ratings', 'rate-1')))).exists(),
    ).toBe(true);
    await expectDenied(getDoc(doc(ctxFor(env, CUSTOMER_TWO, 'customer').firestore(), 'ratings', 'rate-1')));
    await expectDenied(getDoc(doc(ctxFor(env, DRIVER_TWO, 'driver').firestore(), 'ratings', 'rate-1')));
  });

  it('answers the rating list the driver\'s own Account screen runs', async () => {
    // That screen reads `ratings` directly rather than through a function, since
    // the rules already let the rated person see their rows. So this is the same
    // query, field for field — own uid in `ratedUid`, newest first, capped — and
    // what comes back is the score, the chips and the trip reference the screen
    // prints. Another driver running the same shape gets nothing: the rule is
    // per row, and no row of someone else's can satisfy it.
    const rows = await expectAllowed(
      getDocs(
        query(
          collection(ctxFor(env, DRIVER_ONE, 'driver').firestore(), 'ratings'),
          where('ratedUid', '==', DRIVER_ONE),
          orderBy('createdAtMs', 'desc'),
          limit(20),
        ),
      ),
    );
    expect(rows.docs.map((row) => row.data().score)).toEqual([5]);
    expect(rows.docs[0]?.data().bookingReference).toBe('DRX-7K3QD2');
    expect(rows.docs[0]?.data().tags).toEqual(['knew_the_route']);

    const nobody = await expectAllowed(
      getDocs(
        query(
          collection(ctxFor(env, DRIVER_TWO, 'driver').firestore(), 'ratings'),
          where('ratedUid', '==', DRIVER_TWO),
          orderBy('createdAtMs', 'desc'),
          limit(20),
        ),
      ),
    );
    expect(nobody.empty).toBe(true);
  });

  it('lets nobody change a rating, including the driver it praises', async () => {
    // `write: if false` is the whole defence: the score a customer gave is the
    // score on file, and the person whose average it moves cannot touch it.
    const rated = ctxFor(env, DRIVER_ONE, 'driver').firestore();
    await expectDenied(updateDoc(doc(rated, 'ratings', 'rate-1'), { score: 1 }));
    await expectDenied(deleteDoc(doc(rated, 'ratings', 'rate-1')));
    await expectDenied(setDoc(doc(rated, 'ratings', `customer_${BOOKING_ONE}`), { score: 5 }));

    const rater = ctxFor(env, CUSTOMER_ONE, 'customer').firestore();
    await expectDenied(updateDoc(doc(rater, 'ratings', 'rate-1'), { score: 2 }));
    await expectDenied(deleteDoc(doc(rater, 'ratings', 'rate-1')));
  });

  it('keeps trip summaries to the trip participants', async () => {
    expect(
      (await expectAllowed(getDoc(doc(ctxFor(env, CUSTOMER_TWO, 'customer').firestore(), 'tripSummaries', BOOKING_TWO)))).exists(),
    ).toBe(true);
    await expectDenied(getDoc(doc(ctxFor(env, CUSTOMER_ONE, 'customer').firestore(), 'tripSummaries', BOOKING_TWO)));
    await expectDenied(setDoc(doc(ctxFor(env, DRIVER_ONE, 'driver').firestore(), 'tripSummaries', 'ts-9'), { bookingId: BOOKING_ONE }));
  });
});

describe('saved places and notifications', () => {
  it('keeps saved places private', async () => {
    const owner = ctxFor(env, CUSTOMER_ONE, 'customer');
    const rows = await expectAllowed(
      getDocs(query(collection(owner.firestore(), 'savedPlaces', CUSTOMER_ONE, 'places'), limit(20))),
    );
    expect(rows.size).toBe(1);
    await expectDenied(getDoc(doc(ctxFor(env, CUSTOMER_TWO, 'customer').firestore(), 'savedPlaces', CUSTOMER_ONE, 'places', 'home')));
  });

  it('allows notifications to be read, marked read, and dismissed by their owner', async () => {
    const owner = ctxFor(env, CUSTOMER_ONE, 'customer');
    const db = owner.firestore();
    const path: DocPath = ['users', CUSTOMER_ONE, 'notifications', 'n-1'];
    expect((await expectAllowed(getDoc(doc(db, ...path)))).exists()).toBe(true);
    await expectAllowed(updateDoc(doc(db, ...path), { readAtMs: Date.now() }));
    await expectDenied(updateDoc(doc(db, ...path), { body: 'Something else entirely' }));
    await expectDenied(updateDoc(doc(db, ...path), { title: 'Phishing', readAtMs: Date.now() }));
    await expectDenied(setDoc(doc(db, 'users', CUSTOMER_TWO, 'notifications', 'n-9'), { title: 'Fake', readAtMs: null }));
    await expectDenied(getDoc(doc(ctxFor(env, CUSTOMER_TWO, 'customer').firestore(), ...path)));
  });
});

describe('support tickets', () => {
  it('accepts a well-formed ticket on the caller’s own booking', async () => {
    const ctx = ctxFor(env, CUSTOMER_ONE, 'customer');
    await expectAllowed(
      setDoc(doc(ctx.firestore(), 'supportTickets', runId('tk-9')), {
        openedByUid: CUSTOMER_ONE,
        bookingId: BOOKING_ONE,
        subject: 'Late arrival',
        body: 'Driver was 20 minutes late.',
        status: 'open',
        priority: 'normal',
        assignedAdminUid: null,
      }),
    );
  });

  it('rejects fabricated tickets and self-assigned outcomes', async () => {
    const ctx = ctxFor(env, CUSTOMER_ONE, 'customer');
    const db = ctx.firestore();
    await expectDenied(
      setDoc(doc(db, 'supportTickets', 'tk-8'), {
        openedByUid: CUSTOMER_ONE,
        bookingId: BOOKING_TWO,
        subject: 'Not my trip',
        status: 'open',
        priority: 'normal',
        assignedAdminUid: null,
      }),
    );
    await expectDenied(
      setDoc(doc(db, 'supportTickets', 'tk-7'), {
        openedByUid: CUSTOMER_TWO,
        bookingId: BOOKING_ONE,
        status: 'open',
        priority: 'normal',
        assignedAdminUid: null,
      }),
    );
    await expectDenied(
      setDoc(doc(db, 'supportTickets', 'tk-6'), {
        openedByUid: CUSTOMER_ONE,
        bookingId: BOOKING_ONE,
        status: 'resolved',
        priority: 'normal',
        assignedAdminUid: null,
      }),
    );
  });

  it('lets the opener reply but not close or reprioritise', async () => {
    const ctx = ctxFor(env, CUSTOMER_ONE, 'customer');
    const db = ctx.firestore();
    await expectAllowed(updateDoc(doc(db, 'supportTickets', 'tk-1'), { body: 'Adding detail.' }));
    await expectDenied(updateDoc(doc(db, 'supportTickets', 'tk-1'), { status: 'closed' }));
    await expectDenied(updateDoc(doc(db, 'supportTickets', 'tk-1'), { priority: 'high' }));
    await expectDenied(updateDoc(doc(db, 'supportTickets', 'tk-1'), { assignedAdminUid: ADMIN_UID }));

    const ops = ctxFor(env, OPS_UID, 'ops');
    await expectAllowed(updateDoc(doc(ops.firestore(), 'supportTickets', 'tk-1'), { status: 'in_progress' }));
  });

  it('hides a ticket from everyone except its opener and staff', async () => {
    await expectDenied(getDoc(doc(ctxFor(env, CUSTOMER_TWO, 'customer').firestore(), 'supportTickets', 'tk-1')));
    expect(
      (await expectAllowed(getDoc(doc(ctxFor(env, ADMIN_UID, 'admin').firestore(), 'supportTickets', 'tk-1')))).exists(),
    ).toBe(true);
  });
});

describe('privileged collections', () => {
  it('reads the audit log as an administrator only', async () => {
    expect((await expectAllowed(getDoc(doc(ctxFor(env, ADMIN_UID, 'admin').firestore(), 'adminAuditLogs', 'log-1')))).exists()).toBe(true);
    await expectDenied(getDoc(doc(ctxFor(env, OPS_UID, 'ops').firestore(), 'adminAuditLogs', 'log-1')));
    await expectDenied(updateDoc(doc(ctxFor(env, ADMIN_UID, 'admin').firestore(), 'adminAuditLogs', 'log-1'), { action: 'erased' }));
  });

  it('keeps OTP records out of every client, including staff', async () => {
    for (const [uid, role] of [
      [CUSTOMER_ONE, 'customer'],
      [DRIVER_ONE, 'driver'],
      [ADMIN_UID, 'admin'],
      [OPS_UID, 'ops'],
    ] as const) {
      const ctx = ctxFor(env, uid, role);
      await expectDenied(getDoc(doc(ctx.firestore(), 'otpCodes', 'otp-1')));
      await expectDenied(setDoc(doc(ctx.firestore(), 'otpCodes', 'otp-1'), { codeHash: 'x' }));
    }
  });

  it('serves public launch config to any signed-in user and nothing else', async () => {
    const customer = ctxFor(env, CUSTOMER_ONE, 'customer');
    expect((await expectAllowed(getDoc(doc(customer.firestore(), 'appConfig', 'public')))).exists()).toBe(true);
    await expectDenied(getDoc(doc(customer.firestore(), 'appConfig', 'internal')));
    await expectDenied(getDoc(doc(env.unauthenticatedContext().firestore(), 'appConfig', 'public')));

    const admin = ctxFor(env, ADMIN_UID, 'admin');
    expect((await expectAllowed(getDoc(doc(admin.firestore(), 'appConfig', 'internal')))).exists()).toBe(true);
    await expectAllowed(updateDoc(doc(admin.firestore(), 'appConfig', 'public'), { launchCity: 'Delhi' }));

    const nosy = ctxFor(env, CUSTOMER_ONE, 'customer');
    await expectDenied(updateDoc(doc(nosy.firestore(), 'appConfig', 'public'), { launchCity: 'Nowhere' }));
  });

  it('exposes the account row to its owner and to staff', async () => {
    expect((await expectAllowed(getDoc(doc(ctxFor(env, CUSTOMER_ONE, 'customer').firestore(), 'users', CUSTOMER_ONE)))).exists()).toBe(true);
    await expectDenied(getDoc(doc(ctxFor(env, CUSTOMER_TWO, 'customer').firestore(), 'users', CUSTOMER_ONE)));
    expect((await expectAllowed(getDoc(doc(ctxFor(env, OPS_UID, 'ops').firestore(), 'users', DRIVER_ONE)))).exists()).toBe(true);
    await expectDenied(setDoc(doc(ctxFor(env, ADMIN_UID, 'admin').firestore(), 'users', CUSTOMER_ONE), { role: 'admin' }));
  });

  it('denies any collection that has no rule yet', async () => {
    await expectDenied(getDoc(doc(ctxFor(env, ADMIN_UID, 'admin').firestore(), 'unknownCollection', 'x')));
  });
});
