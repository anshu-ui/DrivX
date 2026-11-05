import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { PillTone } from '@drivx/ui';
import { collection, doc, onSnapshot, updateDoc } from 'firebase/firestore';
import { toEpochMs } from '@drivx/firebase-client';
import {
  COLLECTIONS,
  SUBCOLLECTIONS,
  formatINR,
  type VerificationStatus,
} from '@drivx/domain';
import { useSession } from '../auth/AuthProvider';
import { firebase } from '../../lib/firebase';

/**
 * Whether this driver may work, read live from their own profile.
 *
 * The custom claim `driverVerified` is written by `setDriverVerification` but
 * only reaches the app when the id token is next minted, so a driver who is
 * approved while the app is open would keep seeing a locked screen until they
 * signed out. The profile document is the truth, and a listener means the
 * interface unlocks the moment the reviewer saves.
 */
export type DriverAccess = {
  status: VerificationStatus | 'unknown';
  fullName: string | null;
  /** What the reviewer wrote when they sent the paperwork back. */
  rejectionReason: string | null;
  /** True until the first snapshot lands, so a screen can show a loader. */
  loading: boolean;
};

export function useDriverAccess(): DriverAccess {
  const { user } = useSession();
  const uid = user?.uid ?? null;
  const [snapshot, setSnapshot] = useState<DriverAccess | null>(null);

  useEffect(() => {
    if (uid === null) return;
    return onSnapshot(
      doc(firebase().firestore, COLLECTIONS.driverProfiles, uid),
      (snap) => {
        const data = snap.exists() ? snap.data() : null;
        setSnapshot({
          status: (data?.verificationStatus as VerificationStatus | undefined) ?? 'not_started',
          fullName: (data?.fullName as string | undefined) ?? null,
          rejectionReason: (data?.rejectionReason as string | undefined) ?? null,
          loading: false,
        });
      },
      // A refused read (a signed-out or non-driver token) must not leave the
      // screen spinning forever; it reports unknown and stays locked.
      () => setSnapshot({ status: 'unknown', fullName: null, rejectionReason: null, loading: false }),
    );
  }, [uid]);

  // No subscription, no state: signed out is a fact of `uid`, not of the store.
  if (uid === null) {
    return { status: 'unknown', fullName: null, rejectionReason: null, loading: false };
  }
  return snapshot ?? { status: 'unknown', fullName: null, rejectionReason: null, loading: true };
}

/**
 * What the driver's own status pill says, from the live profile.
 *
 * Shared by Duty and Account because two screens that describe the same
 * `verificationStatus` with different words is how a driver ends up telling the
 * office "you said approved" about a pill that meant something else.
 */
export const ACCESS_COPY: Record<string, { label: string; tone: PillTone }> = {
  approved: { label: 'approved', tone: 'success' },
  pending_review: { label: 'awaiting approval', tone: 'warning' },
  rejected: { label: 'sent back', tone: 'danger' },
  expiring_soon: { label: 'expiring soon', tone: 'warning' },
  expired: { label: 'expired', tone: 'danger' },
  not_started: { label: 'not verified', tone: 'neutral' },
  unknown: { label: 'checking…', tone: 'neutral' },
};

/** One charge on the driver's own record, read straight from Firestore. */
export type DriverDueRow = {
  id: string;
  title: string;
  /** One-time fee, trip commission, or an Admin-configured late-arrival penalty. */
  kind: 'onboarding_fee' | 'commission' | 'late_arrival_penalty';
  /** The trip a commission row came from; null on the one-time fee. */
  bookingId: string | null;
  basePaise: number;
  gstPaise: number;
  /** The platform's cut this row was billed at; null on the one-time fee. */
  rate: number | null;
  /** The rate the bill was issued at, so the label cannot drift from the amount. */
  gstRate: number;
  totalPaise: number;
  status: 'unpaid' | 'paid';
  /** How the office took the money; null while it is still owed. */
  method: string | null;
};

export type DriverDues = {
  loading: boolean;
  /**
   * True when the ledger read was refused. An unread bill and an empty one are
   * different facts, and a driver who is told "nothing is owed" because their
   * own read failed has been told the wrong thing.
   */
  unreadable: boolean;
  rows: DriverDueRow[];
  outstandingPaise: number;
};

const LOADING_DUES: DriverDues = { loading: true, unreadable: false, rows: [], outstandingPaise: 0 };
const UNREADABLE_DUES: DriverDues = { loading: false, unreadable: true, rows: [], outstandingPaise: 0 };

/**
 * What this driver owes the platform, read live from their own `dues` rows.
 *
 * The app quotes the stored number, and the stored rate beside it, rather than
 * recomputing a percentage itself, so a driver and the office can never be
 * looking at two different totals, and a rate the office changes tomorrow cannot
 * be applied to a bill that was already issued.
 */
export function useDriverDues(): DriverDues {
  const { user } = useSession();
  const uid = user?.uid ?? null;
  // Tagged with the uid it was read for, so signing in as somebody else shows
  // loading instead of one flash of the previous account's balance.
  const [read, setRead] = useState<{ uid: string; rows: DriverDueRow[] | 'unreadable' } | null>(null);

  useEffect(() => {
    if (uid === null) return;
    return onSnapshot(
      collection(firebase().firestore, COLLECTIONS.driverProfiles, uid, SUBCOLLECTIONS.driverDues),
      (snap) =>
        setRead({
          uid,
          rows: snap.docs.map((row) => {
            const data = row.data();
            return {
              id: row.id,
              title: String(data.title ?? 'Amount due'),
              kind: data.kind === 'commission' || data.kind === 'late_arrival_penalty' ? data.kind : ('onboarding_fee' as const),
              bookingId: typeof data.bookingId === 'string' ? data.bookingId : null,
              basePaise: Number(data.basePaise ?? 0),
              gstPaise: Number(data.gstPaise ?? 0),
              rate: typeof data.rate === 'number' ? data.rate : null,
              gstRate: Number(data.gstRate ?? 0),
              totalPaise: Number(data.totalPaise ?? 0),
              status: data.status === 'paid' ? ('paid' as const) : ('unpaid' as const),
              method: typeof data.method === 'string' ? data.method : null,
            };
          }),
        }),
      () => setRead({ uid, rows: 'unreadable' }),
    );
  }, [uid]);

  if (uid === null) return { loading: false, unreadable: false, rows: [], outstandingPaise: 0 };
  if (read === null || read.uid !== uid) return LOADING_DUES;
  if (read.rows === 'unreadable') return UNREADABLE_DUES;
  const rows = read.rows;
  return {
    loading: false,
    unreadable: false,
    rows,
    outstandingPaise: rows.reduce((sum, row) => (row.status === 'unpaid' ? sum + row.totalPaise : sum), 0),
  };
}

/** The sentences a driver reads about their own bill, in their numbers. */
export function describeOutstandingFee(dues: DriverDues): string {
  if (dues.unreadable) return 'Your dues could not be read just now. Pull to try again.';
  if (dues.outstandingPaise === 0) return 'Nothing is owed on your account.';
  const unpaid = dues.rows.filter((row) => row.status === 'unpaid');
  const commissions = unpaid.filter((row) => row.kind === 'commission').length;
  const penalties = unpaid.filter((row) => row.kind === 'late_arrival_penalty').length;
  const onboardingFees = unpaid.filter((row) => row.kind === 'onboarding_fee').length;
  const parts = [
    onboardingFees > 0 ? 'the one-time onboarding fee' : null,
    commissions > 0 ? `commission on ${commissions} trip${commissions === 1 ? '' : 's'}` : null,
    penalties > 0 ? `${penalties} late-arrival ${penalties === 1 ? 'penalty' : 'penalties'}` : null,
  ].filter(Boolean);
  return `${formatINR(dues.outstandingPaise)} is still outstanding — ${parts.join(' and ')}. The office records what you hand over, and new bookings resume the moment nothing is owed.`;
}

/**
 * Everything the driver's own record holds, read live.
 *
 * The Account screen is where this person checks what the business knows about
 * them: the reference they are quoted by, the date the office approved them, the
 * car the customer is told to look for, their rating, and what is owed. It is a
 * listener rather than a one-off read because the review decision and the ledger
 * both land while the app is open, and a driver should not have to reload to see
 * the day's work appear.
 */
export type DriverProfileView = {
  fullName: string;
  phoneE164: string | null;
  /** Minted by the office on approval; null until then. */
  driverId: string | null;
  verificationStatus: VerificationStatus;
  applicationSubmittedAtMs: number | null;
  rejectionReason: string | null;
  verifiedAtMs: number | null;
  languages: string[];
  zoneId: string | null;
  dutyTermsVersion: string | null;
  vehicleMake: string | null;
  vehicleModel: string | null;
  vehiclePlate: string | null;
  /** Storage path of the face the customer is shown, not a URL. */
  photoPath: string | null;
  availabilityState: string;
  ratingAverage: number;
  ratingCount: number;
  lifetimeTrips: number;
  /** Populated by the operations metrics pipeline when there is a measured sample. */
  onTimeArrivalRate: number | null;
  onTimeArrivalCount: number;
  lateArrivalCount: number;
  acceptanceRate: number | null;
  createdAtMs: number | null;
  updatedAtMs: number | null;
};

export type DriverProfileState = {
  loading: boolean;
  /** A refused read is not an empty profile; say which one the screen saw. */
  unreadable: boolean;
  profile: DriverProfileView | null;
};

const LOADING_PROFILE: DriverProfileState = { loading: true, unreadable: false, profile: null };
const UNREADABLE_PROFILE: DriverProfileState = { loading: false, unreadable: true, profile: null };

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function profileView(data: Record<string, unknown>): DriverProfileView {
  return {
    fullName: text(data.fullName) ?? 'Unnamed driver',
    phoneE164: text(data.phoneE164),
    driverId: text(data.driverId),
    verificationStatus:
      (data.verificationStatus as VerificationStatus | undefined) ?? 'not_started',
    applicationSubmittedAtMs: toEpochMs(data.applicationSubmittedAtMs),
    rejectionReason: text(data.rejectionReason),
    verifiedAtMs: toEpochMs(data.verifiedAtMs),
    languages: Array.isArray(data.languages)
      ? data.languages.filter((item): item is string => typeof item === 'string')
      : [],
    zoneId: text(data.zoneId),
    dutyTermsVersion: text(data.dutyTermsVersion),
    vehicleMake: text(data.vehicleMake),
    vehicleModel: text(data.vehicleModel),
    vehiclePlate: text(data.vehiclePlate),
    photoPath: text(data.photoUrl),
    availabilityState: text(data.availabilityState) ?? 'offline',
    ratingAverage: typeof data.ratingAverage === 'number' ? data.ratingAverage : 0,
    ratingCount: count(data.ratingCount),
    lifetimeTrips: count(data.lifetimeTrips),
    onTimeArrivalRate: typeof data.onTimeArrivalRate === 'number' ? data.onTimeArrivalRate : null,
    onTimeArrivalCount: count(data.onTimeArrivalCount),
    lateArrivalCount: count(data.lateArrivalCount),
    acceptanceRate: typeof data.acceptanceRate === 'number' ? data.acceptanceRate : null,
    createdAtMs: toEpochMs(data.createdAtMs),
    updatedAtMs: toEpochMs(data.updatedAtMs),
  };
}

export function useDriverProfile(): DriverProfileState {
  const { user } = useSession();
  const uid = user?.uid ?? null;
  const [read, setRead] = useState<{ uid: string; profile: DriverProfileView | null | 'unreadable' } | null>(
    null,
  );

  useEffect(() => {
    if (uid === null) return;
    return onSnapshot(
      doc(firebase().firestore, COLLECTIONS.driverProfiles, uid),
      (snap) =>
        setRead({
          uid,
          profile: snap.exists() ? profileView(snap.data() as Record<string, unknown>) : null,
        }),
      () => setRead({ uid, profile: 'unreadable' }),
    );
  }, [uid]);

  if (uid === null) return { loading: false, unreadable: false, profile: null };
  if (read === null || read.uid !== uid) return LOADING_PROFILE;
  if (read.profile === 'unreadable') return UNREADABLE_PROFILE;
  return { loading: false, unreadable: false, profile: read.profile };
}

export type DriverProfileEdit = {
  fullName: string;
  vehicleMake: string;
  vehicleModel: string;
  vehiclePlate: string;
  languages: string[];
};

/**
 * The fields a driver may hold about themselves, and nothing else.
 *
 * `driverProfiles` refuses a self-write that touches verification, the rating
 * columns, the trip counters, the driver reference or either timestamp, so this
 * mutation sends only the five keys the update rule leaves open. Notably it does
 * not send `updatedAtMs`: the rule counts a changed key it was told to leave
 * untouched as an attempt to write it.
 *
 * The car is here because of the owner's rule of 2026-10-27 — the customer must
 * be able to find the vehicle. Under "Safar aapka, driver hamara" there is no RC
 * for the driver to upload, so the make, model and plate have to come from the
 * person sitting in it.
 */
export function useUpdateDriverProfile() {
  const { user } = useSession();
  const uid = user?.uid ?? null;

  return useMutation({
    mutationFn: async (input: DriverProfileEdit) => {
      if (uid === null) throw new Error('Sign in again to save this.');
      const fullName = input.fullName.trim();
      if (fullName.length < 2) {
        throw new Error('Your name is what the customer reads on the trip — enter at least two characters.');
      }
      const plate = input.vehiclePlate.trim().toUpperCase().replace(/\s+/g, ' ');
      if (input.vehicleMake.trim().length > 0 && plate.length === 0) {
        throw new Error('A car without a number plate is not findable at a pickup. Add the plate, or leave all three empty.');
      }
      await updateDoc(doc(firebase().firestore, COLLECTIONS.driverProfiles, uid), {
        fullName,
        vehicleMake: input.vehicleMake.trim() || null,
        vehicleModel: input.vehicleModel.trim() || null,
        vehiclePlate: plate || null,
        languages: input.languages,
      });
    },
  });
}


