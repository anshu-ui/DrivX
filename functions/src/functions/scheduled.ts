import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db, rtdb } from '../lib/admin';
import { REGION } from '../lib/config';
import { DISPATCH_LOCATION_MAX_AGE_MS, RTDB_RETENTION } from '@drivx/domain';
import { offerTrip } from '../lib/dispatch';

/**
 * Stale-location sweeper.
 *
 * Live tracking nodes are meant to be short-lived: they are deleted when a trip
 * completes. A crashed driver app, a killed background process or a failed
 * function leaves an orphan behind, and an orphan is precisely the kind of node
 * that leaks a person's movements after the trip is over. This runs every
 * fifteen minutes and removes anything past its own expiry.
 *
 * OTP expiry is handled by Firestore TTL (see firebase/firestore.indexes.json)
 * rather than by a second implementation here.
 */
export const sweepStaleLocationData = onSchedule(
  { region: REGION, schedule: 'every 15 minutes', memory: '256MiB' },
  async () => {
    const now = Date.now();
    const dbRef = rtdb();

    const expiredBookings = await dbRef
      .ref('activeBookings')
      .orderByChild('expiresAtMs')
      .endAt(now)
      .limitToFirst(500)
      .once('value');

    const expiredValues = (expiredBookings.val() ?? {}) as Record<string, { driverUid?: unknown }>;
    const bookingKeys: string[] = Object.keys(expiredValues);
    await Promise.all(bookingKeys.flatMap((key) => {
      const driverUid = typeof expiredValues[key]?.driverUid === 'string' ? String(expiredValues[key]!.driverUid) : null;
      return [
        dbRef.ref(`activeBookings/${key}`).remove(),
        dbRef.ref(`authz/${key}/trackingEnabled`).set(false),
        ...(driverUid ? [dbRef.ref(`driverLocations/${driverUid}`).remove()] : []),
      ];
    }));

    // A driver location older than the staleness window is not a live position.
    const staleLocations = await dbRef
      .ref('driverLocations')
      .orderByChild('receivedAtMs')
      .endAt(now - RTDB_RETENTION.staleAfterMs * 3)
      .limitToFirst(500)
      .once('value');

    const locationKeys: string[] = Object.keys(staleLocations.val() ?? {});
    for (const key of locationKeys) {
      await dbRef.ref(`driverLocations/${key}`).remove();
    }

    // Offline drivers have no business still holding a presence row.
    const stalePresence = await dbRef
      .ref('presence')
      .orderByChild('updatedAtMs')
      .endAt(now - RTDB_RETENTION.presenceTtlMs)
      .limitToFirst(500)
      .once('value');

    const presenceKeys: string[] = Object.keys(stalePresence.val() ?? {});
    for (const key of presenceKeys) {
      await dbRef.ref(`presence/${key}`).remove();
    }

    console.log(
      JSON.stringify({
        level: 'info',
        fn: 'sweepStaleLocationData',
        activeBookingsRemoved: bookingKeys.length,
        locationsRemoved: locationKeys.length,
        presenceRemoved: presenceKeys.length,
      }),
    );
  },
);

/** Remove dispatch coordinates quickly after an app stops refreshing its pin. */
export const sweepStaleDispatchPins = onSchedule(
  { region: REGION, schedule: 'every 1 minutes', memory: '256MiB' },
  async () => {
    const now = Date.now();
    const root = await rtdb().ref('dispatchGrid').once('value');
    const zones = (root.val() ?? {}) as Record<string, Record<string, { updatedAtMs?: unknown }>>;
    const removals: Promise<void>[] = [];
    for (const [zoneId, drivers] of Object.entries(zones)) {
      for (const [driverUid, pin] of Object.entries(drivers ?? {})) {
        const updatedAtMs = Number(pin?.updatedAtMs ?? 0);
        if (!Number.isFinite(updatedAtMs) || updatedAtMs < now - DISPATCH_LOCATION_MAX_AGE_MS) {
          removals.push(rtdb().ref(`dispatchGrid/${zoneId}/${driverUid}`).remove());
        }
      }
    }
    await Promise.all(removals);
    if (removals.length > 0) {
      console.log(JSON.stringify({ level: 'info', fn: 'sweepStaleDispatchPins', removed: removals.length }));
    }
  },
);

/** Expire unanswered offers and hand each booking to the next eligible driver. */
export const sweepExpiredDriverOffers = onSchedule(
  { region: REGION, schedule: 'every 1 minutes', memory: '256MiB' },
  async () => {
    const now = Date.now();
    const expired = await db()
      .collectionGroup('assignments')
      .where('status', '==', 'offered')
      .where('expiresAtMs', '<=', now)
      .limit(100)
      .get();
    let advanced = 0;
    for (const offer of expired.docs) {
      const bookingId = offer.ref.parent.parent?.id;
      if (!bookingId) continue;
      const didExpire = await db().runTransaction(async (transaction) => {
        const current = await transaction.get(offer.ref);
        if (!current.exists || current.data()?.status !== 'offered') return false;
        const expiry = Number(current.data()?.expiresAtMs ?? 0);
        if (expiry > Date.now()) return false;
        transaction.update(offer.ref, { status: 'expired', respondedAtMs: now, updatedAtMs: now });
        return true;
      });
      if (!didExpire) continue;
      await offerTrip(bookingId);
      advanced += 1;
    }
    if (advanced > 0) {
      console.log(JSON.stringify({ level: 'info', fn: 'sweepExpiredDriverOffers', advanced }));
    }
  },
);
