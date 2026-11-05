import { onDocumentCreated, onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { REGION } from '../lib/config';
import { chargeCommissionDue } from '../lib/dues';

/**
 * Takes the platform's share of a trip the moment it is recorded as driven.
 *
 * The rule is the office's cut of the commissionable fare — 13% by default, and
 * whatever `appConfig/commission` says — plus any Admin-configured tax on that share, per completed
 * booking. This watches the booking document rather than a particular callable
 * because *who* completes a trip changes: `confirmCompletion` will when the trip
 * lifecycle lands, an operator re-closing a stuck trip might today, and a data
 * import can. Any write that puts `status: completed` on a fare-bearing,
 * assigned booking bills the driver, and nothing else does — the amount comes
 * from the booking's own server-priced fare, never from a client's number.
 *
 * Idempotent by construction: the row's id is `commission_{bookingId}`, so a
 * retried trigger, a redeploy replaying an event, or the same trip written twice
 * all collide on one document instead of billing the driver again.
 */

/** True only when this write is the one that finished the trip. */
function newlyCompleted(before?: Record<string, unknown>, after?: Record<string, unknown>): boolean {
  if (!after || after.status !== 'completed') return false;
  return before?.status !== 'completed';
}

export const chargeCommissionOnCompletion = onDocumentUpdated(
  { region: REGION, document: 'bookings/{bookingId}' },
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!newlyCompleted(before, after)) return;
    await chargeCommissionDue(after);
  },
);

/**
 * A booking that arrives already completed — the seed's finished trips, a
 * backfill, an import from the office register. Without this the update trigger
 * never sees them and the platform quietly works those trips for free.
 */
export const chargeCommissionOnImportedTrip = onDocumentCreated(
  { region: REGION, document: 'bookings/{bookingId}' },
  async (event) => {
    const booking = event.data?.data();
    if (booking?.status !== 'completed') return;
    await chargeCommissionDue(booking);
  },
);
