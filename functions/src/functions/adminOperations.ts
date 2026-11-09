import { onCall } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { DRIVER_ON_DUTY_STATUSES, isActiveTrip, isCancellable, RTDB_PATHS, type BookingStatus } from '@drivx/domain';
import { authAdmin, bucket, db, rtdb, serverTimestamp, writeAuditLog } from '../lib/admin';
import { CALLABLE_OPTIONS } from '../lib/config';
import { failedPrecondition, notFound, parseInput } from '../lib/errors';
import { requireAdmin } from '../lib/guards';

const reason = z.string().trim().min(8).max(400);

/**
 * Restart a driver's application while retaining the Auth UID and all ledger
 * records. This deliberately is not an Auth-user delete: the phone can sign in
 * again, paid money remains auditable, and private submitted paperwork is
 * removed so the driver can upload a fresh set.
 */
export const resetDriverOnboarding = onCall(CALLABLE_OPTIONS, async (request) => {
  const actor = requireAdmin(request);
  const input = parseInput(z.object({ driverUid: z.string().min(1).max(128), reason }), request.data);
  const profileRef = db().doc(`driverProfiles/${input.driverUid}`);
  const profileSnap = await profileRef.get();
  if (!profileSnap.exists) throw notFound('Driver profile not found.');

  const [bookings, dues, onboardingDue, documents] = await Promise.all([
    db().collection('bookings').where('assignedDriverUid', '==', input.driverUid).limit(100).get(),
    profileRef.collection('dues').get(),
    profileRef.collection('dues').doc('onboarding_fee').get(),
    profileRef.collection('documents').get(),
  ]);
  const active = bookings.docs.find((row) => isActiveTrip(String(row.get('status') ?? '') as BookingStatus));
  if (active) throw failedPrecondition(`Finish active booking ${String(active.get('reference') ?? active.id)} before resetting this driver.`);
  const unpaidCommission = dues.docs.find((row) => row.get('kind') === 'commission' && row.get('status') === 'unpaid');
  if (unpaidCommission) throw failedPrecondition('Clear this driver’s trip commission dues before resetting onboarding.');
  const fee = onboardingDue.data() ?? {};
  if (onboardingDue.exists && fee.status === 'unpaid' && fee.providerOrderId) {
    throw failedPrecondition('A Cashfree onboarding order is still attached to this fee. Let its webhook settle or expire before resetting.');
  }

  const filePaths = documents.docs.map((row) => row.get('storagePath')).filter((path): path is string => typeof path === 'string' && path.length > 0);
  await Promise.all(filePaths.map((path) => bucket().file(path).delete({ ignoreNotFound: true })));
  await bucket().deleteFiles({ prefix: `avatars/${input.driverUid}/` });
  await db().recursiveDelete(profileRef.collection('documents'));
  const oldZone = typeof profileSnap.get('zoneId') === 'string' ? profileSnap.get('zoneId') as string : null;
  await profileRef.set({
    fullName: null,
    email: null,
    vehicleMake: null,
    vehicleModel: null,
    vehiclePlate: null,
    serviceTypeIds: [],
    zoneId: null,
    dutyTermsVersion: null,
    verificationStatus: 'not_started',
    applicationSubmittedAtMs: null,
    verifiedAtMs: null,
    verifiedByUid: null,
    rejectionReason: null,
    driverId: null,
    availabilityState: 'offline',
    availabilitySinceMs: null,
    photoUrl: null,
    updatedAtMs: serverTimestamp(),
  }, { merge: true });
  await Promise.allSettled([
    rtdb().ref(RTDB_PATHS.driverLocation(input.driverUid)).remove(),
    rtdb().ref(RTDB_PATHS.presence(input.driverUid)).remove(),
    ...(oldZone ? [rtdb().ref(RTDB_PATHS.dispatchGrid(oldZone, input.driverUid)).remove()] : []),
  ]);

  const user = await authAdmin().getUser(input.driverUid);
  await authAdmin().setCustomUserClaims(input.driverUid, {
    ...user.customClaims,
    role: 'driver',
    driverVerified: false,
    roles: [...new Set([...(Array.isArray(user.customClaims?.roles) ? user.customClaims.roles as string[] : []), 'driver'])],
  });
  await writeAuditLog({
    actorUid: actor.uid,
    actorRole: 'admin',
    action: 'driver_onboarding_reset',
    targetType: 'driver',
    targetId: input.driverUid,
    before: { verificationStatus: profileSnap.get('verificationStatus'), driverId: profileSnap.get('driverId') ?? null, documentCount: documents.size, onboardingFeeStatus: fee.status ?? null },
    after: { verificationStatus: 'not_started', driverId: null, documentCount: 0, onboardingFeeStatus: fee.status ?? null },
    reason: input.reason,
  });
  return { reset: true, documentsRemoved: documents.size, paidOnboardingFeePreserved: fee.status === 'paid', uid: input.driverUid };
});

/** Suspend/reactivate a driver without deleting their identity, history, or wallet ledger. */
export const adminSetDriverAccountStatus = onCall(CALLABLE_OPTIONS, async (request) => {
  const actor = requireAdmin(request);
  const input = parseInput(z.object({ driverUid: z.string().min(1).max(128), status: z.enum(['active', 'suspended']), reason }), request.data);
  const profileRef = db().doc(`driverProfiles/${input.driverUid}`);
  const profileSnap = await profileRef.get();
  if (!profileSnap.exists) throw notFound('Driver profile not found.');
  const profile = profileSnap.data() ?? {};
  const oldZone = typeof profile.zoneId === 'string' ? profile.zoneId : null;
  if (input.status === 'suspended') {
    const active = await db().collection('bookings')
      .where('assignedDriverUid', '==', input.driverUid)
      .where('status', 'in', [...DRIVER_ON_DUTY_STATUSES])
      .limit(1).get();
    const activeBooking = active.docs[0];
    if (activeBooking) {
      throw failedPrecondition(`This driver has an active trip (${String(activeBooking.get('reference') ?? activeBooking.id)}). Let it finish before suspending the account.`);
    }
  }
  await profileRef.set({
    accountStatus: input.status,
    availabilityState: 'offline',
    availabilitySinceMs: null,
    accountStatusUpdatedAtMs: serverTimestamp(),
    accountStatusUpdatedByUid: actor.uid,
    updatedAtMs: serverTimestamp(),
  }, { merge: true });
  await Promise.allSettled([
    rtdb().ref(RTDB_PATHS.driverLocation(input.driverUid)).remove(),
    rtdb().ref(RTDB_PATHS.presence(input.driverUid)).update({ state: 'offline', location: null, updatedAtMs: Date.now() }),
    ...(oldZone ? [rtdb().ref(RTDB_PATHS.dispatchGrid(oldZone, input.driverUid)).remove()] : []),
  ]);
  const auditLogId = await writeAuditLog({
    actorUid: actor.uid, actorRole: 'admin', action: input.status === 'suspended' ? 'driver_account_suspended' : 'driver_account_reactivated',
    targetType: 'driver', targetId: input.driverUid,
    before: { accountStatus: profile.accountStatus ?? 'active', availabilityState: profile.availabilityState ?? 'offline' },
    after: { accountStatus: input.status, availabilityState: 'offline' }, reason: input.reason,
  });
  return { driverUid: input.driverUid, status: input.status, auditLogId };
});

/** Admin closure and hiding are soft actions; financial and event history remain. */
export const adminManageBooking = onCall(CALLABLE_OPTIONS, async (request) => {
  const actor = requireAdmin(request);
  const input = parseInput(z.object({ bookingId: z.string().min(8).max(128), action: z.enum(['cancel', 'archive']), reason }), request.data);
  const ref = db().doc(`bookings/${input.bookingId}`);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw notFound('Booking not found.');
  const booking = snapshot.data() ?? {};
  const status = String(booking.status ?? '');
  if (input.action === 'cancel' && status !== 'cancelled' && !isCancellable(status as BookingStatus)) {
    throw failedPrecondition(isActiveTrip(status as BookingStatus) ? 'A started trip cannot be cancelled in Admin. Contact support and preserve its trip record.' : 'Only open, not-yet-started bookings can be cancelled.');
  }
  if (input.action === 'archive' && !['cancelled', 'completed'].includes(status)) {
    throw failedPrecondition('Only completed or cancelled bookings can be archived. Archive hides the row but keeps its financial and audit history.');
  }
  if (input.action === 'cancel' && status !== 'cancelled') {
    const assignments = await ref.collection('assignments').get();
    const driverUid = typeof booking.assignedDriverUid === 'string' ? booking.assignedDriverUid : null;
    await db().runTransaction(async (tx) => {
      const live = await tx.get(ref);
      const latest = live.data() ?? {};
      if (!isCancellable(String(latest.status ?? '') as BookingStatus)) throw failedPrecondition('Booking state changed; reload and review before cancelling.');
      tx.update(ref, {
        status: 'cancelled',
        cancellation: { by: 'admin', reasonCode: 'other', reasonText: input.reason, atMs: serverTimestamp(), feePaise: 0, refundEligible: false },
        updatedAtMs: serverTimestamp(), stateVersion: Number(latest.stateVersion ?? 0) + 1,
      });
      for (const row of assignments.docs) {
        if (['offered', 'accepted'].includes(String(row.get('status')))) tx.update(row.ref, { status: 'revoked', respondedAtMs: Date.now(), updatedAtMs: serverTimestamp(), revokeReason: 'admin_cancelled' });
      }
      if (driverUid) tx.set(db().doc(`driverProfiles/${driverUid}`), { availabilityState: 'offline', availabilitySinceMs: null, updatedAtMs: serverTimestamp() }, { merge: true });
      const eventRef = ref.collection('events').doc(`ev-admin-cancelled-${Date.now()}`);
      tx.set(eventRef, { id: eventRef.id, bookingId: input.bookingId, type: 'booking_cancelled', atMs: serverTimestamp(), actor: { uid: actor.uid, role: 'admin' }, location: null, geofenceKind: null, fromStatus: status, toStatus: 'cancelled', payload: { reason: input.reason, estimatedTotalPaise: latest.estimate?.totalPaise ?? null }, requestId: null });
    });
    if (driverUid) {
      await Promise.allSettled([
        rtdb().ref(RTDB_PATHS.activeBooking(input.bookingId)).remove(),
        rtdb().ref(`authz/${input.bookingId}`).remove(),
        rtdb().ref(RTDB_PATHS.driverLocation(driverUid)).remove(),
        rtdb().ref(RTDB_PATHS.presence(driverUid)).update({ state: 'offline', location: null, updatedAtMs: Date.now() }),
      ]);
    }
  } else if (input.action === 'archive') {
    await ref.set({ adminArchivedAtMs: serverTimestamp(), adminArchivedByUid: actor.uid, adminArchiveReason: input.reason, updatedAtMs: serverTimestamp() }, { merge: true });
  }
  const auditLogId = await writeAuditLog({ actorUid: actor.uid, actorRole: 'admin', action: input.action === 'cancel' ? 'booking_cancelled_by_admin' : 'booking_archived_by_admin', targetType: 'booking', targetId: input.bookingId, before: { status, archived: booking.adminArchivedAtMs != null }, after: { status: input.action === 'cancel' ? 'cancelled' : status, archived: input.action === 'archive' || booking.adminArchivedAtMs != null }, reason: input.reason });
  return { bookingId: input.bookingId, action: input.action, auditLogId };
});
