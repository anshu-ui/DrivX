import {
  COLLECTIONS,
  COMMISSION_CONFIG_DOC,
  COMMISSION_TERMS,
  ONBOARDING_FEE,
  SUBCOLLECTIONS,
  commissionDueId,
  commissionSnapshotFor,
  commissionTitleFor,
  commissionRateFrom,
  driverDuePath,
  formatINR,
  readCommissionSnapshot,
  type CommissionSnapshot,
  type DriverDueKind,
  type FareLineItem,
  type MoneyPaise,
} from '@drivx/domain';
import { db, serverTimestamp } from './admin';
import { failedPrecondition } from './errors';

/**
 * Money a driver owes the platform.
 *
 * The owner's rules are two charges and one consequence: a new driver clears a
 * one-time fee before the account can take work, the platform keeps
 * its configured share of every trip fare — 13% unless the office has set
 * another — plus any Admin-configured tax on that share, and a driver with an uncleared row does
 * not receive new bookings. This file is the ledger those three claims are
 * checked against.
 *
 * Two properties matter more than anything else here:
 *
 * - A charge is *created* as unpaid and can only be moved to paid by
 *   `recordDriverDuePayment`, which requires an administrator and writes an
 *   audit entry. Nothing in the driver's own app can flip it, and no code path
 *   pretends a payment happened.
 * - The document id is derived, never generated: `onboarding_fee`, or
 *   `commission_{bookingId}`. So a driver is billed for onboarding exactly once
 *   however many uploads fire around them, and a trip is billed exactly once
 *   however many times its document is rewritten.
 */

/** One charge as the caller described it, before it becomes a document. */
export type NewDriverDue = {
  driverUid: string;
  dueId: string;
  kind: DriverDueKind;
  title: string;
  basePaise: number;
  /** The commission this row was billed at; null on a charge that has no rate. */
  rate: number | null;
  /** The fare the rate was applied to; null on a charge that has no rate. */
  commissionablePaise: number | null;
  gstRate: number;
  gstPaise: number;
  totalPaise: number;
  /** The trip a commission row came from; null for the one-time fee. */
  bookingId: string | null;
};

/**
 * Creates the row unless it is already there.
 *
 * `create` rather than `set`, so two triggers racing on the same booking cannot
 * rewrite an already-paid row back to unpaid.
 */
async function createDue(due: NewDriverDue): Promise<boolean> {
  try {
    await db().doc(driverDuePath(due.driverUid, due.dueId)).create({
      id: due.dueId,
      driverUid: due.driverUid,
      kind: due.kind,
      title: due.title,
      bookingId: due.bookingId,
      currency: 'INR',
      basePaise: due.basePaise,
      rate: due.rate,
      commissionablePaise: due.commissionablePaise,
      gstRate: due.gstRate,
      gstPaise: due.gstPaise,
      totalPaise: due.totalPaise,
      status: 'unpaid',
      method: null,
      reference: null,
      recordedByUid: null,
      recordedAtMs: null,
      createdAtMs: serverTimestamp(),
      updatedAtMs: serverTimestamp(),
    });
  } catch (error) {
    const details = (error as { code?: number; details?: string } | undefined) ?? {};
    if (details.code === 6 || /already exists/i.test(String(details.details ?? ''))) return false;
    throw error;
  }

  console.log(
    JSON.stringify({
      level: 'info',
      fn: 'createDue',
      outcome: 'due_created',
      driverUid: due.driverUid,
      kind: due.kind,
      dueId: due.dueId,
      totalPaise: due.totalPaise,
    }),
  );
  return true;
}

/** New applicants pay the Admin-configured onboarding fee (₹500 + 5% GST by default). */
export async function ensureOnboardingDue(driverUid: string): Promise<boolean> {
  const feeConfig = await db().doc(`${COLLECTIONS.appConfig}/onboardingFee`).get();
  const config = feeConfig.data() ?? {};
  const basePaise = typeof config.basePaise === 'number' && Number.isSafeInteger(config.basePaise) && config.basePaise >= 0
    ? config.basePaise
    : ONBOARDING_FEE.basePaise;
  const gstRate = typeof config.gstRate === 'number' && Number.isFinite(config.gstRate) && config.gstRate >= 0 && config.gstRate <= 1
    ? config.gstRate
    : ONBOARDING_FEE.gstRate;
  const gstPaise = Math.round(basePaise * gstRate);
  const due = {
    driverUid,
    dueId: ONBOARDING_FEE.dueId,
    kind: ONBOARDING_FEE.kind,
    title: ONBOARDING_FEE.title,
    basePaise,
    // A flat fee has no rate and no fare behind it; the row says so rather than
    // borrowing the commission's numbers.
    rate: null,
    commissionablePaise: null,
    gstRate,
    gstPaise,
    totalPaise: basePaise + gstPaise,
    bookingId: null,
  };
  const dueRef = db().doc(driverDuePath(driverUid, ONBOARDING_FEE.dueId));
  const existing = await dueRef.get();
  if (existing.exists) {
    const row = existing.data() ?? {};
    // Refresh an unpaid row before checkout only if no gateway order is open.
    // Once an order exists its amount is a payment snapshot and must not move.
    if (row.status === 'unpaid' && !row.providerOrderId && Number(row.totalPaise) !== due.totalPaise) {
      await dueRef.update({ basePaise, gstRate, gstPaise, totalPaise: due.totalPaise, updatedAtMs: serverTimestamp() });
    }
    return false;
  }
  return createDue(due);
}

/**
 * The cut the office has configured, or the default in `COMMISSION_TERMS`.
 *
 * `appConfig/commission` is a document a person edits, so a missing rate is not
 * an error — it means nobody has set one — and a rate outside 0–1 is refused the
 * same way rather than billing a driver more than the fare was worth.
 */
export async function configuredCommissionTerms(): Promise<{ rate: number; gstRate: number }> {
  const snap = await db()
    .doc(`${COLLECTIONS.appConfig}/${COMMISSION_CONFIG_DOC}`)
    .get();
  const config = snap.data() ?? {};
  return {
    rate: commissionRateFrom(config.rate) ?? COMMISSION_TERMS.rate,
    gstRate: commissionRateFrom(config.gstRate) ?? COMMISSION_TERMS.gstRate,
  };
}

/**
 * A finished trip worth billing, read off the booking document itself.
 *
 * Three things have to be true, and each one refuses a different way of
 * inventing money:
 * - `status: completed` — a cancelled or no-show trip produced no fare.
 * - an assigned driver — nobody earns a share on a trip no one drove.
 * - a server-produced fare — `finalFare` when the trip was finalised, the
 *   estimate only as a fallback, and never a number guessed at here.
 *
 * The *rate* comes from the commission block the booking was created with, so the
 * office changing its cut tomorrow cannot rewrite a trip already driven, and the
 * driver's earnings screen reads the same figures the ledger charges. The
 * *base* comes from the fare the booking carries — the metered receipt when there
 * is one — and is always the commissionable subtotal, never the tax-inclusive
 * total, which would tax the same rupee twice.
 */
export function billableCompletion(
  booking: Record<string, unknown> | null | undefined,
  rate: number = COMMISSION_TERMS.rate,
  gstRate: number = COMMISSION_TERMS.gstRate,
): { driverUid: string; terms: CommissionSnapshot; due: NewDriverDue } | null {
  if (!booking || booking.status !== 'completed') return null;

  const driverUid = booking.assignedDriverUid;
  if (typeof driverUid !== 'string' || driverUid.length === 0) return null;

  const fare = [booking.finalFare, booking.estimate]
    .filter((candidate): candidate is Record<string, unknown> => typeof candidate === 'object' && candidate !== null)
    .find((candidate) => {
      const subtotal = (candidate as { subtotalPaise?: unknown }).subtotalPaise;
      return typeof subtotal === 'number' && Number.isFinite(subtotal) && subtotal > 0;
    });
  if (!fare) return null;

  const bookingId = String(booking.id ?? '');
  if (bookingId.length === 0) return null;

  // The office's *rate* stays the one the quote carried, so a change of mind
  // cannot rewrite a trip already driven. The *base* follows the fare the
  // customer was actually billed: a metered receipt of ₹709.00 is commissioned on
  // ₹709.00, not on the ₹439.00 the map promised before the car moved.
  const pinned = readCommissionSnapshot(booking.commission);
  const terms = commissionSnapshotFor(
    {
      items: Array.isArray(fare.items) ? (fare.items as FareLineItem[]) : [],
      subtotalPaise: fare.subtotalPaise as MoneyPaise,
      taxPaise: typeof fare.taxPaise === 'number' ? (fare.taxPaise as MoneyPaise) : (0 as MoneyPaise),
    },
    pinned?.rate ?? rate,
    pinned?.gstRate ?? gstRate,
  );

  return {
    driverUid,
    terms,
    due: {
      driverUid,
      dueId: commissionDueId(bookingId),
      kind: COMMISSION_TERMS.kind,
      title: commissionTitleFor(String(booking.reference ?? bookingId)),
      basePaise: terms.basePaise,
      rate: terms.rate,
      commissionablePaise: terms.commissionablePaise,
      gstRate: terms.gstRate,
      gstPaise: terms.gstPaise,
      totalPaise: terms.totalPaise,
      bookingId,
    },
  };
}

/**
 * Bills the platform's share of a completed trip.
 *
 * Returns false when the trip was already billed, or when it is not billable —
 * an unassigned or unfared booking is logged rather than charged on a guess.
 *
 * A booking that carries its own commission block is billed from those numbers
 * and the configured rate is only a fallback for one that predates the block, so
 * the office changing the rate cannot rewrite a trip quoted under the old one.
 */
export async function chargeCommissionDue(
  booking: Record<string, unknown> | null | undefined,
): Promise<boolean> {
  const terms = await configuredCommissionTerms();
  const billable = billableCompletion(booking, terms.rate, terms.gstRate);
  if (!billable) {
    console.log(
      JSON.stringify({
        level: 'info',
        fn: 'chargeCommissionDue',
        outcome: 'not_billable',
        bookingId: String(booking?.id ?? 'unknown'),
        status: String(booking?.status ?? 'unknown'),
      }),
    );
    return false;
  }
  return createDue(billable.due);
}

/** Charges this driver has not cleared. Empty once the office records the money. */
export async function outstandingDues(driverUid: string): Promise<Array<Record<string, unknown>>> {
  const snap = await db()
    .collection(COLLECTIONS.driverProfiles)
    .doc(driverUid)
    .collection(SUBCOLLECTIONS.driverDues)
    .get();
  // This is a driver's tiny personal ledger (one onboarding row plus one row
  // per completed trip). Read it by path and filter locally so review/dispatch
  // gates do not depend on a Firestore single-field index finishing its build.
  return snap.docs
    .filter((docSnap) => docSnap.get('status') === 'unpaid')
    .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
}

/** Total rupees owed across the unpaid rows, for the message a reviewer reads. */
export function totalOutstandingPaise(dues: Array<Record<string, unknown>>): number {
  return dues.reduce((sum, due) => sum + Number(due.totalPaise ?? 0), 0);
}

/**
 * What a driver is told when unpaid money blocks their work.
 *
 * Names the kinds rather than only the total, because "₹151.20 of commission for
 * one trip" is collectable at the office and "₹466.20" is not. With one kind
 * owing, the breakdown is the total twice over, so only the breakdown is said.
 */
export function describeOutstanding(dues: Array<Record<string, unknown>>): string {
  const rupees = (rows: Array<Record<string, unknown>>) =>
    formatINR(rows.reduce((sum, due) => sum + Number(due.totalPaise ?? 0), 0));
  const trips = dues.filter((due) => due.kind === 'commission');
  const fees = dues.filter((due) => due.kind !== 'commission');

  const parts = [
    ...(fees.length > 0 ? [`${rupees(fees)} of fees`] : []),
    ...(trips.length > 0
      ? [`${rupees(trips)} of trip commission (${trips.length} ${trips.length === 1 ? 'trip' : 'trips'})`]
      : []),
  ];
  if (parts.length === 1) return `${parts[0]} is uncleared on this account.`;
  return `${rupees(dues)} is uncleared on this account: ${parts.join(' and ')}.`;
}

/**
 * The gate on the driver's own trip-work calls.
 *
 * Dispatch is what enforces "no new bookings" for real once it lands, but every
 * driver-work endpoint already passes through this, so a driver with an unpaid
 * row cannot reach one either. Only the server writes the ledger; the rules let
 * the driver read their own rows, which is what makes the refusal trustworthy.
 */
export async function assertNoOutstandingDues(driverUid: string): Promise<void> {
  const dues = await outstandingDues(driverUid);
  if (dues.length === 0) return;
  throw failedPrecondition(
    `${describeOutstanding(dues)} New bookings are held until the office records it.`,
  );
}
