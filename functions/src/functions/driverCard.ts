import { onDocumentCreated, onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { bookingRefPath, COLLECTIONS, type AssignedDriverCard } from '@drivx/domain';
import { db } from '../lib/admin';
import { REGION } from '../lib/config';
import { deliverInbox } from '../lib/notify';

/**
 * The driver as the customer sees them, published onto the booking at assignment.
 *
 * The owner's rule of 2026-10-27: "jo driver assign hoga uski sab details aaegi…
 * name kya hai uska, number, sab kuch customer ke paas." A customer cannot read
 * `driverProfiles` — that document also holds the Aadhaar pointer, the dues and
 * the availability, none of which belong to a stranger — so the answer is a copy
 * of the part they are owed, written server-side onto the booking they can read.
 *
 * It is a trigger rather than a line inside a callable because *who* assigns a
 * driver changes: dispatch will when Phase 3 lands, an operator does today by
 * writing the booking, and the seed and the verifier both hand trips over
 * directly. Watching `assignedDriverUid` means every one of those publishes the
 * card, and none of them can forget to.
 *
 * Not published, on purpose: the driver's document numbers, their dues, where
 * they live, and anything another customer could use after this trip ends.
 */

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function cardFrom(profile: Record<string, unknown>, uid: string): AssignedDriverCard {
  return {
    uid,
    driverId: text(profile.driverId),
    fullName: text(profile.fullName) ?? 'DrivX driver',
    phoneE164: text(profile.phoneE164) ?? '',
    // `photoUrl` is the `avatars/{uid}/…` copy the driver files with their
    // paperwork. The private review image is never reachable from here.
    photoPath: text(profile.photoUrl),
    ratingAverage: count(profile.ratingAverage),
    ratingCount: count(profile.ratingCount),
    lifetimeTrips: count(profile.lifetimeTrips),
    languages: Array.isArray(profile.languages)
      ? profile.languages.filter((item): item is string => typeof item === 'string')
      : [],
    vehicle: {
      make: text(profile.vehicleMake),
      model: text(profile.vehicleModel),
      plate: text(profile.vehiclePlate),
    },
    publishedAtMs: Date.now(),
  };
}

/** True when this booking already carries a card for the driver it points at. */
function alreadyPublished(booking: Record<string, unknown>, driverUid: string): boolean {
  const card = booking.driver as { uid?: unknown } | null | undefined;
  return card?.uid === driverUid;
}

async function publish(bookingId: string, booking: Record<string, unknown> | undefined): Promise<void> {
  if (!booking) return;
  const driverUid = text(booking.assignedDriverUid);
  if (!driverUid || alreadyPublished(booking, driverUid)) return;

  const profileSnap = await db().doc(`${COLLECTIONS.driverProfiles}/${driverUid}`).get();
  if (!profileSnap.exists) {
    // An assignment pointing at a profile that does not exist is a dispatch bug,
    // and the honest screen for it is "no driver yet", not a made-up name.
    console.warn(JSON.stringify({ level: 'warn', module: 'driverCard', bookingId, driverUid, outcome: 'no_profile' }));
    return;
  }

  const card = cardFrom(profileSnap.data() ?? {}, driverUid);
  await db().doc(bookingRefPath(bookingId)).set({ driver: card }, { merge: true });

  const customerUid = text(booking.customerUid);
  if (!customerUid) return;
  const reference = text(booking.reference) ?? bookingId;
  const car = card.vehicle.plate
    ? `${[card.vehicle.make, card.vehicle.model].filter(Boolean).join(' ')} · ${card.vehicle.plate}`
    : 'Their car details will show on the trip screen.';
  await deliverInbox({
    uid: customerUid,
    id: `driver_${bookingId}`,
    type: 'driver_assigned',
    title: `${card.fullName} is your driver`,
    body:
      `Booking ${reference}. ${card.fullName}` +
      `${card.driverId ? ` (${card.driverId})` : ''} — ${card.phoneE164 || 'no number on file'}. ${car}. ` +
      'Their rating and photo are on the trip screen, and the start code is yours to read out at the car.',
    route: `/trips/${bookingId}`,
    bookingId,
  });

  console.log(JSON.stringify({ level: 'info', module: 'driverCard', bookingId, driverUid, outcome: 'published' }));
}

export const publishDriverCardOnAssignmentEvent = onDocumentUpdated(
  { region: REGION, document: 'bookings/{bookingId}' },
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!after) return;
    const changed = before?.assignedDriverUid !== after.assignedDriverUid;
    // The card itself is written by this function, which re-fires the trigger;
    // only a driver that is not yet on the booking gets a second write.
    if (!changed && alreadyPublished(after, String(after.assignedDriverUid ?? ''))) return;
    await publish(event.params.bookingId, after);
  },
);

/** A booking that arrives with a driver already on it — a seed, an import, a backfill. */
export const publishDriverCardOnImportedBookingEvent = onDocumentCreated(
  { region: REGION, document: 'bookings/{bookingId}' },
  async (event) => {
    await publish(event.params.bookingId, event.data?.data());
  },
);
