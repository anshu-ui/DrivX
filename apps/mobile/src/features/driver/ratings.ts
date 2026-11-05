import { useQuery } from '@tanstack/react-query';
import { collection, getDocs, limit, orderBy, query, where } from 'firebase/firestore';
import { COLLECTIONS, type RatingRecord } from '@drivx/domain';
import { toEpochMs } from '@drivx/firebase-client';
import { useSession } from '../auth/AuthProvider';
import { firebase } from '../../lib/firebase';

/**
 * The ratings this driver has been given.
 *
 * Read straight from `ratings` under the list rule a rated person satisfies —
 * own uid in `ratedUid`, ordered by the date the office wrote — and never
 * through a function. The rules close the collection to every client write, so
 * what appears here is exactly what a customer's `rateTrip` call produced: the
 * score, the chips they ticked, and their words.
 *
 * The customer is not named. A driver may read the trip's reference, which is
 * already on their own Duty and Trips screens, but the rules do not give them
 * the customer's profile, and a name typed into this row would be an invention.
 */
export type ReceivedRating = {
  id: string;
  score: number;
  tags: string[];
  comment: string | null;
  bookingId: string;
  bookingReference: string | null;
  atMs: number | null;
};

function asRow(record: RatingRecord): ReceivedRating {
  return {
    id: record.id,
    score: record.score,
    tags: Array.isArray(record.tags) ? record.tags : [],
    comment: typeof record.comment === 'string' && record.comment.length > 0 ? record.comment : null,
    bookingId: record.bookingId,
    bookingReference: typeof record.bookingReference === 'string' ? record.bookingReference : null,
    atMs: toEpochMs(record.createdAtMs),
  };
}

export function useDriverRatings() {
  const { user } = useSession();
  return useQuery<ReceivedRating[]>({
    queryKey: ['driverRatings', user?.uid ?? 'anon'],
    enabled: Boolean(user),
    queryFn: async () => {
      const snap = await getDocs(
        query(
          collection(firebase().firestore, COLLECTIONS.ratings),
          where('ratedUid', '==', user!.uid),
          orderBy('createdAtMs', 'desc'),
          limit(20),
        ),
      );
      return snap.docs.map((docSnap) =>
        asRow({ ...(docSnap.data() as Omit<RatingRecord, 'id'>), id: docSnap.id }),
      );
    },
  });
}
