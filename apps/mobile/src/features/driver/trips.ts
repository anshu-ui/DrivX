import { useQuery } from '@tanstack/react-query';
import { collection, getDocs, limit, orderBy, query, where } from 'firebase/firestore';
import {
  COLLECTIONS,
  driverTripSplitFor,
  readCommissionSnapshot,
  type CommissionSnapshot,
  type DriverTripSplit,
  type FareBreakdown,
  type Place,
} from '@drivx/domain';
import { toEpochMs } from '@drivx/firebase-client';
import { useSession } from '../auth/AuthProvider';
import { firebase } from '../../lib/firebase';
import { fareOf, placeOf } from '../customer/queries';

/**
 * The trips this account drove to the end.
 *
 * Read straight from `bookings` under the list rule a driver satisfies — own uid
 * in `assignedDriverUid`, limit under 50 — and never through a function, so this
 * keeps working on the live project while callables are unreachable. The money
 * comes from the booking's own server-priced `finalFare`; a stored fare a client
 * could edit would be a take-home figure a client could set, and the rules give
 * nobody a write path on this collection.
 */
export type DrivenTrip = {
  id: string;
  reference: string;
  oneWay: boolean;
  kilometres: number | null;
  completedAtMs: number | null;
  /** How the customer settled it, as recorded at the end of the trip. */
  paymentStatus: string;
  split: DriverTripSplit | null;
  /**
   * The route and the two dial readings, so a finished trip can be argued about
   * months later from the driver's own screen. The owner's rule of 2026-10-27:
   * booking id and fare details stay visible to the driver on every surface.
   */
  pickup: Place | null;
  destination: Place | null;
  startOdometerKm: number | null;
  endOdometerKm: number | null;
  /** The terms this trip was actually billed at, from the booking itself. */
  commission: CommissionSnapshot | null;
  /** What the customer was shown before the car moved, for the difference. */
  estimate: FareBreakdown | null;
  finalFare: FareBreakdown | null;
};

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function useDrivenTrips() {
  const { user } = useSession();
  return useQuery<DrivenTrip[]>({
    queryKey: ['drivenTrips', user?.uid ?? 'anon'],
    enabled: Boolean(user),
    queryFn: async () => {
      const snap = await getDocs(
        query(
          collection(firebase().firestore, COLLECTIONS.bookings),
          where('assignedDriverUid', '==', user!.uid),
          where('status', '==', 'completed'),
          orderBy('createdAtMs', 'desc'),
          limit(25),
        ),
      );
      return snap.docs.flatMap((docSnap) => {
        const data = docSnap.data() as Record<string, unknown>;
        const fare = data.finalFare as Record<string, unknown> | undefined;
        // The dial reading wins over the map's guess. A 13 km quote driven as 35
        // km is a 35 km trip on the receipt, and labelling it "13 km" beside a
        // commission taken on 35 km reads like the platform took the wrong cut.
        const metres = Number(data.actualDistanceMeters ?? data.estimatedDistanceMeters ?? 0);
        return [
          {
            id: docSnap.id,
            reference: typeof data.reference === 'string' ? data.reference : docSnap.id,
            oneWay: data.tripDirection === 'one_way',
            kilometres: metres > 0 ? Math.round(metres / 1000) : null,
            completedAtMs: toEpochMs(data.completedAtMs),
            paymentStatus: typeof data.paymentStatus === 'string' ? data.paymentStatus : 'unknown',
            pickup: placeOf(data.pickup),
            destination: placeOf(data.destination),
            startOdometerKm: numberOrNull(data.startOdometerKm),
            endOdometerKm: numberOrNull(data.endOdometerKm),
            commission: readCommissionSnapshot(data.commission),
            estimate: fareOf(data.estimate),
            finalFare: fareOf(data.finalFare),
            // A completed trip with no recorded fare is a booking that was
            // closed without one, and one with no commission block is a booking
            // created before the server captured its terms. Either way there is
            // no honest figure to show, so nothing is invented here.
            split:
              fare && Number.isFinite(Number(fare.totalPaise))
                ? driverTripSplitFor(
                    {
                      subtotalPaise: Number(fare.subtotalPaise ?? 0),
                      taxPaise: Number(fare.taxPaise ?? 0),
                      totalPaise: Number(fare.totalPaise ?? 0),
                    },
                    readCommissionSnapshot(data.commission),
                  )
                : null,
          },
        ];
      });
    },
  });
}
