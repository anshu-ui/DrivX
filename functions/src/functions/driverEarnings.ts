import { driverTripSplitFor, readCommissionSnapshot } from '@drivx/domain';
import type { Caller } from '../lib/guards';
import { db, epochMs } from '../lib/admin';
import { failedPrecondition, parseInput } from '../lib/errors';
import { requireAdminCaller } from '../lib/guards';
import { z } from 'zod';

export type EarningsTotals = { trips: number; pricedTrips: number; grossPaise: number; commissionPaise: number; netPaise: number };
export type DriverEarningsSummary = {
  today: EarningsTotals;
  week: EarningsTotals;
  month: EarningsTotals;
  days: Array<{ date: string; trips: number; grossPaise: number; commissionPaise: number; netPaise: number }>;
  limited: boolean;
};

const blank = (): EarningsTotals => ({ trips: 0, pricedTrips: 0, grossPaise: 0, commissionPaise: 0, netPaise: 0 });
const dateKey = (at: number) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(at);

function istDayStart(at: number): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(at);
  const part = (name: string) => Number(parts.find((row) => row.type === name)?.value ?? 0);
  return Date.UTC(part('year'), part('month') - 1, part('day')) - 330 * 60_000;
}

function addTrip(target: EarningsTotals, split: ReturnType<typeof driverTripSplitFor> | null): void {
  target.trips += 1;
  if (!split) return;
  target.pricedTrips += 1;
  target.grossPaise += split.fareTotalPaise;
  target.commissionPaise += split.commissionPaise;
  target.netPaise += split.netPaise;
}

/** Server-owned aggregate so a driver can see the complete current period, not just the latest screen page. */
export async function getDriverEarningsSummaryForCaller(caller: Caller): Promise<DriverEarningsSummary> {
  const now = Date.now();
  const todayStart = istDayStart(now);
  const currentDate = new Date(todayStart + 330 * 60_000);
  const weekday = (currentDate.getUTCDay() + 6) % 7;
  const weekStart = todayStart - weekday * 86_400_000;
  const monthStart = Date.UTC(currentDate.getUTCFullYear(), currentDate.getUTCMonth(), 1) - 330 * 60_000;
  const historyStart = todayStart - 34 * 86_400_000;
  const days = new Map<string, EarningsTotals>();
  for (let offset = 0; offset < 35; offset += 1) {
    const date = dateKey(historyStart + offset * 86_400_000);
    days.set(date, blank());
  }
  const today = blank();
  const week = blank();
  const month = blank();
  const rows = await db().collection('bookings')
    .where('assignedDriverUid', '==', caller.uid)
    .where('status', '==', 'completed')
    .orderBy('completedAtMs', 'desc')
    .limit(501)
    .get();

  for (const row of rows.docs.slice(0, 500)) {
    const booking = row.data();
    const at = epochMs(booking.completedAtMs);
    const fare = booking.finalFare as Record<string, unknown> | undefined;
    const split = fare && Number.isFinite(Number(fare.totalPaise))
      ? driverTripSplitFor({
          subtotalPaise: Number(fare.subtotalPaise ?? 0),
          taxPaise: Number(fare.taxPaise ?? 0),
          totalPaise: Number(fare.totalPaise ?? 0),
        }, readCommissionSnapshot(booking.commission))
      : null;
    if (at === null) continue;
    const day = days.get(dateKey(at));
    if (day) addTrip(day, split);
    if (at >= todayStart) addTrip(today, split);
    if (at >= weekStart) addTrip(week, split);
    if (at >= monthStart) addTrip(month, split);
  }

  return {
    today, week, month,
    days: [...days.entries()].map(([date, totals]) => ({ date, ...totals })),
    limited: rows.size > 500,
  };
}

export type AdminDriverReport = {
  driver: { uid: string; name: string; driverId: string | null; phone: string | null };
  totals: { bookingCount: number; completedCount: number; cancelledCount: number; grossFarePaise: number; driverNetPaise: number; commissionTotalPaise: number; commissionPaidPaise: number; commissionOutstandingPaise: number };
  limited: boolean;
  bookings: Array<{ id: string; reference: string; status: string; createdAtMs: number | null; completedAtMs: number | null; farePaise: number; fareKind: 'final' | 'estimate' | null; commissionPaise: number | null; commissionStatus: string | null }>;
};

/** Admin drill-down: authoritative booking totals joined to the driver's dues ledger. */
export async function getAdminDriverEarningsReportForCaller(caller: Caller, raw: unknown): Promise<AdminDriverReport> {
  requireAdminCaller(caller);
  const input = parseInput(z.object({ driverUid: z.string().trim().min(1).max(128) }), raw);
  const driverRef = db().doc(`driverProfiles/${input.driverUid}`);
  const driverSnap = await driverRef.get();
  if (!driverSnap.exists) throw failedPrecondition('That driver profile was not found.');
  const profile = driverSnap.data() ?? {};
  const bookingSnap = await db().collection('bookings')
    .where('assignedDriverUid', '==', input.driverUid)
    .orderBy('createdAtMs', 'desc')
    .limit(5001)
    .get();
  const dueSnap = await driverRef.collection('dues').get();
  const commissionByBooking = new Map<string, { totalPaise: number; status: string }>();
  let commissionTotalPaise = 0;
  let commissionPaidPaise = 0;
  let commissionOutstandingPaise = 0;
  for (const due of dueSnap.docs) {
    const row = due.data();
    if (row.kind !== 'commission') continue;
    const amount = Math.max(0, Number(row.totalPaise ?? 0));
    commissionTotalPaise += amount;
    if (row.status === 'paid') commissionPaidPaise += amount;
    else commissionOutstandingPaise += amount;
    if (typeof row.bookingId === 'string') {
      commissionByBooking.set(row.bookingId, { totalPaise: amount, status: String(row.status ?? 'unpaid') });
    }
  }

  const sourceRows = bookingSnap.docs.slice(0, 5000);
  let completedCount = 0;
  let cancelledCount = 0;
  let grossFarePaise = 0;
  let driverNetPaise = 0;
  const bookings = sourceRows.map((row) => {
    const data = row.data();
    const status = String(data.status ?? 'unknown');
    if (status === 'completed') completedCount += 1;
    if (status === 'cancelled') cancelledCount += 1;
    const finalFare = (data.finalFare && typeof data.finalFare === 'object' ? data.finalFare : {}) as Record<string, unknown>;
    const estimate = (data.estimate && typeof data.estimate === 'object' ? data.estimate : {}) as Record<string, unknown>;
    const fareKind = status === 'completed' ? 'final' as const : Number(estimate.totalPaise) > 0 ? 'estimate' as const : null;
    const fareSource = fareKind === 'final' ? finalFare : estimate;
    const farePaise = Math.max(0, Number(fareSource.totalPaise ?? 0));
    if (status === 'completed' && farePaise > 0) {
      grossFarePaise += farePaise;
      const split = driverTripSplitFor({
        subtotalPaise: Number(fareSource.subtotalPaise ?? 0),
        taxPaise: Number(fareSource.taxPaise ?? 0),
        totalPaise: farePaise,
      }, readCommissionSnapshot(data.commission));
      if (split) driverNetPaise += split.netPaise;
    }
    const commission = commissionByBooking.get(row.id);
    return {
      id: row.id,
      reference: typeof data.reference === 'string' ? data.reference : row.id,
      status,
      createdAtMs: epochMs(data.createdAtMs),
      completedAtMs: epochMs(data.completedAtMs),
      farePaise,
      fareKind,
      commissionPaise: commission?.totalPaise ?? null,
      commissionStatus: commission?.status ?? null,
    };
  });

  return {
    driver: {
      uid: input.driverUid,
      name: typeof profile.fullName === 'string' && profile.fullName.trim() ? profile.fullName : 'DrivX driver',
      driverId: typeof profile.driverId === 'string' ? profile.driverId : null,
      phone: typeof profile.phoneE164 === 'string' ? profile.phoneE164 : null,
    },
    totals: {
      bookingCount: bookingSnap.size,
      completedCount,
      cancelledCount,
      grossFarePaise,
      driverNetPaise,
      commissionTotalPaise,
      commissionPaidPaise,
      commissionOutstandingPaise,
    },
    limited: bookingSnap.size > 5000,
    bookings,
  };
}
