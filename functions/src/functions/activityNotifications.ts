import { onDocumentCreated, onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { REGION } from '../lib/config';
import { deliverInbox } from '../lib/notify';

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Durable inbox + opted-in device push for the important booking lifecycle. */
export const notifyBookingCreated = onDocumentCreated(
  { region: REGION, document: 'bookings/{bookingId}' },
  async (event) => {
    const booking = event.data?.data();
    const uid = text(booking?.customerUid);
    if (!booking || !uid) return;
    const reference = text(booking.reference) ?? event.params.bookingId;
    await deliverInbox({
      uid,
      id: `booking_confirmed_${event.params.bookingId}`,
      type: 'booking_confirmed',
      title: 'Booking request received',
      body: `Booking ${reference} is being offered to available drivers. We will notify you when a driver accepts.`,
      route: `/trips/${event.params.bookingId}`,
      bookingId: event.params.bookingId,
    });
  },
);

export const notifyBookingStateChanged = onDocumentUpdated(
  { region: REGION, document: 'bookings/{bookingId}' },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!before || !after || before.status === after.status) return;
    const bookingId = event.params.bookingId;
    const status = String(after.status ?? '');
    const reference = text(after.reference) ?? bookingId;
    const customerUid = text(after.customerUid);
    const driverUid = text(after.assignedDriverUid);
    const version = Number(after.stateVersion ?? 0);
    const route = `/trips/${bookingId}`;

    if (customerUid) {
      const driver = after.driver as { fullName?: unknown; phoneE164?: unknown } | null;
      const driverName = text(driver?.fullName);
      const assignedBody = driverName
        ? `${driverName} accepted booking ${reference}${text(driver?.phoneE164) ? ` · call ${text(driver?.phoneE164)}` : ''}. Open your trip to see driver details.`
        : `A driver accepted booking ${reference}. Open your trip to see their details.`;
      const customerMessage: Record<string, { type: 'driver_assigned' | 'trip_started' | 'trip_completed' | 'booking_cancelled' | 'driver_arrived'; title: string; body: string }> = {
        assigned: { type: 'driver_assigned', title: 'Driver assigned', body: assignedBody },
        driver_en_route: { type: 'driver_assigned', title: 'Your driver is on the way', body: `Your driver has started toward pickup for ${reference}.` },
        driver_arrived: { type: 'driver_arrived', title: 'Your driver has arrived', body: `Your driver is at pickup for ${reference}.` },
        trip_started: { type: 'trip_started', title: 'Trip started', body: `Your trip ${reference} is now underway.` },
        completed: { type: 'trip_completed', title: 'Trip completed', body: `Trip ${reference} is complete. Final fare: ₹${(Number(after.finalFare?.totalPaise ?? 0) / 100).toFixed(2)}.` },
        cancelled: { type: 'booking_cancelled', title: 'Booking cancelled', body: `Booking ${reference} was cancelled.` },
      };
      const message = customerMessage[status];
      if (message) await deliverInbox({ uid: customerUid, id: `booking_${status}_${bookingId}_${version}`, ...message, route, bookingId });
    }

    if (driverUid && (status === 'cancelled' || status === 'completed')) {
      await deliverInbox({
        uid: driverUid,
        id: `driver_booking_${status}_${bookingId}_${version}`,
        type: status === 'cancelled' ? 'booking_cancelled' : 'trip_completed',
        title: status === 'cancelled' ? 'Booking cancelled' : 'Trip completed',
        body: status === 'cancelled' ? `Booking ${reference} was cancelled.` : `Trip ${reference} is complete. Your commission is being added to dues.`,
        route: status === 'completed' ? '/dues' : '/',
        bookingId,
      });
    }
  },
);

/** New onboarding/commission dues and their settlement are visible to the driver. */
export const notifyDriverDueCreated = onDocumentCreated(
  { region: REGION, document: 'driverProfiles/{driverUid}/dues/{dueId}' },
  async (event) => {
    const due = event.data?.data();
    if (!due || due.status !== 'unpaid') return;
    const onboarding = due.kind === 'onboarding_fee';
    const amount = (Number(due.totalPaise ?? 0) / 100).toFixed(2);
    await deliverInbox({
      uid: event.params.driverUid,
      id: `due_created_${event.params.dueId}`,
      type: 'payment_update',
      title: onboarding ? 'Onboarding fee ready' : 'Trip commission added',
      body: `${String(due.title ?? 'DrivX charge')}: ₹${amount} is now due.`,
      route: '/dues',
      bookingId: text(due.bookingId),
    });
  },
);

export const notifyDriverDueSettled = onDocumentUpdated(
  { region: REGION, document: 'driverProfiles/{driverUid}/dues/{dueId}' },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!before || !after || before.status === 'paid' || after.status !== 'paid') return;
    await deliverInbox({
      uid: event.params.driverUid,
      id: `due_paid_${event.params.dueId}`,
      type: 'payment_update',
      title: 'Payment successful',
      body: `${String(after.title ?? 'DrivX charge')} · ₹${(Number(after.totalPaise ?? 0) / 100).toFixed(2)} paid${text(after.reference) ? ` · ${text(after.reference)}` : ''}.`,
      route: '/dues',
      bookingId: text(after.bookingId),
    });
  },
);

export const notifyDriverVerification = onDocumentUpdated(
  { region: REGION, document: 'driverProfiles/{driverUid}' },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!before || !after || before.verificationStatus === after.verificationStatus) return;
    const status = String(after.verificationStatus ?? '');
    if (!['pending_review', 'approved', 'rejected'].includes(status)) return;
    const title = status === 'approved' ? 'Driver account approved' : status === 'rejected' ? 'Application needs an update' : 'Application submitted';
    const body = status === 'approved'
      ? `Your DrivX driver profile is approved${text(after.driverId) ? ` · ${text(after.driverId)}` : ''}. You can now go online.`
      : status === 'rejected'
        ? `Please review the Admin note and resubmit your driver documents. ${text(after.rejectionReason) ?? ''}`
        : 'Your paid application and documents are with the Admin team for review.';
    await deliverInbox({
      uid: event.params.driverUid,
      id: `verification_${status}_${event.id}`,
      type: 'verification_update', title, body, route: '/', bookingId: null,
    });
  },
);

