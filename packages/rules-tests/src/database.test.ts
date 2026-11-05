import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { get, ref, set } from 'firebase/database';
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';
import {
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
} from './helpers';
import { seedDatabase } from './seed';

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await createTestEnvironment();
  await seedViaServer(env, seedDatabase);
});

afterAll(async () => {
  // beforeAll throws when the emulator is absent, leaving env unset.
  if (!env) return;
  // The Realtime Database rules read Firestore, so this file's seed leaves
  // bookings and profiles in that store too. Sweep them like the Firestore files.
  await purgeRunData();
  await env.cleanup();
});

function freshFix(): Record<string, number | string> {
  const at = Date.now();
  return { bookingId: BOOKING_ONE, lat: 28.46, lng: 77.03, accuracyMeters: 8, fixTimeMs: at, receivedAtMs: at };
}

describe('driver locations', () => {
  it('accepts a fix from the assigned driver while tracking is enabled', async () => {
    const ctx = ctxFor(env, DRIVER_ONE, 'driver');
    await expectAllowed(set(ref(ctx.database(), `driverLocations/${DRIVER_ONE}`), freshFix()));
  });

  it('refuses a driver writing to another driver’s node', async () => {
    const ctx = ctxFor(env, DRIVER_ONE, 'driver');
    await expectDenied(set(ref(ctx.database(), `driverLocations/${DRIVER_TWO}`), freshFix()));
  });

  it('refuses a fix pointed at a booking the caller is not driving', async () => {
    const ctx = ctxFor(env, DRIVER_ONE, 'driver');
    await expectDenied(
      set(ref(ctx.database(), `driverLocations/${DRIVER_ONE}`), { ...freshFix(), bookingId: BOOKING_TWO }),
    );
  });

  it('refuses a fix pointed at a booking that does not exist', async () => {
    const ctx = ctxFor(env, DRIVER_ONE, 'driver');
    await expectDenied(
      set(ref(ctx.database(), `driverLocations/${DRIVER_ONE}`), { ...freshFix(), bookingId: 'bk-999' }),
    );
  });

  it('refuses a fix once tracking has been switched off', async () => {
    const ctx = ctxFor(env, DRIVER_TWO, 'driver');
    await expectDenied(set(ref(ctx.database(), `driverLocations/${DRIVER_TWO}`), freshFix()));
  });

  it('refuses a payload without a booking reference', async () => {
    const ctx = ctxFor(env, DRIVER_ONE, 'driver');
    const at = Date.now();
    await expectDenied(
      set(ref(ctx.database(), `driverLocations/${DRIVER_ONE}`), {
        lat: 28.46,
        lng: 77.03,
        accuracyMeters: 8,
        fixTimeMs: at,
        receivedAtMs: at,
      }),
    );
  });

  it('rejects impossible coordinates and stale timestamps', async () => {
    const ctx = ctxFor(env, DRIVER_ONE, 'driver');
    const db = ctx.database();
    await expectDenied(set(ref(db, `driverLocations/${DRIVER_ONE}`), { ...freshFix(), lat: 120 }));
    await expectDenied(set(ref(db, `driverLocations/${DRIVER_ONE}`), { ...freshFix(), lng: -200 }));
    await expectDenied(set(ref(db, `driverLocations/${DRIVER_ONE}`), { ...freshFix(), accuracyMeters: -1 }));
    await expectDenied(set(ref(db, `driverLocations/${DRIVER_ONE}`), { ...freshFix(), fixTimeMs: Date.now() + 600_000 }));
  });

  it('is read by the driver, the booking customer, and people the trip was shared with', async () => {
    const path = `driverLocations/${DRIVER_ONE}`;
    for (const [uid, role] of [
      [DRIVER_ONE, 'driver'],
      [CUSTOMER_ONE, 'customer'],
      [OPS_UID, 'ops'],
      [ADMIN_UID, 'admin'],
    ] as const) {
      const ctx = ctxFor(env, uid, role);
      const snap = await expectAllowed(get(ref(ctx.database(), path)));
      expect(snap.exists()).toBe(true);
    }
  });

  it('is not readable by an unrelated customer, a different driver, or anonymously', async () => {
    const path = `driverLocations/${DRIVER_ONE}`;
    await expectDenied(get(ref(ctxFor(env, CUSTOMER_TWO, 'customer').database(), path)));
    await expectDenied(get(ref(ctxFor(env, DRIVER_TWO, 'driver').database(), path)));
    await expectDenied(get(ref(env.unauthenticatedContext().database(), path)));
  });

  it('never reveals a location for a finished booking', async () => {
    const ctx = ctxFor(env, CUSTOMER_TWO, 'customer');
    await expectDenied(get(ref(ctx.database(), `driverLocations/${DRIVER_TWO}`)));
  });
});

describe('authorization mirror', () => {
  it('is never client-readable, because rules traverse it implicitly', async () => {
    const ctx = ctxFor(env, DRIVER_ONE, 'driver');
    await expectDenied(get(ref(ctx.database(), `authz/${BOOKING_ONE}`)));
    await expectDenied(get(ref(ctxFor(env, ADMIN_UID, 'admin').database(), 'authz')));
  });

  it('is never client-writable, so a driver cannot grant themselves tracking', async () => {
    const ctx = ctxFor(env, DRIVER_ONE, 'driver');
    await expectDenied(set(ref(ctx.database(), `authz/${BOOKING_ONE}`), { trackingEnabled: true, driverUid: DRIVER_ONE, customerUid: DRIVER_ONE }));
    await expectDenied(set(ref(ctx.database(), 'authz/bk-999'), { trackingEnabled: true, driverUid: DRIVER_ONE, customerUid: DRIVER_ONE }));
  });
});

describe('active bookings index', () => {
  it('is readable by trip participants and staff', async () => {
    expect((await expectAllowed(get(ref(ctxFor(env, CUSTOMER_ONE, 'customer').database(), `activeBookings/${BOOKING_ONE}`)))).exists()).toBe(true);
    expect((await expectAllowed(get(ref(ctxFor(env, DRIVER_ONE, 'driver').database(), `activeBookings/${BOOKING_ONE}`)))).exists()).toBe(true);
  });

  it('is hidden from outsiders', async () => {
    await expectDenied(get(ref(ctxFor(env, CUSTOMER_TWO, 'customer').database(), `activeBookings/${BOOKING_ONE}`)));
    await expectDenied(get(ref(env.unauthenticatedContext().database(), `activeBookings/${BOOKING_ONE}`)));
  });

  it('is written only by Cloud Functions', async () => {
    const ctx = ctxFor(env, DRIVER_ONE, 'driver');
    await expectDenied(set(ref(ctx.database(), `activeBookings/${BOOKING_ONE}`), { status: 'completed' }));
    await expectDenied(set(ref(ctxFor(env, ADMIN_UID, 'admin').database(), `activeBookings/bk-999`), { status: 'created' }));
  });
});

describe('presence', () => {
  it('lets a driver publish their own state', async () => {
    const ctx = ctxFor(env, DRIVER_ONE, 'driver');
    await expectAllowed(set(ref(ctx.database(), `presence/${DRIVER_ONE}`), { state: 'online', updatedAtMs: Date.now() }));
  });

  it('rejects invented states and timestamps from the future', async () => {
    const ctx = ctxFor(env, DRIVER_ONE, 'driver');
    const db = ctx.database();
    await expectDenied(set(ref(db, `presence/${DRIVER_ONE}`), { state: 'on_mars', updatedAtMs: Date.now() }));
    await expectDenied(set(ref(db, `presence/${DRIVER_ONE}`), { state: 'online', updatedAtMs: Date.now() + 3_600_000 }));
    await expectDenied(set(ref(db, `presence/${DRIVER_ONE}`), { updatedAtMs: Date.now() }));
  });

  it('is private to the driver and staff', async () => {
    expect((await expectAllowed(get(ref(ctxFor(env, DRIVER_ONE, 'driver').database(), `presence/${DRIVER_ONE}`)))).exists()).toBe(true);
    expect((await expectAllowed(get(ref(ctxFor(env, OPS_UID, 'ops').database(), `presence/${DRIVER_ONE}`)))).exists()).toBe(true);
    await expectDenied(get(ref(ctxFor(env, CUSTOMER_ONE, 'customer').database(), `presence/${DRIVER_ONE}`)));
    await expectDenied(set(ref(ctxFor(env, CUSTOMER_ONE, 'customer').database(), `presence/${DRIVER_ONE}`), { state: 'offline', updatedAtMs: Date.now() }));
  });
});

describe('dispatch grid', () => {
  it('is staff-only density data, never client-writable', async () => {
    expect((await expectAllowed(get(ref(ctxFor(env, OPS_UID, 'ops').database(), 'dispatchGrid/zone-ggn-1')))).exists()).toBe(true);
    expect((await expectAllowed(get(ref(ctxFor(env, ADMIN_UID, 'admin').database(), 'dispatchGrid/zone-ggn-1')))).exists()).toBe(true);
    await expectDenied(get(ref(ctxFor(env, DRIVER_ONE, 'driver').database(), 'dispatchGrid/zone-ggn-1')));
    await expectDenied(set(ref(ctxFor(env, OPS_UID, 'ops').database(), 'dispatchGrid/zone-ggn-1/drv-1'), { lat: 1, lng: 1 }));
  });
});

describe('connection heartbeats', () => {
  it('is scoped to the owning account', async () => {
    const ctx = ctxFor(env, CUSTOMER_ONE, 'customer');
    await expectAllowed(set(ref(ctx.database(), `connections/${CUSTOMER_ONE}`), 'online'));
    await expectAllowed(get(ref(ctx.database(), `connections/${CUSTOMER_ONE}`)));
    await expectDenied(get(ref(ctxFor(env, CUSTOMER_TWO, 'customer').database(), `connections/${CUSTOMER_ONE}`)));
    await expectDenied(set(ref(ctxFor(env, CUSTOMER_TWO, 'customer').database(), `connections/${CUSTOMER_ONE}`), 'online'));
  });
});

describe('root', () => {
  it('denies a blanket read of the database', async () => {
    await expectDenied(get(ref(ctxFor(env, ADMIN_UID, 'admin').database(), '/')));
    await expectDenied(get(ref(ctxFor(env, DRIVER_ONE, 'driver').database(), 'driverLocations')));
  });
});
