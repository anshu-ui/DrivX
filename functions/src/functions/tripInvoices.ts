import { onDocumentCreated, onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { REGION, RESEND_API_KEY, RESEND_FROM_EMAIL } from '../lib/config';
import { sendTripCompletionInvoices } from '../lib/tripInvoices';

const options = {
  region: REGION,
  document: 'bookings/{bookingId}',
  secrets: [RESEND_API_KEY, RESEND_FROM_EMAIL],
  retry: true,
};

/** Delivers immutable customer and driver PDFs on the first completed transition. */
export const sendTripInvoicesOnCompletion = onDocumentUpdated(options, async (event) => {
  const before = event.data?.before.data();
  const after = event.data?.after.data();
  const bookingId = event.params.bookingId;
  if (!before || !after || !bookingId || before.status === 'completed' || after.status !== 'completed') return;
  await sendTripCompletionInvoices(bookingId, after as Record<string, unknown>);
});

/** Imported completed trips still receive their two invoice records and PDFs. */
export const sendTripInvoicesOnImportedTrip = onDocumentCreated(options, async (event) => {
  const booking = event.data?.data();
  const bookingId = event.params.bookingId;
  if (booking?.status !== 'completed' || !bookingId) return;
  await sendTripCompletionInvoices(bookingId, booking as Record<string, unknown>);
});
