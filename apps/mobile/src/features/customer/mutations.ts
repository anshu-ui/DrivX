import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  doc,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import {
  COLLECTIONS,
  SUBCOLLECTIONS,
  cancelBookingInputSchema,
  createBookingInputSchema,
  emailSchema,
  rateTripInputSchema,
  savedPlaceInputSchema,
  supportTicketInputSchema,
  type CancelBookingInput,
  type CancelBookingResult,
  type CreateBookingInput,
  type CreateBookingResult,
  type Place,
  type RateTripInput,
  type SavedPlaceInput,
  type Transmission,
} from '@drivx/domain';
import { FunctionCallError, callFunction } from '@drivx/firebase-client';
import { useSession } from '../auth/AuthProvider';
import { firebase } from '../../lib/firebase';

/**
 * Everything the customer can genuinely ask the backend to do.
 *
 * Bookings, fares, trip states and payment results are Cloud Function
 * territory: a client never writes them, and when the function answers
 * `unimplemented` the UI says so instead of showing a booking that does not
 * exist.
 */

/** Client-side RFC 4122 v4 id, for the booking's idempotency key. */
export function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  const cryptoObj = globalThis.crypto as Crypto | undefined;
  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Calls `createBooking` for real.
 *
 * The fare is not part of this payload and never can be: the server re-measures
 * the route and re-prices it from its own rule, then writes that into the
 * booking. `idempotencyKey` comes from the caller rather than being made here,
 * so a retry of a request that timed out resolves to the booking that already
 * exists instead of a second one.
 */
export function useCreateBooking() {
  const { user } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      pickup: Place;
      destination: Place;
      serviceTypeId: CreateBookingInput['serviceTypeId'];
      tripDirection: CreateBookingInput['tripDirection'];
      preferences: CreateBookingInput['preferences'];
      scheduledForMs: number | null;
      packageTierId: string | null;
      idempotencyKey: string;
      couponCode?: string;
      redeemWalletPaise?: number;
      redeemMilesPoints?: number;
    }) => {
      const payload: CreateBookingInput = {
        ...input,
        packageTierId: input.packageTierId ?? undefined,
        redeemWalletPaise: input.redeemWalletPaise ?? 0,
        redeemMilesPoints: input.redeemMilesPoints ?? 0,
      };
      const parsed = createBookingInputSchema.safeParse(payload);
      if (!parsed.success) {
        return {
          ok: false as const,
          error: new FunctionCallError(
            'invalid-argument',
            parsed.error.issues[0]?.message ?? 'The booking details are incomplete.',
            'createBooking',
          ),
        };
      }
      if (!user) {
        return {
          ok: false as const,
          error: new FunctionCallError('permission-denied', 'Sign in first.', 'createBooking'),
        };
      }

      try {
        const result = await callFunction<CreateBookingInput, CreateBookingResult>(
          firebase(),
          'createBooking',
          parsed.data,
        );
        await queryClient.invalidateQueries({ queryKey: ['bookings', user.uid] });
        return { ok: true as const, result };
      } catch (error) {
        if (error instanceof FunctionCallError) return { ok: false as const, error };
        throw error;
      }
    },
  });
}

/**
 * Calls `cancelBooking` for real — the one destructive thing a customer can do
 * to a trip from the app, which is why it goes through a function instead of a
 * Firestore write. The server decides whether the trip is still cancellable;
 * this screen only reports what it answers.
 */
export function useCancelBooking() {
  const { user } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      bookingId: string;
      reasonCode: CancelBookingInput['reasonCode'];
      reasonText?: string | null;
    }) => {
      const payload: CancelBookingInput = {
        bookingId: input.bookingId,
        reasonCode: input.reasonCode,
        reasonText: input.reasonText ?? null,
      };
      const parsed = cancelBookingInputSchema.safeParse(payload);
      if (!parsed.success) {
        return {
          ok: false as const,
          error: new FunctionCallError(
            'invalid-argument',
            parsed.error.issues[0]?.message ?? 'Pick a reason for the cancellation.',
            'cancelBooking',
          ),
        };
      }
      if (!user) {
        return {
          ok: false as const,
          error: new FunctionCallError('unauthenticated', 'Sign in again to cancel this trip.', 'cancelBooking'),
        };
      }

      try {
        const result = await callFunction<CancelBookingInput, CancelBookingResult>(
          firebase(),
          'cancelBooking',
          parsed.data,
        );
        await queryClient.invalidateQueries({ queryKey: ['bookings', user.uid] });
        // The detail screen reads under its own key, so a cancellation has to be
        // reflected there too or the customer cancels and still sees "on the way".
        await queryClient.invalidateQueries({ queryKey: ['booking'] });
        return { ok: true as const, result };
      } catch (error) {
        if (error instanceof FunctionCallError) return { ok: false as const, error };
        throw error;
      }
    },
  });
}

/** What `rateTrip` answers: the row that now exists, and where it left the driver. */
export type RateTripResult = {
  alreadyRated: boolean;
  ratingId: string;
  /** The trip the score went against, as the function read it off the booking. */
  bookingReference: string | null;
  score: number;
  tags: string[];
  comment: string | null;
  createdAtMs: number | null;
  driverRating?: { ratingAverage: number; ratingCount: number };
  driverName?: string;
};

/**
 * The customer's rating of the driver who just drove them.
 *
 * The schema is parsed here for the same reason the booking form parses its own:
 * so the chip the product has never heard of is refused on the screen rather
 * than after a round trip. None of what happens next is the client's to decide —
 * which driver the score lands on, whether the trip was actually finished, and
 * what the new average is all come back from the function, and `ratings` is
 * closed to client writes by the rules, so a tampered payload has nowhere to go.
 *
 * A second submit is not an error: the function recognises the rating that
 * already exists and answers with it, which is what a double tap needs.
 */
export function useRateDriver() {
  const { user } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: RateTripInput) => {
      const parsed = rateTripInputSchema.safeParse(input);
      if (!parsed.success) {
        return {
          ok: false as const,
          error: new FunctionCallError(
            'invalid-argument',
            parsed.error.issues[0]?.message ?? 'Pick a score from one to five.',
            'rateTrip',
          ),
        };
      }
      if (!user) {
        return {
          ok: false as const,
          error: new FunctionCallError('permission-denied', 'Sign in first.', 'rateTrip'),
        };
      }

      try {
        const result = await callFunction<RateTripInput, RateTripResult>(
          firebase(),
          'rateTrip',
          parsed.data,
        );
        await queryClient.invalidateQueries({ queryKey: ['bookings', user.uid] });
        await queryClient.invalidateQueries({ queryKey: ['booking'] });
        return { ok: true as const, result };
      } catch (error) {
        if (error instanceof FunctionCallError) return { ok: false as const, error };
        throw error;
      }
    },
  });
}

export function useAddSavedPlace() {
  const { user } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: SavedPlaceInput) => {
      const parsed = savedPlaceInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new Error(parsed.error.issues[0]?.message ?? 'Check the place details.');
      }
      if (!user) throw new Error('Sign in first.');
      const id = `${parsed.data.label}-${Date.now().toString(36)}`;
      await setDoc(
        doc(firebase().firestore, COLLECTIONS.savedPlaces, user.uid, SUBCOLLECTIONS.savedPlaces, id),
        {
          id,
          uid: user.uid,
          label: parsed.data.label,
          name: parsed.data.name,
          place: parsed.data.place,
          createdAtMs: serverTimestamp(),
          updatedAtMs: serverTimestamp(),
        },
      );
      await queryClient.invalidateQueries({ queryKey: ['savedPlaces', user.uid] });
      return id;
    },
  });
}

export function useDeleteSavedPlace() {
  const { user } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      if (!user) throw new Error('Sign in first.');
      const { deleteDoc } = await import('firebase/firestore');
      await deleteDoc(
        doc(firebase().firestore, COLLECTIONS.savedPlaces, user.uid, SUBCOLLECTIONS.savedPlaces, id),
      );
      await queryClient.invalidateQueries({ queryKey: ['savedPlaces', user.uid] });
    },
  });
}

export function useUpdateProfile() {
  const { user } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (patch: {
      fullName?: string;
      email?: string;
      preferredTransmission?: Transmission;
      emergencyContactName?: string;
      emergencyContactPhone?: string;
      marketingOptIn?: boolean;
    }) => {
      if (!user) throw new Error('Sign in first.');
      const fullName = patch.fullName?.trim();
      if (fullName !== undefined && fullName.length < 2) throw new Error('Enter your full name.');
      const email = patch.email === undefined ? undefined : emailSchema.safeParse(patch.email);
      if (email !== undefined && !email.success) {
        throw new Error(email.error.issues[0]?.message ?? 'Enter a valid email address.');
      }

      // Server-owned keys (ratingAverage, ratingCount, lifetimeBookings, the
      // timestamps and uid) are never part of this payload; the update rule
      // refuses a write that includes them even unchanged.
      const writes: Record<string, unknown> = {};
      if (fullName) writes.fullName = fullName;
      if (email !== undefined) writes.email = email.data;
      if (patch.preferredTransmission) writes.preferredTransmission = patch.preferredTransmission;
      if (patch.emergencyContactName !== undefined || patch.emergencyContactPhone !== undefined) {
        writes.emergencyContact = {
          name: patch.emergencyContactName?.trim() || null,
          phoneE164: patch.emergencyContactPhone?.trim() || null,
          sharesLiveLocation: false,
        };
      }
      // A dotted path so the write only ever touches privacy.marketingOptIn;
      // preciseLocationWhileIdle stays false, which the data model fixes.
      if (patch.marketingOptIn !== undefined) writes['privacy.marketingOptIn'] = patch.marketingOptIn;
      if (Object.keys(writes).length === 0) return;

      await updateDoc(doc(firebase().firestore, COLLECTIONS.customerProfiles, user.uid), writes);
      await queryClient.invalidateQueries({ queryKey: ['customerProfile', user.uid] });
    },
  });
}

export function useMarkNotificationRead() {
  const { user } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      if (!user) throw new Error('Sign in first.');
      // readAtMs is the only key the notifications rule lets a client change.
      await updateDoc(
        doc(firebase().firestore, COLLECTIONS.users, user.uid, SUBCOLLECTIONS.notifications, id),
        { readAtMs: serverTimestamp() },
      );
      await queryClient.invalidateQueries({ queryKey: ['notifications', user.uid] });
    },
  });
}

export function useCreateTicket() {
  const { user } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      subject: string;
      body: string;
      category: string;
      bookingId?: string | null;
    }) => {
      const parsed = supportTicketInputSchema.safeParse({
        ...input,
        bookingId: input.bookingId ?? null,
      });
      if (!parsed.success) {
        throw new Error(parsed.error.issues[0]?.message ?? 'Check the ticket details.');
      }
      if (!user) throw new Error('Sign in first.');

      const id = `tk-${newIdempotencyKey().slice(0, 8)}`;
      await setDoc(doc(firebase().firestore, COLLECTIONS.supportTickets, id), {
        id,
        openedByUid: user.uid,
        forRole: 'customer',
        bookingId: parsed.data.bookingId ?? null,
        category: parsed.data.category,
        // Escalation is a staff decision, so a customer opens at normal.
        priority: 'normal',
        status: 'open',
        subject: parsed.data.subject,
        body: parsed.data.body,
        assignedAdminUid: null,
        lastCustomerReplyAtMs: null,
        resolvedAtMs: null,
        resolution: null,
        createdAtMs: serverTimestamp(),
        updatedAtMs: serverTimestamp(),
      });
      await queryClient.invalidateQueries({ queryKey: ['supportTickets', user.uid] });
      return id;
    },
  });
}

/**
 * Appends to an open ticket. The rule allows exactly `body`, `subject` and
 * `lastCustomerReplyAtMs` to change, and only while the ticket is not closed —
 * status, priority and assignment belong to staff.
 */
export function useReplyTicket() {
  const { user } = useSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { id: string; body: string }) => {
      if (!user) throw new Error('Sign in first.');
      if (input.body.trim().length < 10) throw new Error('Add a little more detail.');
      await updateDoc(doc(firebase().firestore, COLLECTIONS.supportTickets, input.id), {
        body: input.body.trim(),
        lastCustomerReplyAtMs: serverTimestamp(),
      });
      await queryClient.invalidateQueries({ queryKey: ['supportTickets', user.uid] });
    },
  });
}
