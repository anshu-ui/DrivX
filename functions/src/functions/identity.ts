import { region } from 'firebase-functions/v1';
import { onCall } from 'firebase-functions/v2/https';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { CLAIM_DEFAULTS } from '@drivx/domain';
import { z } from 'zod';
import { authAdmin, db, serverTimestamp, writeAuditLog } from '../lib/admin';
import { CALLABLE_OPTIONS, REGION } from '../lib/config';
import { failedPrecondition, notFound, parseInput, permissionDenied } from '../lib/errors';
import { requireDriver } from '../lib/guards';

/**
 * Provisioning is one transaction with two entry points: the auth trigger
 * (`provisionNewAccount`) and the callable the app can call itself
 * (`provisionSelf`). Both are idempotent — whichever runs second reads
 * `users/{uid}`, finds it, and writes nothing.
 */
type Identity = {
  uid: string;
  phone: string;
  email: string | null;
  displayName: string | null;
};

async function provisionAccount({
  uid,
  phone,
  email,
  displayName,
}: Identity): Promise<'provisioned' | 'already_provisioned'> {
  const firestore = db();
  const userRef = firestore.collection('users').doc(uid);
  const profileRef = firestore.collection('customerProfiles').doc(uid);

  return firestore.runTransaction(async (tx) => {
    // A transaction may not read after it writes, so both reads come first.
    const [existingUser, existingProfile] = await Promise.all([tx.get(userRef), tx.get(profileRef)]);
    if (existingUser.exists) {
      // Some live accounts were created when the auth trigger had not yet
      // provisioned customerProfiles/{uid}. Repair that missing public-safe
      // contact row on the next authenticated provisioning request.
      if (!existingProfile.exists) {
        tx.create(profileRef, {
          uid,
          fullName: displayName ?? '',
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
          createdAtMs: serverTimestamp(),
          updatedAtMs: serverTimestamp(),
        });
      }
      return 'already_provisioned';
    }

    tx.set(userRef, {
      uid,
      phoneNumberE164: phone,
      email,
      displayName,
      role: 'customer',
      accountStatus: 'active',
      localeTag: 'en-IN',
      timeZone: 'Asia/Kolkata',
      fcmToken: null,
      deletionScheduledAtMs: null,
      createdAtMs: serverTimestamp(),
      lastSignInAtMs: serverTimestamp(),
    });

    if (!existingProfile.exists) {
      tx.set(profileRef, {
        uid,
        fullName: displayName ?? '',
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
        createdAtMs: serverTimestamp(),
        updatedAtMs: serverTimestamp(),
      });
    }

    return 'provisioned';
  });
}

/**
 * Provisions the `users/{uid}` row and default claims when a phone number is
 * verified for the first time.
 *
 * This uses the legacy (v1) auth trigger because it runs on any plan and in the
 * emulator. The Identity Platform blocking equivalent, `beforeUserCreated`,
 * would let provisioning block a signup instead of following it, but needs the
 * Identity Platform addon on Blaze — recorded as a deployment decision, not a
 * code difference.
 *
 * It is *not* sufficient on its own: on the live project `drivx-116de` this
 * trigger is deployed and `ACTIVE` but has never fired for a real signup, and
 * nothing a client can do substitutes for it — the rules refuse
 * `customerProfiles/{uid}` creation without a `role` claim
 * (`firebase/firestore.rules:110`), so an unprovisioned account cannot finish
 * onboarding. `provisionSelf` below is what closes that gap, and the mobile
 * app calls it when a fresh session arrives with no role.
 */
export const provisionNewAccount = region(REGION).auth
  .user()
  .onCreate(async (user, context) => {
    const uid = user.uid;
    const phone = user.phoneNumber ?? null;

    if (!phone) {
      // Every DrivX account is created through phone OTP. An account with no
      // phone number is out of contract and is deliberately given no role.
      console.warn(
        JSON.stringify({ level: 'warn', fn: 'provisionNewAccount', uid, reason: 'missing_phone', authType: context.authType }),
      );
      return;
    }

    const outcome = await provisionAccount({
      uid,
      phone,
      email: user.email ?? null,
      displayName: user.displayName ?? null,
    });

    // New accounts are customers. Becoming a driver is an explicit, audited
    // action, so no client can escalate itself by writing a profile. Claims of
    // an already-provisioned account are left alone — an admin may have changed
    // them since the row was written.
    if (outcome === 'provisioned') {
      await authAdmin().setCustomUserClaims(uid, CLAIM_DEFAULTS);
    }

    console.log(JSON.stringify({ level: 'info', fn: 'provisionNewAccount', uid, outcome }));
  });

/**
 * The same provisioning, requested by the signed-in account for itself.
 *
 * It exists because the auth trigger above is unreliable on this project: a
 * signup can land on a live account with no `users/{uid}` row and no role, and
 * from there the rules refuse every write the app makes. Nothing here is
 * client-supplied — the uid and the phone number both come from the ID token
 * the SDK attached, so the number has to have been verified by Firebase.
 *
 * It cannot escalate anyone: the only role it ever writes is `customer`, it
 * refuses a second run once `users/{uid}` exists, and an account that already
 * has a row keeps whatever claims an administrator set on it.
 */
export const provisionSelf = onCall(CALLABLE_OPTIONS, async (request: CallableRequest<unknown>) => {
  const auth = request.auth;
  if (!auth) throw permissionDenied('Sign in with a mobile number first.');

  const phone = auth.token.phone_number as string | undefined;
  if (!phone) {
    throw permissionDenied(
      'This account has no verified mobile number, so it cannot be provisioned as a customer.',
    );
  }

  const uid = auth.uid;
  const outcome = await provisionAccount({
    uid,
    phone,
    email: (auth.token.email as string | undefined) ?? null,
    displayName: (auth.token.name as string | undefined) ?? null,
  });

  if (outcome === 'provisioned') {
    await authAdmin().setCustomUserClaims(uid, CLAIM_DEFAULTS);
  }

  console.log(JSON.stringify({ level: 'info', fn: 'provisionSelf', uid, outcome }));
  return { outcome, role: CLAIM_DEFAULTS.role };
});

const driverApplicationInput = z.object({
  fullName: z.string().trim().min(2).max(100),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
});

/**
 * A verified phone holder who deliberately signed in to the Driver app may
 * apply for a driver account. This grants only the driver role needed to create
 * an unverified profile and upload paperwork; the verification flag remains
 * false and dispatch still refuses all work until the admin approves the docs.
 */
export const beginDriverOnboarding = onCall(CALLABLE_OPTIONS, async (request: CallableRequest<unknown>) => {
  const auth = request.auth;
  if (!auth) throw permissionDenied('Sign in with a mobile number before applying as a driver.');
  const input = parseInput(driverApplicationInput, request.data);
  const phone = auth.token.phone_number as string | undefined;
  if (!phone) throw permissionDenied('A verified phone number is required for driver registration.');

  const accountOutcome = await provisionAccount({
    uid: auth.uid,
    phone,
    email: input.email,
    displayName: input.fullName,
  });

  const user = await authAdmin().getUser(auth.uid);
  const previous = (user.customClaims ?? {}) as Record<string, unknown>;
  const previousRoles = Array.isArray(previous.roles)
    ? previous.roles.filter((role): role is string => typeof role === 'string')
    : typeof previous.role === 'string'
      ? [previous.role]
      : ['customer'];
  const roles = [...new Set([...previousRoles, 'customer', 'driver'])];

  await authAdmin().setCustomUserClaims(auth.uid, {
    role: 'driver',
    roles,
    admin: previous.admin === true || roles.includes('admin'),
    ops: previous.ops === true || roles.includes('ops') || roles.includes('admin'),
    driverVerified: previous.driverVerified === true && previousRoles.includes('driver'),
    zoneId: typeof previous.zoneId === 'string' ? previous.zoneId : 'delhi-ncr',
    serviceTypeIds: Array.isArray(previous.serviceTypeIds) ? previous.serviceTypeIds : [],
  });

  const driverRef = db().collection('driverProfiles').doc(auth.uid);
  const verificationStatus = await db().runTransaction(async (transaction) => {
    const existingDriver = await transaction.get(driverRef);
    if (existingDriver.exists) {
      // A rejected or pending applicant may correct contact details without
      // touching documents, dues, approval or availability fields.
      transaction.update(driverRef, {
        fullName: input.fullName,
        email: input.email,
        updatedAtMs: serverTimestamp(),
      });
      return String(existingDriver.data()?.verificationStatus ?? 'not_started');
    }

    transaction.create(driverRef, {
      uid: auth.uid,
      fullName: input.fullName,
      email: input.email,
      phoneE164: phone,
      photoUrl: null,
      languages: ['en'],
      zoneId: 'delhi-ncr',
      serviceAreas: [],
      vehicleMake: null,
      vehicleModel: null,
      vehiclePlate: null,
      serviceTypeIds: [],
      verificationStatus: 'not_started',
      applicationSubmittedAtMs: null,
      verifiedAtMs: null,
      verifiedByUid: null,
      rejectionReason: null,
      documentsExpiringBeforeMs: null,
      driverId: null,
      availabilityState: 'offline',
      availabilitySinceMs: null,
      dutyTermsVersion: null,
      dutyTermsAcceptedAtMs: null,
      ratingAverage: 0,
      ratingCount: 0,
      lifetimeTrips: 0,
      onTimeArrivalRate: null,
      acceptanceRate: null,
      createdAtMs: serverTimestamp(),
      updatedAtMs: serverTimestamp(),
    });
    return 'not_started';
  });

  await db().collection('users').doc(auth.uid).set({ role: 'driver', updatedAtMs: serverTimestamp() }, { merge: true });

  return {
    outcome: accountOutcome === 'provisioned' ? 'application_started' : 'application_ready',
    role: 'driver' as const,
    verificationStatus,
  };
});

/** The driver explicitly submits their complete, paid application for Admin review. */
export const submitDriverApplication = onCall(
  { ...CALLABLE_OPTIONS, cpu: 'gcf_gen1', maxInstances: 1 },
  async (request: CallableRequest<unknown>) => {
    const caller = requireDriver(request);
    const profileRef = db().collection('driverProfiles').doc(caller.uid);
    const feeRef = profileRef.collection('dues').doc('onboarding_fee');
    const required = ['driver_photograph', 'photo_id', 'driving_licence'];
    const documentRefs = required.map((id) => profileRef.collection('documents').doc(id));

    const result = await db().runTransaction(async (tx) => {
      const [profileSnap, feeSnap, ...documentSnaps] = await Promise.all([
        tx.get(profileRef),
        tx.get(feeRef),
        ...documentRefs.map((ref) => tx.get(ref)),
      ]);
      if (!profileSnap.exists) throw notFound('Create your driver profile before submitting documents.');
      const profile = profileSnap.data() ?? {};
      const state = String(profile.verificationStatus ?? 'not_started');
      if (state === 'approved') throw failedPrecondition('Your driver account is already approved.');
      if (state === 'pending_review' && profile.applicationSubmittedAtMs) {
        return { alreadySubmitted: true, status: state };
      }
      if (feeSnap.data()?.status !== 'paid') {
        throw failedPrecondition('The one-time Cashfree payment must be confirmed before you submit.');
      }
      const missing = required.filter((_, index) => {
        const document = documentSnaps[index];
        const data = document?.data();
        return !document?.exists || data?.status !== 'pending_review' || typeof data.storagePath !== 'string';
      });
      if (missing.length > 0) {
        throw failedPrecondition('Upload or replace all three required documents before submitting.');
      }

      tx.update(profileRef, {
        applicationSubmittedAtMs: serverTimestamp(),
        verificationStatus: 'pending_review',
        updatedAtMs: serverTimestamp(),
      });
      return { alreadySubmitted: false, status: 'pending_review', previousStatus: state };
    });

    if (!result.alreadySubmitted) {
      await writeAuditLog({
        actorUid: caller.uid,
        actorRole: 'driver',
        action: 'driver_application_submitted',
        targetType: 'driver',
        targetId: caller.uid,
        before: { verificationStatus: result.previousStatus },
        after: { verificationStatus: 'pending_review', documents: ['driver_photograph', 'photo_id', 'driving_licence'] },
      });
    }
    return { status: result.status, alreadySubmitted: result.alreadySubmitted };
  },
);
