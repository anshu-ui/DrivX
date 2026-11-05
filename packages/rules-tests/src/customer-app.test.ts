import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';
import {
  ADMIN_UID,
  BOOKING_ONE,
  BOOKING_TWO,
  CUSTOMER_ONE,
  CUSTOMER_TWO,
  DRIVER_ONE,
  createTestEnvironment,
  ctxFor,
  expectAllowed,
  expectDenied,
  purgeRunData,
  seedViaServer,
} from './helpers';
import { seedFirestore } from './seed';

/**
 * Replay of every read and write the customer app actually performs.
 *
 * The hooks in `apps/mobile/src/features/customer/` cannot run in Node (they are
 * React Query hooks over a device session), so each case below restates one
 * hook's exact Firestore call — same filter, same limit, same payload keys — and
 * additionally asserts that the seeded document carries the fields the screen
 * reads. A rules suite that passes against fixtures the app cannot render would
 * be proving nothing, so the two are checked together here.
 */

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await createTestEnvironment();
  await seedViaServer(env, seedFirestore);
});

afterAll(async () => {
  if (!env) return;
  await purgeRunData();
  await env.cleanup();
});

const customer = () => ctxFor(env, CUSTOMER_ONE, 'customer').firestore();
const otherCustomer = () => ctxFor(env, CUSTOMER_TWO, 'customer').firestore();

describe('bookings list — useMyBookings', () => {
  it('runs the hook query as-is and returns the fields the rows render', async () => {
    const rows = await expectAllowed(
      getDocs(
        query(
          collection(customer(), 'bookings'),
          where('customerUid', '==', CUSTOMER_ONE),
          orderBy('createdAtMs', 'desc'),
          limit(25),
        ),
      ),
    );

    // Only bk-1 belongs to cust-1, and the list must not leak bk-2.
    expect(rows.docs.map((row) => row.id)).toEqual([BOOKING_ONE]);

    const data = rows.docs[0]!.data();
    expect(data.reference).toBe('DRX-7K3QD2');
    expect(data.status).toBe('in_progress');
    expect(data.paymentStatus).toBe('pending');
    expect(data.scheduledForMs).toBeTypeOf('number');
    expect(data.driverEnRouteEta?.minutes).toBe(6);
  });

  it('reads a Place as the domain defines it, not as a loose address', async () => {
    const rows = await expectAllowed(
      getDocs(
        query(
          collection(customer(), 'bookings'),
          where('customerUid', '==', CUSTOMER_ONE),
          limit(25),
        ),
      ),
    );
    const pickup = rows.docs[0]!.data().pickup as Record<string, unknown>;
    const location = pickup.location as { lat: number; lng: number };

    expect(typeof location.lat).toBe('number');
    expect(typeof location.lng).toBe('number');
    for (const key of ['label', 'addressLine1', 'city', 'state', 'source']) {
      expect(pickup[key], `pickup.${key}`).toBeTypeOf('string');
    }
  });

  it('drops the ownership filter and the rules stop answering', async () => {
    await expectDenied(getDocs(query(collection(customer(), 'bookings'), limit(25))));
  });

  it('asks for more rows than the list rule allows', async () => {
    await expectDenied(
      getDocs(
        query(
          collection(customer(), 'bookings'),
          where('customerUid', '==', CUSTOMER_ONE),
          orderBy('createdAtMs', 'desc'),
          limit(51),
        ),
      ),
    );
  });
});

describe('trip detail — useBookingDetail', () => {
  const detailQuery = () =>
    getDocs(query(collection(customer(), 'bookings', BOOKING_ONE, 'events'), limit(50)));

  it('reads the booking, the summary and the event log in one screen', async () => {
    const booking = await expectAllowed(getDoc(doc(customer(), 'bookings', BOOKING_ONE)));
    const summary = await expectAllowed(getDoc(doc(customer(), 'tripSummaries', BOOKING_ONE)));
    const events = await expectAllowed(detailQuery());

    const estimate = booking.data()?.estimate as Record<string, unknown>;
    expect(estimate.kind).toBe('estimate');
    expect(estimate.pricingRuleId).toBe('price-base');
    expect(Array.isArray(estimate.items)).toBe(true);
    expect((estimate.items as Record<string, unknown>[])[0]).toHaveProperty('amountPaise');
    // The detail screen shows this as an estimate, never a receipt.
    expect(booking.data()?.finalFare).toBeNull();

    expect(summary.data()?.distanceMeters).toBe(14_200);
    expect(summary.data()?.pickupAddressSummary).toBeTypeOf('string');

    expect(events.size).toBe(2);
    const types = events.docs.map((row) => row.data().type);
    expect(types).toContain('trip_started');
    expect(types).toContain('driver_assigned');
    for (const row of events.docs) {
      expect(row.data()).toHaveProperty('atMs');
      expect(row.data()).toHaveProperty('toStatus');
    }
  });

  it('cannot read the assignment record, so no screen pretends to show dispatch state', async () => {
    await expectDenied(
      getDoc(doc(customer(), 'bookings', BOOKING_ONE, 'assignments', 'as-1')),
    );
  });

  it('cannot read the driver profile, so the trip screen shows no driver details', async () => {
    await expectDenied(getDoc(doc(customer(), 'driverProfiles', DRIVER_ONE)));
  });

  it('has no client write path on a booking: fare, status and payment all stay server-side', async () => {
    const db = customer();
    await expectDenied(updateDoc(doc(db, 'bookings', BOOKING_ONE), { status: 'completed' }));
    await expectDenied(updateDoc(doc(db, 'bookings', BOOKING_ONE), { 'estimate.totalPaise': 1 }));
    await expectDenied(
      setDoc(doc(db, 'bookings', 'bk-client-created'), {
        customerUid: CUSTOMER_ONE,
        status: 'requested',
      }),
    );
    await expectDenied(setDoc(doc(db, 'tripSummaries', BOOKING_ONE), { finalFarePaise: 1 }));
  });
});

describe('saved places — useSavedPlaces, useAddSavedPlace, useDeleteSavedPlace', () => {
  const placesOf = (uid: string) => collection(customer(), 'savedPlaces', uid, 'places');

  it('lists the owner’s places with the hook’s limit and shape', async () => {
    const rows = await expectAllowed(
      getDocs(query(placesOf(CUSTOMER_ONE), where('uid', '==', CUSTOMER_ONE), limit(20))),
    );
    expect(rows.size).toBe(1);
    const home = rows.docs[0]!.data();
    expect(home.label).toBe('home');
    expect(home.name).toBe('Home');
    expect((home.place as Record<string, unknown>).location).toBeTypeOf('object');
  });

  it('refuses a list bigger than the subcollection rule caps', async () => {
    await expectDenied(
      getDocs(query(placesOf(CUSTOMER_ONE), where('uid', '==', CUSTOMER_ONE), limit(21))),
    );
  });

  it('writes, edits and removes a place in its own folder', async () => {
    const id = 'home-verify1';
    const ref = doc(customer(), 'savedPlaces', CUSTOMER_ONE, 'places', id);
    const place = (await getDoc(doc(customer(), 'savedPlaces', CUSTOMER_ONE, 'places', 'home')))
      .data()!.place;

    await expectAllowed(
      setDoc(ref, {
        id,
        uid: CUSTOMER_ONE,
        label: 'work',
        name: 'Office',
        place,
        createdAtMs: serverTimestamp(),
        updatedAtMs: serverTimestamp(),
      }),
    );
    await expectAllowed(updateDoc(ref, { name: 'Office tower' }));
    await expectAllowed(deleteDoc(ref));
  });

  it('cannot write into another customer’s folder', async () => {
    await expectDenied(
      setDoc(doc(customer(), 'savedPlaces', CUSTOMER_TWO, 'places', 'sneak'), {
        id: 'sneak',
        uid: CUSTOMER_ONE,
        label: 'other',
        name: 'Their home',
        place: {
          label: 'x',
          addressLine1: 'x',
          city: 'x',
          state: 'x',
          location: { lat: 1, lng: 1 },
          source: 'map_pin',
        },
      }),
    );
  });
});

describe('profile — useCustomerProfile, useUpdateProfile', () => {
  it('reads the profile with the fields the account screen binds', async () => {
    const snap = await expectAllowed(getDoc(doc(customer(), 'customerProfiles', CUSTOMER_ONE)));
    const data = snap.data()!;
    expect(data.preferredTransmission).toBe('automatic');
    expect(data.email).toBe('amit@example.test');
    expect(data.contactPhoneE164).toBe('+919000000001');
    expect((data.privacy as Record<string, unknown>)).toHaveProperty('marketingOptIn');
    expect((data.emergencyContact as Record<string, unknown>)).toHaveProperty('sharesLiveLocation');
  });

  it('saves exactly the payload the mutation sends', async () => {
    const ref = doc(customer(), 'customerProfiles', CUSTOMER_ONE);
    await expectAllowed(
      updateDoc(ref, {
        fullName: 'Amit C',
        email: 'amit.c@example.test',
        preferredTransmission: 'manual',
        emergencyContact: { name: 'Neelam', phoneE164: '+919000000009', sharesLiveLocation: false },
        'privacy.marketingOptIn': true,
      }),
    );
    const after = (await getDoc(ref)).data()!;
    expect(after.fullName).toBe('Amit C');
    expect(after.email).toBe('amit.c@example.test');
    expect((after.emergencyContact as Record<string, unknown>).name).toBe('Neelam');
  });

  /**
   * The first-run form writes both fields with `setDoc`, so that document shape
   * has to be legal for the account that creates it — otherwise a new signup is
   * refused at the exact moment they finish onboarding.
   */
  it('lets a new customer create their own profile with a name and email', async () => {
    const uid = 'cust-signup-1';
    // A fresh account signs its own document, so the context is keyed to the
    // new uid rather than the seeded customer.
    const db = ctxFor(env, uid, 'customer').firestore();
    await expectAllowed(
      setDoc(doc(db, 'customerProfiles', uid), {
        uid,
        fullName: 'Neha Bansal',
        email: 'neha@example.test',
        defaultPickup: null,
        preferredTransmission: 'either',
        preferredCarTypes: [],
        contactPhoneE164: '+919000000007',
        privacy: { shareTripWithContact: false, marketingOptIn: false, preciseLocationWhileIdle: false },
        emergencyContact: { name: null, phoneE164: null, sharesLiveLocation: false },
        ratingAverage: null,
        ratingCount: 0,
        lifetimeBookings: 0,
      }),
    );
  });

  it('refuses the server-owned aggregates the screen displays read-only', async () => {
    const db = customer();
    const ref = doc(db, 'customerProfiles', CUSTOMER_ONE);
    await expectDenied(updateDoc(ref, { lifetimeBookings: 99 }));
    await expectDenied(updateDoc(ref, { ratingAverage: 5, ratingCount: 1 }));
    await expectDenied(updateDoc(ref, { uid: CUSTOMER_TWO }));
    await expectDenied(updateDoc(ref, { createdAtMs: 1, updatedAtMs: 1 }));
  });

  it('keeps precise location while idle switched off, whatever a client asks', async () => {
    await expectDenied(
      updateDoc(doc(customer(), 'customerProfiles', CUSTOMER_ONE), {
        'privacy.preciseLocationWhileIdle': true,
      }),
    );
  });
});

describe('notifications — useNotifications, useMarkNotificationRead', () => {
  it('lists the owner’s inbox', async () => {
    const rows = await expectAllowed(
      getDocs(query(collection(customer(), 'users', CUSTOMER_ONE, 'notifications'), limit(25))),
    );
    expect(rows.size).toBe(1);
    expect(rows.docs[0]!.data().readAtMs).toBeNull();
  });

  it('cannot see anyone else’s inbox', async () => {
    await expectDenied(
      getDocs(query(collection(otherCustomer(), 'users', CUSTOMER_ONE, 'notifications'), limit(25))),
    );
  });

  it('may only write the read receipt', async () => {
    const ref = doc(customer(), 'users', CUSTOMER_ONE, 'notifications', 'n-1');
    await expectAllowed(updateDoc(ref, { readAtMs: serverTimestamp() }));
    const db = customer();
    await expectDenied(updateDoc(doc(db, 'users', CUSTOMER_ONE, 'notifications', 'n-1'), { body: 'edited' }));
    await expectDenied(
      updateDoc(doc(db, 'users', CUSTOMER_ONE, 'notifications', 'n-1'), {
        readAtMs: serverTimestamp(),
        title: 'Injected',
      }),
    );
    await expectDenied(
      setDoc(doc(db, 'users', CUSTOMER_ONE, 'notifications', 'n-fake'), { title: 'You won' }),
    );
  });

  it('can dismiss its own notification', async () => {
    await expectAllowed(deleteDoc(doc(customer(), 'users', CUSTOMER_ONE, 'notifications', 'n-1')));
  });
});

describe('support — useMyTickets, useCreateTicket, useReplyTicket', () => {
  it('lists the tickets the caller opened', async () => {
    const rows = await expectAllowed(
      getDocs(
        query(
          collection(customer(), 'supportTickets'),
          where('openedByUid', '==', CUSTOMER_ONE),
          orderBy('createdAtMs', 'desc'),
          limit(20),
        ),
      ),
    );
    const ids = rows.docs.map((row) => row.id);
    expect(ids).toContain('tk-1');
    // The filter is what keeps tk-2 out; every returned row is the caller's.
    expect(ids).not.toContain('tk-2');
    for (const row of rows.docs) expect(row.data().openedByUid).toBe(CUSTOMER_ONE);
    expect(rows.docs.find((row) => row.id === 'tk-1')!.data().status).toBe('open');
  });

  it('cannot read another customer’s ticket', async () => {
    await expectDenied(getDoc(doc(customer(), 'supportTickets', 'tk-2')));
  });

  it('opens a real ticket with exactly the mutation’s payload', async () => {
    const id = `tk-app-${Date.now().toString(36)}`;
    await expectAllowed(
      setDoc(doc(customer(), 'supportTickets', id), {
        id,
        openedByUid: CUSTOMER_ONE,
        forRole: 'customer',
        bookingId: BOOKING_ONE,
        category: 'fare_dispute',
        priority: 'normal',
        status: 'open',
        subject: 'Estimate differed from the final fare',
        body: 'The trip ended at a higher amount than the estimate shown before pickup.',
        assignedAdminUid: null,
        lastCustomerReplyAtMs: null,
        resolvedAtMs: null,
        resolution: null,
        createdAtMs: serverTimestamp(),
        updatedAtMs: serverTimestamp(),
      }),
    );
    await expectAllowed(updateDoc(doc(customer(), 'supportTickets', id), { body: 'Appended detail.' }));
    // Only staff and admins may delete a ticket, so the fixture is removed the
    // way Cloud Functions would: through the rules-disabled context.
    await seedViaServer(env, async (ctx) => {
      await deleteDoc(doc(ctx.firestore(), 'supportTickets', id));
    });
  });

  it('cannot forge triage fields, impersonate an opener, or attach someone else’s booking', async () => {
    const db = customer();
    const base = {
      openedByUid: CUSTOMER_ONE,
      forRole: 'customer',
      category: 'trip_issue',
      priority: 'normal',
      status: 'open',
      subject: 'Subject',
      body: 'Body long enough to be a real complaint.',
      assignedAdminUid: null,
    };
    await expectDenied(
      setDoc(doc(db, 'supportTickets', 'tk-bad-status'), { ...base, status: 'resolved' }),
    );
    await expectDenied(
      setDoc(doc(db, 'supportTickets', 'tk-assigned'), { ...base, assignedAdminUid: ADMIN_UID }),
    );
    await expectDenied(setDoc(doc(db, 'supportTickets', 'tk-impersonated'), { ...base, openedByUid: CUSTOMER_TWO }));
    await expectDenied(setDoc(doc(db, 'supportTickets', 'tk-other-booking'), { ...base, bookingId: BOOKING_TWO }));
  });

  it('replies within the allowed keys and never touches staff fields', async () => {
    const ref = doc(customer(), 'supportTickets', 'tk-1');
    await expectAllowed(
      updateDoc(ref, { body: 'The driver confirmed the route with me after.', lastCustomerReplyAtMs: serverTimestamp() }),
    );
    await expectDenied(updateDoc(ref, { status: 'closed' }));
    await expectDenied(updateDoc(ref, { priority: 'urgent' }));
    await expectDenied(updateDoc(ref, { assignedAdminUid: ADMIN_UID }));
    await expectDenied(updateDoc(ref, { resolution: 'Self-resolved' }));
  });

  it('cannot reply to a ticket staff has closed', async () => {
    await expectDenied(
      updateDoc(doc(otherCustomer(), 'supportTickets', 'tk-2'), { body: 'Still not happy about it.' }),
    );
  });
});
